import { z } from 'zod';
import {
  Actor,
  inputs,
  TaskFields,
  RuleFields,
  type RecurrenceRule,
  type Task,
} from '../../contracts/index.ts';
import {
  Repository,
  encodeCursor,
  decodeCursor,
  type Row,
  type Statement,
} from '../../storage/d1/index.ts';
import { DomainError, hash } from '../../tasks/index.ts';
import {
  localDate,
  occurrenceDates,
  occurrenceId,
  plannedStartAt,
} from './index.ts';
type Write =
  | 'create_recurrence_rule'
  | 'update_recurrence_rule'
  | 'delete_recurrence_rule';
function ruleRow(row: Row): RecurrenceRule {
  const { template_json, weekdays, month_day, ...rest } = row;
  return {
    ...rest,
    template: JSON.parse(template_json as string),
    ...(weekdays ? { weekdays: JSON.parse(weekdays as string) } : {}),
    ...(month_day ? { month_day } : {}),
  } as RecurrenceRule;
}
export class RecurrenceService {
  repo: Repository;
  constructor(repo: Repository) {
    this.repo = repo;
  }
  parse<N extends keyof typeof inputs>(
    name: N,
    input: unknown,
  ): z.output<(typeof inputs)[N]> {
    const p = inputs[name].safeParse(input);
    if (!p.success)
      throw new DomainError(
        'VALIDATION_FAILED',
        'Invalid input',
        p.error.flatten(),
      );
    return p.data as z.output<(typeof inputs)[N]>;
  }
  async get(owner: string, input: unknown): Promise<RecurrenceRule> {
    const p = this.parse('get_recurrence_rule', input);
    const row = await this.repo
      .statement(
        'SELECT * FROM v1_recurrence_rules WHERE owner_id=? AND id=?',
        owner,
        p.id,
      )
      .first<Row>();
    if (!row) throw new DomainError('NOT_FOUND', 'Rule not found');
    return ruleRow(row);
  }
  async list(owner: string, input: unknown) {
    const p = this.parse('list_recurrence_rules', input);
    const args: unknown[] = [owner];
    let where = 'owner_id=?';
    if (p.status) {
      where += ' AND status=?';
      args.push(p.status);
    }
    if (p.cursor) {
      let c;
      try {
        c = decodeCursor(p.cursor);
      } catch {
        throw new DomainError('VALIDATION_FAILED', 'Invalid cursor');
      }
      if (
        !Array.isArray(c) ||
        c.length !== 2 ||
        !c.every((v) => typeof v === 'string')
      )
        throw new DomainError('VALIDATION_FAILED', 'Invalid cursor');
      where += ' AND (created_at,id)>(?,?)';
      args.push(...c);
    }
    const rows = (
      await this.repo
        .statement(
          `SELECT * FROM v1_recurrence_rules WHERE ${where} ORDER BY created_at,id LIMIT ?`,
          ...args,
          p.limit + 1,
        )
        .all<Row>()
    ).results;
    const items = rows.slice(0, p.limit).map(ruleRow);
    const last = items.at(-1);
    return {
      items,
      has_more: rows.length > p.limit,
      next_cursor:
        rows.length > p.limit && last
          ? encodeCursor([last.created_at, last.id])
          : null,
      coverage_incomplete: false,
    };
  }
  insert(rule: RecurrenceRule): Statement {
    return this.repo.statement(
      'INSERT INTO v1_recurrence_rules(id,owner_id,version,template_json,kind,weekdays,month_day,starts_on,ends_on,timezone,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
      rule.id,
      rule.owner_id,
      rule.version,
      JSON.stringify(rule.template),
      rule.kind,
      rule.weekdays ? JSON.stringify(rule.weekdays) : null,
      rule.month_day ?? null,
      rule.starts_on,
      rule.ends_on,
      rule.timezone,
      rule.status,
      rule.created_at,
      rule.updated_at,
    );
  }
  async generate(rule: RecurrenceRule, now: Date, dates = occurrenceDates(rule, now)): Promise<Statement[]> {
    if (rule.template.executor_kind === 'agent') return [];
    const statements: Statement[] = [];
    const repo = this.repo;
    for (const date of dates) {
      const id = await occurrenceId(rule.id, date);
      const operationRequestId = `recurrence:${rule.id}:${date}`;
      const stamp = now.toISOString();
      if (
        await repo
          .statement(
            'SELECT id FROM v1_tasks WHERE series_id=? AND occurrence_key=?',
            rule.id,
            date,
          )
          .first()
      )
        continue;
      const fields = {
        ...TaskFields.parse(rule.template),
        id,
        owner_id: rule.owner_id,
        version: 1,
        timezone: rule.timezone,
        deadline_date: date,
        planned_start_at: plannedStartAt(
          date,
          rule.template.start_time,
          rule.timezone,
        ),
        series_id: rule.id,
        occurrence_key: date,
        created_at: stamp,
        updated_at: stamp,
      };
      repo.recordTask({ ...fields, completed_at: null, completion_evidence: null, cancel_reason: null,
        legacy_issue_number: null, archived_at: null,
        checklist: rule.template.checklist.map((c, position) => ({ ...c, id: `${id}:${position}`, position, done_at: c.done ? stamp : null })),
      } as Task);
      const keys = Object.keys(fields);
      const values = Object.entries(fields).map(([k, v]) =>
        k === 'context_refs' ? JSON.stringify(v) : v,
      );
      // The active/version guard prevents a cron snapshot from generating after a concurrent end.
      statements.push(
        repo.statement(
          `INSERT INTO v1_tasks(${keys.join(',')}) SELECT ${keys.map(() => '?').join(',')} WHERE EXISTS(SELECT 1 FROM v1_recurrence_rules WHERE id=? AND status='active' AND version=?) ON CONFLICT(series_id,occurrence_key) DO NOTHING`,
          ...values,
          rule.id,
          rule.version,
        ),
      );
      for (const [position, c] of rule.template.checklist.entries())
        statements.push(
          repo.statement(
            "INSERT INTO v1_task_checklist_items(id,task_id,position,text,done,done_at) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM v1_tasks WHERE id=?) AND NOT EXISTS(SELECT 1 FROM v1_task_events WHERE task_id=? AND type='created') ON CONFLICT DO NOTHING",
            `${id}:${position}`,
            id,
            position,
            c.text,
            Number(c.done),
            c.done ? stamp : null,
            id,
            id,
          ),
        );
      statements.push(
        repo.statement(
          "INSERT INTO v1_task_events(task_id,owner_id,operation_request_id,type,actor,task_version,payload,created_at) SELECT ?,?,?,'created',?,1,?,? WHERE EXISTS(SELECT 1 FROM v1_tasks WHERE id=?) AND NOT EXISTS(SELECT 1 FROM v1_task_events WHERE task_id=? AND type='created')",
          id,
          rule.owner_id,
          operationRequestId,
          JSON.stringify({
            kind: 'service',
            id: 'recurrence',
            client_id: 'recurrence',
          }),
          JSON.stringify({ series_id: rule.id, occurrence_key: date }),
          stamp,
          id,
          id,
        ),
      );
    }
    return statements;
  }
  /** Section metadata rename does not replace a recurrence schedule. */
  async renameProject(owner: string, actor: Actor, request: string, area: string, oldName: string, newName: string | null): Promise<Statement[]> {
    const rows = (await this.repo.statement("SELECT * FROM v1_recurrence_rules WHERE owner_id=? AND COALESCE(json_extract(template_json,'$.executor_kind'),'self')='self' AND json_extract(template_json,'$.area')=? AND json_extract(template_json,'$.project_key')=?", owner, area, oldName).all<Row>()).results;
    const statements: Statement[] = [], stamp = new Date().toISOString();
    for (const row of rows) {
      const rule = ruleRow(row);
      rule.template.project_key = newName;
      rule.version += 1; rule.updated_at = stamp;
      statements.push(this.repo.statement('UPDATE v1_recurrence_rules SET template_json=?,version=?,updated_at=? WHERE owner_id=? AND id=?', JSON.stringify(rule.template), rule.version, stamp, owner, rule.id));
      statements.push(this.repo.statement('INSERT INTO v1_recurrence_events(rule_id,owner_id,operation_request_id,actor,payload,created_at) VALUES(?,?,?,?,?,?)', rule.id, owner, request, JSON.stringify(actor), JSON.stringify(rule), stamp));
    }
    return statements;
  }
  async write(
    name: Write,
    owner: string,
    actor: Actor,
    raw: unknown,
  ): Promise<unknown> {
    if (!Actor.safeParse(actor).success)
      throw new DomainError('VALIDATION_FAILED', 'Invalid actor');
    const p = this.parse(name, raw) as {
      request_id: string;
      id?: string;
      expected_version?: number;
      rule?: z.output<typeof RuleFields>;
    };
    if (p.rule?.template.executor_kind === 'agent')
      throw new DomainError('FORBIDDEN', 'AI recurrence is outside the one-off trial');
    const repo = this.repo,
      inputHash = await hash({ op: name, input: p });
    const replay = (op: Awaited<ReturnType<Repository['operation']>>) => {
      if (!op) return null;
      if (op.input_hash !== inputHash)
        throw new DomainError(
          'IDEMPOTENCY_KEY_REUSED',
          'request_id already used',
        );
      if (op.status !== 'committed')
        throw new DomainError('OPERATION_IN_PROGRESS', 'Retry same request_id');
      return op.response_json;
    };
    const previous = replay(
      await repo.operation(owner, actor.client_id, p.request_id),
    );
    if (previous) return previous;
    const now = new Date(),
      stamp = now.toISOString();
    const statements = [
      repo.statement(
        "INSERT INTO v1_operations(owner_id,client_id,request_id,op,input_hash,status,actor,created_at) VALUES(?,?,?,?,?,'pending',?,?)",
        owner,
        actor.client_id,
        p.request_id,
        name,
        inputHash,
        JSON.stringify(actor),
        stamp,
      ),
    ];
    let old: RecurrenceRule | undefined;
    let rule: RecurrenceRule;
    if (name !== 'create_recurrence_rule') {
      old = await this.get(owner, { id: p.id });
      if (old.version !== p.expected_version)
        throw new DomainError('VERSION_CONFLICT', 'Stale rule version', {
          current_version: old.version,
        });
      if (old.status !== 'active')
        throw new DomainError('INVALID_TRANSITION', 'Rule already ended');
      old = {
        ...old,
        status: 'ended',
        version: p.expected_version! + 1,
        updated_at: stamp,
      };
      statements.push(
        repo.statement(
          "UPDATE v1_recurrence_rules SET status='ended',version=?,updated_at=? WHERE owner_id=? AND id=?",
          old.version,
          stamp,
          owner,
          old.id,
        ),
      );
      // Evaluate eligibility inside the batch, including occurrences created by a
      // concurrent cron before this batch acquires the database write lock.
      const eligible =
        "owner_id=? AND series_id=? AND status='todo' AND occurrence_key>? AND (planned_start_at IS NULL OR julianday(planned_start_at)>julianday(?))";
      const args = [owner, old.id, localDate(now, old.timezone), stamp];
      const reason =
        name === 'update_recurrence_rule'
          ? 'skipped:rule-updated'
          : 'skipped:rule-ended';
      statements.push(
        repo.statement(
          `UPDATE v1_tasks SET status='cancelled',cancel_reason=?,version=version+1,updated_at=? WHERE ${eligible}`,
          reason,
          stamp,
          ...args,
        ),
      );
      statements.push(
        repo.statement(
          `INSERT INTO v1_task_events(task_id,owner_id,operation_request_id,type,actor,task_version,payload,created_at) SELECT id,owner_id,?,'cancelled',?,version,?,? FROM v1_tasks WHERE owner_id=? AND series_id=? AND status='cancelled' AND cancel_reason=? AND updated_at=? AND NOT EXISTS(SELECT 1 FROM v1_task_events e WHERE e.task_id=v1_tasks.id AND e.task_version=v1_tasks.version)`,
          p.request_id,
          JSON.stringify(actor),
          JSON.stringify({ reason }),
          stamp,
          owner,
          old.id,
          reason,
          stamp,
        ),
      );
    }
    if (name === 'delete_recurrence_rule') rule = old!;
    else {
      rule = {
        ...p.rule!,
        id: `rr_${crypto.randomUUID()}`,
        owner_id: owner,
        version: 1,
        status: 'active',
        created_at: stamp,
        updated_at: stamp,
      };
      statements.push(this.insert(rule));
      statements.push(...(await this.generate(rule, now)));
    }
    const response =
      name === 'update_recurrence_rule' ? { previous_rule: old, rule } : rule;
    for (const r of old && old.id !== rule.id ? [old, rule] : [rule])
      statements.push(
        repo.statement(
          'INSERT INTO v1_recurrence_events(rule_id,owner_id,operation_request_id,actor,payload,created_at) VALUES(?,?,?,?,?,?)',
          r.id,
          owner,
          p.request_id,
          JSON.stringify(actor),
          JSON.stringify(response),
          stamp,
        ),
      );
    statements.push(
      repo.statement(
        "UPDATE v1_operations SET status='committed',response_json=? WHERE owner_id=? AND client_id=? AND request_id=?",
        JSON.stringify(response),
        owner,
        actor.client_id,
        p.request_id,
      ),
    );
    try {
      await repo.db.batch(statements);
    } catch (e) {
      const message = String(e);
      if (message.includes('v1_operations') && message.includes('UNIQUE')) {
        const result = replay(
          await repo.operation(owner, actor.client_id, p.request_id),
        );
        if (result) return result;
      }
      if (message.includes('VERSION_CONFLICT'))
        throw new DomainError('VERSION_CONFLICT', 'Concurrent change', {
          current_version: old
            ? (await this.get(owner, { id: old.id })).version
            : undefined,
        });
      throw e;
    }
    return response;
  }
}
// Fair rotating bound: touch at most 20 least recently processed active rules per run.
export async function generateRecurrences(
  repo: Repository,
  now = new Date(),
): Promise<void> {
  const rows = (
    await repo
      .statement(
        "SELECT r.* FROM v1_recurrence_rules r LEFT JOIN v1_recurrence_generation g ON g.rule_id=r.id WHERE r.status='active' ORDER BY COALESCE(g.processed_at,''),r.id LIMIT 20",
      )
      .all<Row>()
  ).results;
  const service = new RecurrenceService(repo);
  const errors: unknown[] = [];
  for (const row of rows) {
    try {
      const rule = ruleRow(row);
      const statements = await service.generate(rule, now);
      statements.push(
        repo.statement(
          'INSERT INTO v1_recurrence_generation(rule_id,processed_at) VALUES(?,?) ON CONFLICT(rule_id) DO UPDATE SET processed_at=excluded.processed_at',
          rule.id,
          now.toISOString(),
        ),
      );
      try {
        await repo.db.batch(statements);
      } catch (e) {
        if (!String(e).includes('VERSION_CONFLICT')) throw e;
      }
    } catch (error) {
      console.error('Recurrence generation failed', { rule_id: row.id, error });
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(errors, 'Recurrence generation failed');
}
