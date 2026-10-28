import { Progress as ProgressSchema, type Task } from '../../contracts/index.ts';
export interface Statement {
  bind(...values: unknown[]): Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{
    results: T[];
  }>;
  run(): Promise<unknown>;
}
export interface Database {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<unknown[]>;
}
export function encodeCursor(value: unknown): string {
  return btoa(JSON.stringify(value))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}
export function decodeCursor(value: string): unknown {
  return JSON.parse(atob(value.replaceAll('-', '+').replaceAll('_', '/')));
}
export type Row = Record<string, unknown>;
export class Repository {
  db: Database;
  constructor(db: Database) {
    this.db = db;
  }
  // Write planners can retain snapshots while collecting a single atomic batch.
  recordTask(_task: Task): void {}
  statement(sql: string, ...values: unknown[]) {
    return this.db.prepare(sql).bind(...values);
  }
  async task(owner: string, id: string): Promise<Task | null> {
    const row = await this.statement(
      'SELECT * FROM v1_tasks WHERE owner_id=? AND id=?',
      owner,
      id,
    ).first<Row>();
    if (!row) return null;
    const checklist = (
      await this.statement(
        'SELECT * FROM v1_task_checklist_items WHERE task_id=? ORDER BY position',
        id,
      ).all<Row>()
    ).results.map(({ task_id, ...item }) => ({ ...item, done: !!item.done }));
    return {
      ...row,
      context_refs: JSON.parse(row.context_refs as string),
      completion_evidence: row.completion_evidence
        ? JSON.parse(row.completion_evidence as string)
        : null,
      checklist,
    } as Task;
  }
  /** Bulk compatibility reads avoid one D1 query per generated occurrence. */
  private async hydrateRows(rows: Row[]): Promise<Task[]> {
    const checklists = new Map<string, Task['checklist']>();
    for (let offset = 0; offset < rows.length; offset += 90) {
      const ids = rows.slice(offset, offset + 90).map(row => row.id);
      const items = (await this.statement(`SELECT * FROM v1_task_checklist_items WHERE task_id IN (${ids.map(() => '?').join(',')}) ORDER BY position`, ...ids).all<Row>()).results;
      for (const { task_id, ...item } of items) {
        const key = task_id as string;
        const checklist = checklists.get(key) ?? [];
        checklist.push({ ...item, done: !!item.done } as Task['checklist'][number]);
        checklists.set(key, checklist);
      }
    }
    return rows.map(row => ({ ...row,
      context_refs: JSON.parse(row.context_refs as string),
      completion_evidence: row.completion_evidence ? JSON.parse(row.completion_evidence as string) : null,
      checklist: checklists.get(row.id as string) ?? [],
    } as Task));
  }
  async legacyTasks(owner: string): Promise<Task[]> {
    return this.hydrateRows((await this.statement("SELECT * FROM v1_tasks WHERE owner_id=? AND executor_kind='self' AND series_id IS NULL AND archived_at IS NULL AND status!='cancelled' ORDER BY created_at,id", owner).all<Row>()).results);
  }
  async seriesTasks(owner: string, ids: string[]): Promise<Task[]> {
    return this.hydrateRows((await this.statement(`SELECT * FROM v1_tasks WHERE owner_id=? AND executor_kind='self' AND series_id IN (SELECT value FROM json_each(?)) ORDER BY created_at,id`, owner, JSON.stringify(ids)).all<Row>()).results);
  }
  async projectTasks(owner: string, area: string, project: string): Promise<Task[]> {
    return this.hydrateRows((await this.statement("SELECT * FROM v1_tasks WHERE owner_id=? AND executor_kind='self' AND area=? AND project_key=?", owner, area, project).all<Row>()).results);
  }
  async agentWork(owner: string, p: { cursor?: string; limit: number }) {
    const args: unknown[] = [owner];
    let after = '';
    if (p.cursor) {
      const cursor = decodeCursor(p.cursor);
      if (!Array.isArray(cursor) || cursor.length !== 2 || !cursor.every(v => typeof v === 'string'))
        throw new Error('INVALID_CURSOR');
      after = 'AND (created_at,id)>(?,?)';
      args.push(...cursor);
    }
    const rows = (await this.statement(`SELECT * FROM v1_tasks WHERE owner_id=?
      AND executor_kind='agent' AND archived_at IS NULL AND series_id IS NULL
      AND status IN ('todo','doing','waiting') ${after} ORDER BY created_at,id LIMIT ?`,
      ...args, p.limit + 1).all<Row>()).results;
    const page = rows.slice(0, p.limit);
    const tasks = await this.hydrateRows(page);
    const reports = page.length ? (await this.statement(`SELECT p.* FROM v1_tasks t
      JOIN v1_task_progress p ON p.owner_id=t.owner_id
        AND p.id=(SELECT latest.id FROM v1_task_progress latest
          WHERE latest.owner_id=t.owner_id AND latest.task_id=t.id
          ORDER BY latest.created_at DESC,latest.id DESC LIMIT 1)
      WHERE t.owner_id=? AND t.id IN (SELECT value FROM json_each(?))`,
      owner, JSON.stringify(page.map(row => row.id))).all<Row>()).results : [];
    const latest = new Map(reports.map(row => [row.task_id,
      ProgressSchema.parse({ ...row, actor: JSON.parse(row.actor as string) })]));
    const more = rows.length > p.limit;
    const last = page.at(-1);
    return { items: tasks.map(task => ({ ...task, latest_progress: latest.get(task.id) ?? null })),
      has_more: more, next_cursor: more && last ? encodeCursor([last.created_at, last.id]) : null };
  }
  async operation(
    owner: string,
    client: string,
    request: string,
  ): Promise<
    | (Row & {
        actor: unknown;
        response_json: unknown;
      })
    | null
  > {
    const row = await this.statement(
      'SELECT * FROM v1_operations WHERE owner_id=? AND client_id=? AND request_id=?',
      owner,
      client,
      request,
    ).first<Row>();
    return row
      ? {
          ...row,
          actor: JSON.parse(row.actor as string),
          response_json: row.response_json
            ? JSON.parse(row.response_json as string)
            : null,
        }
      : null;
  }
  async list(
    owner: string,
    p: {
      limit: number;
      cursor?: string;
      status?: string;
      area?: string;
      project_key?: string;
      executor_kind?: string; assigned_agent?: string; waiting_kind?: string; next_check_before?: string; unaccepted?: boolean;
      due_from?: string;
      due_to?: string;
    },
  ) {
    const where = ['owner_id=?', 'archived_at IS NULL'];
    const args: unknown[] = [owner];
    for (const k of ['status', 'area', 'project_key', 'executor_kind', 'assigned_agent', 'waiting_kind'] as const)
      if (p[k]) {
        where.push(`${k}=?`);
        args.push(p[k]);
      }
    if (p.assigned_agent || p.waiting_kind || p.next_check_before || p.unaccepted !== undefined)
      where.push("executor_kind='agent'");
    if (p.next_check_before) { where.push('julianday(next_check_at)<julianday(?)'); args.push(p.next_check_before); }
    if (p.unaccepted !== undefined) where.push(p.unaccepted ? 'accepted_at IS NULL' : 'accepted_at IS NOT NULL');
    for (const [key, operator] of [
      ['due_from', '>='],
      ['due_to', '<='],
    ] as const)
      if (p[key]) {
        where.push(
          `COALESCE(deadline_date,substr(deadline_at,1,10)) ${operator} ?`,
        );
        args.push(p[key]);
      }
    if (p.cursor) {
      const c = decodeCursor(p.cursor);
      if (
        !Array.isArray(c) ||
        c.length !== 2 ||
        !c.every((v) => typeof v === 'string')
      )
        throw new Error('INVALID_CURSOR');
      where.push('(created_at,id)>(?,?)');
      args.push(...c);
    }
    const rows = (
      await this.statement(
        `SELECT id,created_at FROM v1_tasks WHERE ${where.join(' AND ')} ORDER BY created_at,id LIMIT ?`,
        ...args,
        p.limit + 1,
      ).all<{
        id: string;
        created_at: string;
      }>()
    ).results;
    const more = rows.length > p.limit;
    const page = rows.slice(0, p.limit);
    const last = page.at(-1);
    return {
      items: (await Promise.all(
        page.map((r) => this.task(owner, r.id)),
      )) as Task[],
      has_more: more,
      next_cursor:
        more && last ? encodeCursor([last.created_at, last.id]) : null,
      coverage_incomplete: false,
    };
  }
  async changes(owner: string, since: string | undefined, limit: number) {
    const cursor = since ? decodeCursor(since) : 0;
    if (!Number.isSafeInteger(cursor) || Number(cursor) < 0)
      throw new Error('INVALID_CURSOR');
    const rows = (
      await this.statement(
        'SELECT * FROM v1_task_events WHERE owner_id=? AND id>? ORDER BY id LIMIT ?',
        owner,
        cursor,
        limit + 1,
      ).all<Row>()
    ).results;
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => ({
        ...r,
        actor: JSON.parse(r.actor as string),
        payload: JSON.parse(r.payload as string),
      })),
      has_more: rows.length > limit,
      next_cursor: page.length
        ? encodeCursor(page.at(-1)!.id)
        : (since ?? null),
    };
  }
}
