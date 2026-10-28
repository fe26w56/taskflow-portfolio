import { resolveActingAgent } from '../auth/agent-identity.ts';
import type { AgentWake } from './wake.ts';
import { RecurrenceService } from '../jobs/recurrence/service.ts';
import { z } from 'zod';
import {
  Actor as ActorSchema,
  inputs,
  Task as TaskSchema,
  Progress as ProgressSchema,
  type Progress,
  type Actor,
  type Task,
  type ErrorCode,
} from '../contracts/index.ts';
import { Repository, encodeCursor, decodeCursor, type Row, type Statement } from '../storage/d1/index.ts';
export class DomainError extends Error {
  code: z.infer<typeof ErrorCode>;
  details?: unknown;
  constructor(
    code: z.infer<typeof ErrorCode>,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export async function hash(value: unknown) {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalJson(value)),
  );
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
export const transitions = {
  complete: ['todo', 'doing', 'waiting'],
  reopen: ['done', 'cancelled'],
  cancel: ['todo', 'doing', 'waiting'],
  skip_occurrence: ['todo', 'doing', 'waiting'],
} as const;
type Write =
  'claim' | 'set_waiting' | 'handoff' | 'create' | 'update' | 'complete' | 'reopen' | 'cancel' | 'skip_occurrence' | 'archive' | 'legacy_update';
const eventTypes = {
  claim: 'updated', set_waiting: 'updated', handoff: 'updated',
  create: 'created',
  update: 'updated',
  complete: 'completed',
  reopen: 'reopened',
  cancel: 'cancelled',
  skip_occurrence: 'occurrence_skipped',
  archive: 'cancelled',
  legacy_update: 'updated',
};
export class TaskService {
  repository: Repository;
  readonly agentWorkEnabled: boolean;
  private wake?: AgentWake;
  private agentIdentityClients?: string;
  constructor(repository: Repository, options: { agentWorkEnabled?: boolean; wake?: AgentWake; agentIdentityClients?: string } = {}) {
    this.repository = repository;
    this.agentIdentityClients = options.agentIdentityClients;
    this.wake = options.wake;
    this.agentWorkEnabled = options.agentWorkEnabled === true;
  }
  private resolveActor(actor: Actor, agent?: string): Actor {
    const resolved = resolveActingAgent(actor, agent, this.agentIdentityClients);
    if (!resolved) throw new DomainError('FORBIDDEN', 'acting_agent is not authorized for this OAuth client');
    return resolved;
  }
  requireAgentWork() {
    if (!this.agentWorkEnabled)
      throw new DomainError('FORBIDDEN', 'AI work writes are disabled');
  }
  claim(owner: string, actor: Actor, input: unknown) { return this.write('claim', owner, actor, input); }
  setWaiting(owner: string, actor: Actor, input: unknown) { return this.write('set_waiting', owner, actor, input); }
  handoff(owner: string, actor: Actor, input: unknown) { return this.write('handoff', owner, actor, input); }

