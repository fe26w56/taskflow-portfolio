import type { Actor, Task } from '../contracts/index.ts';
import { Repository, type Statement } from '../storage/d1/index.ts';

export interface WakeEnv {
  AGENT_WAKE_ENABLED?: string;
  AGENT_WAKE_WEBHOOKS?: string;
  AGENT_WAKE_KEY_HEADER?: string;
  AGENT_WAKE_DEDUP_SECONDS?: string;
  AGENT_WAKE_BOT_HOURLY_LIMIT?: string;
  AGENT_WAKE_TIMEOUT_MS?: string;
  TASKFLOW_PUBLIC_URL?: string;
}
type Endpoint = { url: string; headers: Headers };
type Attempt = { id: string; owner_id: string; task_id: string; bot: string; reason: string; disposition: string };
const systemActor: Actor = { kind: 'service', id: 'agent-wake', client_id: 'taskflow:agent-wake' };
const integer = (value: string | undefined, fallback: number, max: number) => {
  const n = value && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(n) && n > 0 && n <= max ? n : fallback;
};
function https(value: unknown): URL | null {
  try {
    if (typeof value !== 'string') return null;
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash ? url : null;
  } catch { return null; }
}
function endpoint(env: WakeEnv, bot: string): Endpoint | null {
  try {
    const header = env.AGENT_WAKE_KEY_HEADER;
    // There is deliberately no guessed Grok header. Keep transport headers intact.
    if (!header || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(header) ||
      /^(content-type|content-length|host|connection|transfer-encoding|cookie|set-cookie|origin|referer)$/i.test(header)) return null;
    const config: unknown = JSON.parse(env.AGENT_WAKE_WEBHOOKS ?? 'null');
    if (!config || typeof config !== 'object' || Array.isArray(config) || !Object.hasOwn(config, bot)) return null;
    const entry = (config as Record<string, unknown>)[bot];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const { url, key } = entry as Record<string, unknown>;
    const target = https(url);
    if (!target || typeof key !== 'string' || !key.trim() || key.length > 4096) return null;
    const headers = new Headers({ 'Content-Type': 'application/json' });
    headers.set(header, key);
    return { url: target.href, headers };
  } catch { return null; }
}
export interface WakePlan { statements: Statement[]; start(): void }
export class AgentWake {
  private repository: Repository;
  private env: WakeEnv;
  private waitUntil: (promise: Promise<unknown>) => void;
  constructor(repository: Repository, env: WakeEnv, waitUntil: (promise: Promise<unknown>) => void) {
    this.repository = repository;
    this.env = env;
    this.waitUntil = waitUntil;
  }
  plan(task: Task, actor: Actor, requestId: string, explicit: boolean): WakePlan | null {
    if (task.executor_kind !== 'agent' || !task.assigned_agent || (task.priority !== 'urgent' && !explicit)) return null;
    const repo = this.repository;
    const id = `wake_${crypto.randomUUID()}`;
    const bot = task.assigned_agent;
    const reason = explicit ? 'wake_now' : 'urgent';
    const now = new Date().toISOString();
    const cutoff = new Date(Date.parse(now) - integer(this.env.AGENT_WAKE_DEDUP_SECONDS, 1800, 604800) * 1000).toISOString();
    const hourly = new Date(Date.parse(now) - 3600000).toISOString();
    const limit = integer(this.env.AGENT_WAKE_BOT_HOURLY_LIMIT, 6, 1000);
    const target = endpoint(this.env, bot);
    const publicUrl = https(this.env.TASKFLOW_PUBLIC_URL);
    const preflight = this.env.AGENT_WAKE_ENABLED !== 'true' ? 'skipped:disabled'
      : !target || !publicUrl ? 'skipped:unconfigured' : null;
    // Decisions and the initial system report share the task's atomic write batch.
    // A single INSERT serializes competing reservations across Worker isolates.
    const statements = [repo.statement(`INSERT INTO v1_agent_wake_attempts
      (id,owner_id,task_id,bot,client_id,request_id,reason,disposition,created_at)
      SELECT ?,?,?,?,?,?,?,CASE
        WHEN ? IS NOT NULL THEN ?
        WHEN EXISTS(SELECT 1 FROM v1_agent_wake_attempts WHERE owner_id=? AND task_id=? AND bot=? AND disposition='queued' AND created_at>?) THEN 'skipped:duplicate'
        WHEN (SELECT count(*) FROM v1_agent_wake_attempts WHERE bot=? AND disposition='queued' AND created_at>?)>=? THEN 'skipped:rate_limited'
        ELSE 'queued' END,?`,
      id, task.owner_id, task.id, bot, actor.client_id, requestId, reason, preflight, preflight,
      task.owner_id, task.id, bot, cutoff, bot, hourly, limit, now),
      repo.statement(`INSERT INTO v1_task_progress
        (id,task_id,owner_id,client_id,request_id,actor,reported_agent,attribution,summary,source_ref,created_at)
        SELECT ?,task_id,owner_id,?,?,?,bot,'system',
          json_object('kind','agent_wake','attempt_id',id,'reason',reason,'outcome',disposition),NULL,created_at
        FROM v1_agent_wake_attempts WHERE id=?`,
      `prg_${crypto.randomUUID()}`, systemActor.client_id, `${id}:decision`, JSON.stringify(systemActor), id),
    ];
    return { statements, start: () => {
      // No caller can inject system reports through the public progress contract.
      // Never expose an exception's message: it may contain a URL, key or response body.
      this.waitUntil(this.deliver(id, task, target, publicUrl).catch(() => {
        console.error('AGENT_WAKE_BACKGROUND_FAILED');
      }));
    } };
  }
  private async deliver(id: string, task: Task, target: Endpoint | null, publicUrl: URL | null) {
    const attempt = await this.repository.statement('SELECT * FROM v1_agent_wake_attempts WHERE id=?', id).first<Attempt>();
    if (!attempt || attempt.disposition !== 'queued' || !target || !publicUrl) return;
    let outcome = 'failed:network';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    try {
      // Race the request as well as aborting it, so timeout bounds even a stuck fetch.
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); },
          integer(this.env.AGENT_WAKE_TIMEOUT_MS, 5000, 15000));
      });
      const payload = {
        task_id: task.id,
        title: Array.from(task.title.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 80).join(''),
        owner_bot: attempt.bot, reason: attempt.reason,
        link: new URL(`/api/v1/tasks/${encodeURIComponent(task.id)}`, publicUrl).href,
      };
      const response = await Promise.race([fetch(target.url, {
        method: 'POST', headers: target.headers, body: JSON.stringify(payload),
        signal: controller.signal, redirect: 'manual',
      }), timeout]);
      outcome = response.ok ? 'sent' : `failed:http:${response.status}`;
      // Do not read or log an untrusted response body. Do not follow credential redirects.
      void response.body?.cancel().catch(() => {});
    } catch {
      outcome = controller.signal.aborted ? 'failed:timeout' : 'failed:network';
    } finally { if (timer !== undefined) clearTimeout(timer); }
    await this.repository.statement(`INSERT INTO v1_task_progress
      (id,task_id,owner_id,client_id,request_id,actor,reported_agent,attribution,summary,source_ref,created_at)
      VALUES(?,?,?,?,?,?,?,'system',?,NULL,?)`,
    `prg_${crypto.randomUUID()}`, attempt.task_id, attempt.owner_id, systemActor.client_id,
    `${id}:result`, JSON.stringify(systemActor), attempt.bot,
    JSON.stringify({ kind: 'agent_wake', attempt_id: id, reason: attempt.reason, outcome }), new Date().toISOString()).run();
  }
}
