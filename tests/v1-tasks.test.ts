import assert from 'node:assert/strict';
import test from 'node:test';
import { SQLiteD1 } from './v1-d1-helper.ts';
import { Repository } from '../src/v1/storage/d1/index.ts';
import { TaskService, DomainError } from '../src/v1/tasks/index.ts';
import {
  generateOpenApi,
  Task as TaskSchema,
} from '../src/v1/contracts/index.ts';
const actor = { kind: 'service' as const, id: 'test', client_id: 'client' };
function setup() {
  const db = new SQLiteD1();
  const service = new TaskService(new Repository(db));
  return { db, service };
}
function code(expected: string) {
  return (e: unknown) => e instanceof DomainError && e.code === expected;
}
const create = (service: TaskService, request_id = 'create', extra = {}) =>
  service.create('owner', actor, {
    request_id,
    task: { title: 'task', ...extra },
  });
test('create/get/list, defaults, pagination, limits, filters and tenant isolation', async () => {
  const { service } = setup();
  for (let i = 0; i < 23; i++)
    await create(service, `c${i}`, { area: i === 0 ? 'work' : 'private' });
  const page = await service.list('owner');
  assert.equal(page.items.length, 20);
  assert.equal(page.has_more, true);
  assert.ok(page.next_cursor);
  const tail = await service.list('owner', { cursor: page.next_cursor });
  assert.equal(tail.items.length, 3);
  assert.equal(tail.has_more, false);
  assert.equal(
    new Set([...page.items, ...tail.items].map((t) => t.id)).size,
    23,
  );
  assert.equal((await service.list('owner', { limit: 100 })).items.length, 23);
  await assert.rejects(
    service.list('owner', { limit: 101 }),
    code('VALIDATION_FAILED'),
  );
  assert.equal((await service.list('owner', { area: 'work' })).items.length, 1);
  assert.equal((await service.list('other')).items.length, 0);
  assert.deepEqual(
    await service.get('owner', { id: page.items[0].id }),
    page.items[0],
  );
  await assert.rejects(
    service.get('other', { id: page.items[0].id }),
    code('NOT_FOUND'),
  );
});
test('idempotency replays identical response without events; changed input conflicts', async () => {
  const { db, service } = setup();
  const first = await create(service);
  assert.deepEqual(await create(service), first);
  assert.equal(db.count('v1_task_events'), 1);
  await assert.rejects(
    create(service, 'create', { title: 'different' }),
    code('IDEMPOTENCY_KEY_REUSED'),
  );
  const op = await service.get_operation('owner', actor, {
    request_id: 'create',
  });
  assert.deepEqual(op.response_json, first);
  assert.deepEqual(op.actor, actor);
  await assert.rejects(
    service.get_operation(
      'owner',
      { ...actor, client_id: 'other' },
      { request_id: 'create' },
    ),
    code('NOT_FOUND'),
  );
});
test('update preserves omitted defaults and checklist; stale update conflicts', async () => {
  const { service } = setup();
  const t = await create(service, 'c', {
    area: 'work',
    priority: 'high',
    checklist: [{ text: 'one' }],
  });
  const u = await service.update('owner', actor, {
    request_id: 'u',
    id: t.id,
    expected_version: 1,
    patch: { title: 'new' },
  });
  assert.equal(u.area, 'work');
  assert.equal(u.priority, 'high');
  assert.equal(u.checklist.length, 1);
  await assert.rejects(
    service.update('owner', actor, {
      request_id: 'stale',
      id: t.id,
      expected_version: 1,
      patch: { title: 'stale' },
    }),
    code('VERSION_CONFLICT'),
  );
});
test('forced failure rolls back operation, task, checklist and events', async () => {
  const { db, service } = setup();
  db.failAt = 3;
  await assert.rejects(
    create(service, 'fail', { checklist: [{ text: 'one' }] }),
    /forced/,
  );
  for (const table of [
    'v1_tasks',
    'v1_task_events',
    'v1_operations',
    'v1_task_checklist_items',
  ])
    assert.equal(db.count(table), 0);
  db.failAt = null;
  const t = await create(service);
  db.failAt = 2;
  await assert.rejects(
    service.update('owner', actor, {
      request_id: 'fail-update',
      id: t.id,
      expected_version: 1,
      patch: { title: 'changed' },
    }),
    /forced/,
  );
  assert.deepEqual(await service.get('owner', { id: t.id }), t);
  assert.equal(db.count('v1_operations'), 1);
  assert.equal(db.count('v1_task_events'), 1);
});
test('trigger aborts stale batch even when version changed after read', async () => {
  const { db, service } = setup();
  const t = await create(service);
  db.beforeBatch = () => {
    db.sqlite
      .prepare('UPDATE v1_tasks SET version=version+1 WHERE id=?')
      .run(t.id);
  };
  await assert.rejects(
    service.update('owner', actor, {
      request_id: 'raced',
      id: t.id,
      expected_version: 1,
      patch: { title: 'changed' },
    }),
    (e: unknown) =>
      code('VERSION_CONFLICT')(e) && (e as DomainError).details !== undefined,
  );
  assert.equal(db.count('v1_operations'), 1);
  assert.equal(db.count('v1_task_events'), 1);
  assert.equal((await service.get('owner', { id: t.id })).title, 'task');
});
test('unique operation race re-reads and replays committed response', async () => {
  const { db, service } = setup();
  const committed = await create(service);
  const original = service.repository.operation.bind(service.repository);
  let first = true;
  service.repository.operation = async (...args) => {
    if (first) {
      first = false;
      return null;
    }
    return original(...args);
  };
  assert.deepEqual(await create(service), committed);
  assert.equal(db.count('v1_tasks'), 1);
  assert.equal(db.count('v1_task_events'), 1);
});
test('completion evidence, transitions, changes cursor and append-only events', async () => {
  const { db, service } = setup();
  const t = await create(service);
  const args = { id: t.id, expected_version: 1, request_id: 'done' };
  await assert.rejects(
    service.complete('owner', actor, args),
    code('VALIDATION_FAILED'),
  );
  await assert.rejects(
    service.complete('owner', actor, {
      ...args,
      evidence: { kind: 'test', summary: ' ' },
    }),
    code('VALIDATION_FAILED'),
  );
  const done = await service.complete('owner', actor, {
    ...args,
    evidence: { kind: 'test', summary: 'verified' },
  });
  assert.equal(done.status, 'done');
  assert.ok(done.completed_at);
  await assert.rejects(
    service.cancel('owner', actor, {
      id: t.id,
      expected_version: 2,
      request_id: 'bad',
      reason: 'no',
    }),
    code('INVALID_TRANSITION'),
  );
  const reopened = await service.reopen('owner', actor, {
    id: t.id,
    expected_version: 2,
    request_id: 'reopen',
  });
  assert.equal(reopened.status, 'todo');
  assert.equal(reopened.completed_at, null);
  const cancelled = await service.cancel('owner', actor, {
    id: t.id,
    expected_version: 3,
    request_id: 'cancel',
    reason: 'no longer needed',
  });
  assert.equal(cancelled.status, 'cancelled');
  await service.reopen('owner', actor, {
    id: t.id,
    expected_version: 4,
    request_id: 'reopen-again',
  });
  await assert.rejects(
    service.skip_occurrence('owner', actor, {
      id: t.id,
      expected_version: 5,
      request_id: 'skip',
      reason: 'away',
    }),
    code('INVALID_TRANSITION'),
  );
  const first = await service.get_changes('owner', { limit: 2 });
  assert.equal(first.items.length, 2);
  assert.equal(first.has_more, true);
  const next = await service.get_changes('owner', {
    since: first.next_cursor,
    limit: 100,
  });
  assert.equal(next.items.length, 3);
  assert.deepEqual(first.items[0].actor, actor);
  assert.equal((await service.get_changes('other')).items.length, 0);
  assert.throws(
    () => db.sqlite.exec("UPDATE v1_task_events SET type='updated'"),
    /append-only/,
  );
  assert.throws(
    () => db.sqlite.exec('DELETE FROM v1_task_events'),
    /append-only/,
  );
});
test('occurrence skip cancels with skipped reason', async () => {
  const { db, service } = setup();
  const t = await create(service);
  db.sqlite.exec(
    "INSERT INTO v1_recurrence_rules(id,owner_id,template_json,kind,starts_on,status,created_at,updated_at) VALUES('series','owner','{}','daily','2026-10-27','active','now','now')",
  );
  db.sqlite
    .prepare(
      "UPDATE v1_tasks SET series_id='series',occurrence_key='2026-10-27',version=2 WHERE id=?",
    )
    .run(t.id);
  const skipped = await service.skip_occurrence('owner', actor, {
    id: t.id,
    expected_version: 2,
    request_id: 'skip',
    reason: 'away',
  });
  assert.equal(skipped.status, 'cancelled');
  assert.equal(skipped.cancel_reason, 'skipped:away');
});
test('deadline XOR enforced by service and database; offset required', async () => {
  const { db, service } = setup();
  await assert.rejects(
    create(service, 'bad', {
      deadline_date: '2026-10-27',
      deadline_at: '2026-10-27T01:00:00Z',
    }),
    code('VALIDATION_FAILED'),
  );
  for (const key of ['planned_start_at', 'deadline_at'])
    await assert.rejects(
      create(service, key, { [key]: '2026-10-27T01:00:00' }),
      code('VALIDATION_FAILED'),
    );
  const t = await create(service, 'date', { deadline_date: '2026-10-27' });
  await assert.rejects(
    service.update('owner', actor, {
      id: t.id,
      request_id: 'bad-patch',
      expected_version: 1,
      patch: { deadline_at: '2026-10-27T01:00:00Z' },
    }),
    code('VALIDATION_FAILED'),
  );
  assert.throws(
    () =>
      db.sqlite
        .prepare(
          "UPDATE v1_tasks SET version=2,deadline_at='2026-10-27T01:00:00Z' WHERE id=?",
        )
        .run(t.id),
    /CHECK/,
  );
  assert.equal(
    (
      await service.list('owner', {
        due_from: '2026-10-27',
        due_to: '2026-10-27',
      })
    ).items.length,
    1,
  );
  assert.equal(
    (await service.list('owner', { due_from: '2026-10-28' })).items.length,
    0,
  );
});
test('migration applies after 0001-0005; OpenAPI generated from registry', () => {
  const db = new SQLiteD1(true);
  assert.equal(db.count('v1_tasks'), 0);
  assert.equal(db.count('operations'), 0);
  assert.ok(generateOpenApi().paths['/api/v1/tasks']);
});
test('checklist replacement and clearing are committed with task, malformed cursors fail validation', async () => {
  const { service } = setup();
  const t = await create(service, 'c', {
    checklist: [{ text: 'first', done: true }],
  });
  assert.ok(t.checklist[0].done_at);
  const u = await service.update('owner', actor, {
    id: t.id,
    request_id: 'replace',
    expected_version: 1,
    patch: { checklist: [{ text: 'second' }] },
  });
  assert.equal(u.checklist[0].text, 'second');
  assert.equal(u.checklist[0].done, false);
  assert.deepEqual(await service.get('owner', { id: t.id }), u);
  const cleared = await service.update('owner', actor, {
    id: t.id,
    request_id: 'clear',
    expected_version: 2,
    patch: { checklist: [] },
  });
  assert.deepEqual(cleared.checklist, []);
  assert.deepEqual((await service.get('owner', { id: t.id })).checklist, []);
  await assert.rejects(
    service.list('owner', { cursor: '!' }),
    code('VALIDATION_FAILED'),
  );
  await assert.rejects(
    service.get_changes('owner', { since: '!' }),
    code('VALIDATION_FAILED'),
  );
});
test('canonical input key ordering and operation race with different input', async () => {
  const { db, service } = setup();
  const t = await service.create('owner', actor, {
    request_id: 'c',
    task: { title: 'task', notes: 'memo' },
  });
  assert.deepEqual(
    await service.create('owner', actor, {
      task: { notes: 'memo', title: 'task' },
      request_id: 'c',
    }),
    t,
  );
  const original = service.repository.operation.bind(service.repository);
  let first = true;
  service.repository.operation = async (...args) => {
    if (first) {
      first = false;
      return null;
    }
    return original(...args);
  };
  await assert.rejects(
    create(service, 'c', { title: 'different' }),
    code('IDEMPOTENCY_KEY_REUSED'),
  );
  assert.equal(db.count('v1_task_events'), 1);
});
test('DB enum, JSON, uniqueness and version constraints reject invalid writes', async () => {
  const { db, service } = setup();
  const t = await create(service);
  for (const assignment of [
    "status='bogus'",
    "priority='urgent'",
    "context_refs='invalid'",
    "completion_evidence='invalid'",
  ]) {
    assert.throws(
      () =>
        db.sqlite
          .prepare(`UPDATE v1_tasks SET version=2,${assignment} WHERE id=?`)
          .run(t.id),
      /CHECK/,
    );
  }
  assert.throws(
    () =>
      db.sqlite.prepare('UPDATE v1_tasks SET version=1 WHERE id=?').run(t.id),
    /VERSION_CONFLICT/,
  );
  assert.throws(
    () =>
      db.sqlite.exec(
        "INSERT INTO v1_recurrence_rules(id,owner_id,version,template_json,kind,starts_on,status,created_at,updated_at) VALUES('s','o',0,'{}','daily','2026-10-27','active','now','now')",
      ),
    /CHECK/,
  );
  assert.ok(TaskSchema.safeParse(t).success);
});

test('pending operation replay reports OPERATION_IN_PROGRESS rather than a task version conflict', async () => {
  const db = new SQLiteD1();
  const repository = new Repository(db);
  const service = new TaskService(repository);
  const owner = 'owner';
  const actor = {
    kind: 'service' as const,
    id: owner,
    client_id: 'pending-test',
  };
  const input = { request_id: 'pending-request', task: { title: 'Pending' } };
  const task = await service.create(owner, actor, input);
  db.sqlite
    .prepare(
      "UPDATE v1_operations SET status='pending',response_json=NULL WHERE request_id=?",
    )
    .run(input.request_id);
  await assert.rejects(
    service.create(owner, actor, input),
    (error: unknown) =>
      error instanceof DomainError && error.code === 'OPERATION_IN_PROGRESS',
  );
  assert.equal((await service.get(owner, { id: task.id })).version, 1);
  assert.equal(db.count('v1_task_events'), 1);
  db.sqlite.close();
});