  parse<N extends keyof typeof inputs>(
    name: N,
    input: unknown,
  ): z.output<(typeof inputs)[N]> {
    const r = inputs[name].safeParse(input);
    if (!r.success)
      throw new DomainError(
        'VALIDATION_FAILED',
        'Invalid input',
        r.error.flatten(),
      );
    return r.data as z.output<(typeof inputs)[N]>;
  }
  async listAgentWork(owner: string, input: unknown = {}) {
    const p = this.parse('list_agent_work', input);
    // Return before querying the additive schema while the feature is disabled.
    if (!this.agentWorkEnabled) return { enabled: false, items: [], has_more: false, next_cursor: null };
    try {
      return { enabled: true, ...await this.repository.agentWork(owner, p) };
    } catch (error) {
      if (error instanceof SyntaxError || (error instanceof Error &&
        (error.message === 'INVALID_CURSOR' || error.name === 'InvalidCharacterError')))
        throw new DomainError('VALIDATION_FAILED', 'Invalid cursor');
      throw error;
    }
  }
  async listProgress(owner: string, input: unknown) {
    const p = this.parse('list_progress', input);
    const task = await this.get(owner, { id: p.id });
    if (task.executor_kind !== 'agent') throw new DomainError('INVALID_TRANSITION', 'Requires AI work');
    let cursor: string[] | undefined;
    if (p.cursor) {
      try {
        const value = decodeCursor(p.cursor);
        if (!Array.isArray(value) || value.length !== 2 || !value.every(v => typeof v === 'string')) throw new Error();
        cursor = value;
      } catch { throw new DomainError('VALIDATION_FAILED', 'Invalid cursor'); }
    }
    const rows = (await this.repository.statement(
      `SELECT * FROM v1_task_progress WHERE owner_id=? AND task_id=? ${cursor ? 'AND (created_at,id)>(?,?)' : ''} ORDER BY created_at,id LIMIT ?`,
      owner, p.id, ...(cursor ?? []), p.limit + 1,
    ).all<Row>()).results;
    const page = rows.slice(0, p.limit);
    const last = page.at(-1);
    return { items: page.map(row => ProgressSchema.parse({ ...row, actor: JSON.parse(row.actor as string) })),
      has_more: rows.length > p.limit,
      next_cursor: rows.length > p.limit && last ? encodeCursor([last.created_at, last.id]) : null };
  }
  async logProgress(owner: string, actor: Actor, input: unknown): Promise<Progress> {
    this.requireAgentWork();
    if (!ActorSchema.safeParse(actor).success) throw new DomainError('VALIDATION_FAILED', 'Invalid actor');
    const p = this.parse('log_progress', input);
    actor = this.resolveActor(actor, p.acting_agent);
    if (p.attribution === 'self' && p.reported_agent && p.reported_agent !== (actor.agent ?? actor.client_id))
      throw new DomainError('VALIDATION_FAILED', 'Use attribution=proxy to report another agent');
    const normalized = { ...p, reported_agent: p.reported_agent ?? actor.agent ?? actor.client_id };
    const inputHash = await hash({ op: 'log_progress', input: normalized });
    const repo = this.repository;
    const replay = (op: Awaited<ReturnType<Repository['operation']>>): Progress | null => {
      if (!op) return null;
      if (op.input_hash !== inputHash) throw new DomainError('IDEMPOTENCY_KEY_REUSED', 'request_id already used with another input');
      if (op.status !== 'committed') throw new DomainError('OPERATION_IN_PROGRESS', 'Retry with the same request_id');
      return op.response_json as Progress;
    };
    const previous = replay(await repo.operation(owner, actor.client_id, p.request_id));
    if (previous) return previous;
    const task = await this.get(owner, { id: p.id });
    if (task.executor_kind !== 'agent' || task.series_id || task.archived_at)
      throw new DomainError('INVALID_TRANSITION', 'Requires unarchived one-off AI work');
    const now = new Date().toISOString();
    const progress = ProgressSchema.parse({
      ...normalized, id: `prg_${crypto.randomUUID()}`, task_id: p.id,
      owner_id: owner, client_id: actor.client_id, actor, created_at: now,
    });
    const response = JSON.stringify(progress);
    // Progress is independent of task versions: no task UPDATE or task event.
    try {
      await repo.db.batch([
        repo.statement("INSERT INTO v1_operations(owner_id,client_id,request_id,op,input_hash,status,actor,task_id,created_at) VALUES(?,?,?,'log_progress',?,'pending',?,?,?)",
          owner, actor.client_id, p.request_id, inputHash, JSON.stringify(actor), p.id, now),
        repo.statement('INSERT INTO v1_task_progress(id,task_id,owner_id,client_id,request_id,actor,reported_agent,attribution,summary,source_ref,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
          progress.id, p.id, owner, actor.client_id, p.request_id, JSON.stringify(actor), progress.reported_agent,
          progress.attribution, progress.summary, progress.source_ref, now),
        repo.statement("UPDATE v1_operations SET status='committed',response_json=? WHERE owner_id=? AND client_id=? AND request_id=?",
          response, owner, actor.client_id, p.request_id),
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('UNIQUE') && message.includes('v1_operations')) {
        const result = replay(await repo.operation(owner, actor.client_id, p.request_id));
        if (result) return result;
      }
      if (message.includes('AI_PROGRESS_TARGET_INVALID'))
        throw new DomainError('INVALID_TRANSITION', 'Requires unarchived one-off AI work');
      throw error;
    }
    return progress;
  }
  async get(owner: string, input: unknown) {
    const p = this.parse('get', input);
    const task = await this.repository.task(owner, p.id);
    if (!task) throw new DomainError('NOT_FOUND', 'Task not found');
    return task;
  }
  async list(owner: string, input: unknown = {}) {
    const p = this.parse('list', input);
    try {
      return await this.repository.list(owner, p);
    } catch (e) {
      if (
        (e instanceof Error &&
          (e.message === 'INVALID_CURSOR' ||
            e.name === 'InvalidCharacterError')) ||
        e instanceof SyntaxError
      )
        throw new DomainError('VALIDATION_FAILED', 'Invalid cursor');
      throw e;
    }
  }
  // Internal web compatibility reads; public v1 pagination remains unchanged.
  listLegacyTasks(owner: string) { return this.repository.legacyTasks(owner); }
  seriesTasks(owner: string, ids: string[]) { return this.repository.seriesTasks(owner, ids); }
  projectTasks(owner: string, area: string, project: string) { return this.repository.projectTasks(owner, area, project); }
  async get_changes(owner: string, input: unknown = {}) {
    const p = this.parse('get_changes', input);
    try {
      return await this.repository.changes(owner, p.since, p.limit);
    } catch (e) {
      if (
        (e instanceof Error &&
          (e.message === 'INVALID_CURSOR' ||
            e.name === 'InvalidCharacterError')) ||
        e instanceof SyntaxError
      )
        throw new DomainError('VALIDATION_FAILED', 'Invalid cursor');
      throw e;
    }
  }
  async get_operation(owner: string, actor: Actor, input: unknown) {
    const p = this.parse('get_operation', input);
    const op = await this.repository.operation(
      owner,
      actor.client_id,
      p.request_id,
    );
    if (!op) throw new DomainError('NOT_FOUND', 'Operation not found');
    return op;
  }
  create(owner: string, actor: Actor, input: unknown) {
    return this.write('create', owner, actor, input);
  }
  update(owner: string, actor: Actor, input: unknown) {
    return this.write('update', owner, actor, input);
  }
  complete(owner: string, actor: Actor, input: unknown) {
    return this.write('complete', owner, actor, input);
  }
  reopen(owner: string, actor: Actor, input: unknown) {
    return this.write('reopen', owner, actor, input);
  }
  cancel(owner: string, actor: Actor, input: unknown) {
    return this.write('cancel', owner, actor, input);
  }
  skip_occurrence(owner: string, actor: Actor, input: unknown) {
    return this.write('skip_occurrence', owner, actor, input);
  }
  /** Compatibility operations: preserve terminal edits; deletion is cancellation + archive. */
  archive(owner: string, actor: Actor, input: unknown) {
    return this.write('archive', owner, actor, input);
  }
  editLegacy(owner: string, actor: Actor, input: unknown) {
    return this.write('legacy_update', owner, actor, input);
  }
  list_recurrence_rules(owner: string, input: unknown = {}) {
    return new RecurrenceService(this.repository).list(owner, input);
  }
  get_recurrence_rule(owner: string, input: unknown) {
    return new RecurrenceService(this.repository).get(owner, input);
  }
  create_recurrence_rule(owner: string, actor: Actor, input: unknown) {
    return new RecurrenceService(this.repository).write(
      'create_recurrence_rule',
      owner,
      actor,
      input,
    );
  }
  update_recurrence_rule(owner: string, actor: Actor, input: unknown) {
    return new RecurrenceService(this.repository).write(
      'update_recurrence_rule',
      owner,
      actor,
      input,
    );
  }
  delete_recurrence_rule(owner: string, actor: Actor, input: unknown) {
    return new RecurrenceService(this.repository).write(
      'delete_recurrence_rule',
      owner,
      actor,
      input,
    );
  }
  private async write(
    name: Write,
    owner: string,
    actor: Actor,
    raw: unknown,
  ): Promise<Task> {
    const actorResult = ActorSchema.safeParse(actor);
    if (!actorResult.success)
      throw new DomainError('VALIDATION_FAILED', 'Invalid actor');
    // Hash normalized validated input. Patch schemas deliberately have no defaults.
    const p = this.parse(name === 'archive' ? 'cancel' : name === 'legacy_update' ? 'update' : name, raw) as {
      request_id: string;
      acting_agent?: string;
      wake_now?: boolean;
      id?: string;
      expected_version?: number;
      task?: Record<string, unknown>;
      patch?: Record<string, unknown>;
      evidence?: Task['completion_evidence'];
      reason?: string;
      assigned_agent?: string;
      waiting_kind?: Task['waiting_kind']; waiting_on_ref?: string; blocker_summary?: string;
      next_check_at?: string | null; next_check_by?: string;
    };
    actor = this.resolveActor(actor, p.acting_agent);
    if (name === 'claim' && p.acting_agent) {
      if (p.assigned_agent && p.assigned_agent !== p.acting_agent)
        throw new DomainError('VALIDATION_FAILED', 'Claim assigned_agent must match acting_agent');
      p.assigned_agent = p.acting_agent;
    }
    if (['claim', 'set_waiting', 'handoff'].includes(name)) this.requireAgentWork();
    const inputHash = await hash({ op: name, input: p });
    const repo = this.repository;
    const replay = (
      op: Awaited<ReturnType<Repository['operation']>>,
    ): Task | null => {
      if (!op) return null;
      if (op.input_hash !== inputHash)
        throw new DomainError(
          'IDEMPOTENCY_KEY_REUSED',
          'request_id already used with another input',
        );
      if (op.status === 'committed') return op.response_json as Task;
      throw new DomainError(
        'OPERATION_IN_PROGRESS',
        'Operation has not committed; retry with the same request_id',
      );
    };
    const previous = replay(
      await repo.operation(owner, actor.client_id, p.request_id),
    );
    if (previous) return previous;
    const now = new Date().toISOString();
    const id = p.id ?? `tsk_${crypto.randomUUID()}`;
    let task: Task;
    if (name === 'create') {
      const { checklist, ...fields } = p.task!;
      if (fields.executor_kind === 'agent') {
        this.requireAgentWork();
        if (fields.status !== 'todo') throw new DomainError('INVALID_TRANSITION', 'Create AI work as todo, then claim it');
      } else if (fields.assigned_agent || fields.requester_ref) {
        throw new DomainError('VALIDATION_FAILED', 'AI metadata requires executor_kind=agent');
      }
      task = {
        ...fields,
        id,
        owner_id: owner,
        version: 1,
        completed_at: null,
        completion_evidence: null,
        cancel_reason: null,
        series_id: null,
        occurrence_key: null,
        legacy_issue_number: null,
        created_at: now,
        updated_at: now,
        archived_at: null,
        checklist: [],
      } as unknown as Task;
    } else {
      task = await this.get(owner, { id });
      if (task.version !== p.expected_version)
        throw new DomainError('VERSION_CONFLICT', 'Stale task version', {
          current_version: task.version,
        });
      if (task.executor_kind === 'agent') this.requireAgentWork();
      if (task.executor_kind === 'self' && p.patch?.requester_ref)
        throw new DomainError('VALIDATION_FAILED', 'AI metadata requires executor_kind=agent');
      if (p.patch?.executor_kind && p.patch.executor_kind !== task.executor_kind)
        throw new DomainError('INVALID_TRANSITION', 'executor_kind cannot be changed');
      if (task.executor_kind === 'agent' && p.patch && ('status' in p.patch))
        throw new DomainError('INVALID_TRANSITION', 'Use dedicated AI work state operations');
      if (name === 'claim' || name === 'set_waiting' || name === 'handoff') {
        if (task.executor_kind !== 'agent' || task.series_id || task.archived_at || ['done', 'cancelled'].includes(task.status))
          throw new DomainError('INVALID_TRANSITION', 'Requires active one-off AI work');
        if (name === 'claim') {
          if ((task.accepted_at && task.status !== 'waiting') || (task.assigned_agent && task.assigned_agent !== p.assigned_agent))
            throw new DomainError('INVALID_TRANSITION', 'Task already accepted or assigned to another agent');
          task = { ...task, assigned_agent: p.assigned_agent!, accepted_at: task.accepted_at ?? now, status: 'doing',
            waiting_kind: null, waiting_on_ref: null, blocker_summary: null, next_check_at: null, next_check_by: null };
        } else if (name === 'set_waiting') {
          if (!task.accepted_at) throw new DomainError('INVALID_TRANSITION', 'Claim before waiting');
          task = { ...task, status: 'waiting', waiting_kind: p.waiting_kind!, waiting_on_ref: p.waiting_on_ref!,
            blocker_summary: p.blocker_summary!, next_check_at: p.next_check_at!, next_check_by: p.next_check_by! };
        } else {
          if (task.assigned_agent === p.assigned_agent)
            throw new DomainError('INVALID_TRANSITION', 'Handoff requires a different agent');
          task = { ...task, status: 'todo', assigned_agent: p.assigned_agent!, accepted_at: null,
            waiting_kind: null, waiting_on_ref: null, blocker_summary: null,
            next_check_at: p.next_check_at!, next_check_by: p.next_check_by! };
        }
      } else if (name === 'update' || name === 'legacy_update') {
        if (name === 'update' && ['done', 'cancelled'].includes(task.status))
          throw new DomainError(
            'INVALID_TRANSITION',
            'Reopen before updating a terminal task',
          );
        task = { ...task, ...p.patch } as Task;
      } else if (name === 'archive') {
        task = { ...task, status: 'cancelled', cancel_reason: p.reason!, archived_at: now };
      } else {
        if (!(transitions[name] as readonly string[]).includes(task.status))
          throw new DomainError(
            'INVALID_TRANSITION',
            `Cannot ${name} ${task.status}`,
          );
        if (name === 'skip_occurrence' && !task.series_id)
          throw new DomainError(
            'INVALID_TRANSITION',
            'Only occurrences may be skipped',
          );
        if (name === 'complete')
          task = {
            ...task,
            status: 'done',
            completed_at: now,
            completion_evidence: p.evidence!,
          };
        if (name === 'reopen')
          task = {
            ...task,
            status: 'todo',
            completed_at: null,
            completion_evidence: null,
            cancel_reason: null,
          };
        if (name === 'cancel' || name === 'skip_occurrence')
          task = {
            ...task,
            status: 'cancelled',
            cancel_reason:
              name === 'skip_occurrence' ? `skipped:${p.reason}` : p.reason!,
          };
      }
      if (['complete', 'cancel', 'skip_occurrence', 'archive', 'reopen'].includes(name)) {
        task = { ...task, waiting_kind: null, waiting_on_ref: null, blocker_summary: null, next_check_at: null, next_check_by: null,
          ...(name === 'reopen' ? { accepted_at: null } : {}) };
      }
      task.version = p.expected_version! + 1;
      task.updated_at = now;
    }
    const checklistInput =
      name === 'create' ? p.task!.checklist : p.patch?.checklist;
    if (checklistInput)
      task.checklist = (
        checklistInput as {
          text: string;
          done: boolean;
        }[]
      ).map((c, position) => ({
        id: `chk_${crypto.randomUUID()}`,
        position,
        text: c.text,
        done: c.done,
        done_at: c.done ? now : null,
      }));
    const valid = TaskSchema.safeParse(task);
    if (!valid.success)
      throw new DomainError(
        'VALIDATION_FAILED',
        'Invalid task',
        valid.error.flatten(),
      );
    task = valid.data;
    const response = JSON.stringify(task);
    const statements: Statement[] = [
      repo.statement(
        "INSERT INTO v1_operations(owner_id,client_id,request_id,op,input_hash,status,actor,task_id,created_at) VALUES(?,?,?,?,?,'pending',?,?,?)",
        owner,
        actor.client_id,
        p.request_id,
        name,
        inputHash,
        JSON.stringify(actor),
        id,
        now,
      ),
    ];
    const { checklist, ...fields } = task;
    const columns = Object.keys(fields);
    const values = Object.entries(fields).map(([key, v]) =>
      key === 'context_refs' || (key === 'completion_evidence' && v !== null)
        ? JSON.stringify(v)
        : v,
    );
    if (name === 'create')
      statements.push(
        repo.statement(
          `INSERT INTO v1_tasks(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
          ...values,
        ),
      );
    else
      statements.push(
        repo.statement(
          `UPDATE v1_tasks SET ${columns.map((c) => `${c}=?`).join(',')} WHERE id=? AND owner_id=?`,
          ...values,
          id,
          owner,
        ),
      );
    if (checklistInput) {
      statements.push(
        repo.statement(
          'DELETE FROM v1_task_checklist_items WHERE task_id=?',
          id,
        ),
      );
      for (const c of checklist)
        statements.push(
          repo.statement(
            'INSERT INTO v1_task_checklist_items(id,task_id,position,text,done,done_at) VALUES(?,?,?,?,?,?)',
            c.id,
            id,
            c.position,
            c.text,
            Number(c.done),
            c.done_at,
          ),
        );
    }
    statements.push(
      repo.statement(
        'INSERT INTO v1_task_events(task_id,owner_id,operation_request_id,type,actor,task_version,payload,created_at) VALUES(?,?,?,?,?,?,?,?)',
        id,
        owner,
        p.request_id,
        eventTypes[name],
        JSON.stringify(actor),
        task.version,
        JSON.stringify({ ...task, ...(['claim', 'set_waiting', 'handoff'].includes(name) ? { agent_work: { operation: name, reason: p.reason ?? null } } : {}) }),
        now,
      ),
    );
    statements.push(
      repo.statement(
        "UPDATE v1_operations SET status='committed',response_json=? WHERE owner_id=? AND client_id=? AND request_id=?",
        response,
        owner,
        actor.client_id,
        p.request_id,
      ),
    );
    const wake = (name === 'create' || name === 'handoff')
      ? this.wake?.plan(task, actor, p.request_id, p.wake_now === true) : null;
    if (wake) statements.push(...wake.statements);
    try {
      await repo.db.batch(statements);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.includes('UNIQUE') && message.includes('v1_operations')) {
        const result = replay(
          await repo.operation(owner, actor.client_id, p.request_id),
        );
        if (result) return result;
      }
      if (message.includes('VERSION_CONFLICT'))
        throw new DomainError('VERSION_CONFLICT', 'Stale task version', {
          current_version: (await repo.task(owner, id))?.version,
        });
      throw e;
    }
    repo.recordTask(task);
    wake?.start();
    return task;
  }
}
