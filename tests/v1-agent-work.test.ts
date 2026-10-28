import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { SQLiteD1 } from './v1-d1-helper.ts';
import { Repository } from '../src/v1/storage/d1/index.ts';
import { TaskService, DomainError, hash } from '../src/v1/tasks/index.ts';
import { opRegistry, httpRegistry, generateOpenApi, Progress, inputs } from '../src/v1/contracts/index.ts';

const actor = { kind: 'oauth_client', id: 'owner', client_id: 'bot-a' } as const;
const errorCode = (code: string) => (e: unknown) => e instanceof DomainError && e.code === code;

test('the original 15 MCP inputs retain PR1 fields with additive wake hint and urgent priority', () => {
  const baseline = JSON.parse(readFileSync(new URL('./fixtures/v1-mcp-pr1-inputs.json', import.meta.url), 'utf8'));
  for (const [toolName, digest] of Object.entries(baseline)) {
    const op = opRegistry.find(op => op.toolName === toolName)!;
    assert.ok(op, toolName);
    const schema = z.toJSONSchema(op.inputSchema, { io: 'input' });
    if (['taskflow_create', 'taskflow_complete'].includes(toolName)) {
      assert.equal(schema.properties?.acting_agent?.type, 'string');
      delete schema.properties?.acting_agent;
    }
    if (toolName === 'taskflow_create') {
      assert.deepEqual(schema.properties?.wake_now, { type: 'boolean' });
      delete schema.properties?.wake_now;
    }
    if (toolName === 'taskflow_create' || toolName === 'taskflow_update') {
      const container = schema.properties?.[toolName === 'taskflow_create' ? 'task' : 'patch'] as { properties: { priority: { enum: string[] } } };
      assert.deepEqual(container.properties.priority.enum, ['low', 'normal', 'high', 'urgent']);
      container.properties.priority.enum = ['low', 'normal', 'high'];
    }
    assert.equal(createHash('sha256').update(JSON.stringify(schema)).digest('hex'), digest, toolName);
  }
  assert.equal(Object.keys(baseline).length, 15);
});
function setup(t: import('node:test').TestContext) {
  const db = new SQLiteD1(true);
  t.after(() => db.sqlite.close());
  const repo = new Repository(db);
  const service = new TaskService(repo, { agentWorkEnabled: true });
  const create = (extra = {}, request_id = crypto.randomUUID()) => service.create('owner', actor, {
    request_id, task: { title: 'AI work', executor_kind: 'agent', assigned_agent: 'bot-a', ...extra },
  });
  const claim = (id: string, expected_version = 1, request_id = crypto.randomUUID()) =>
    service.claim('owner', actor, { id, expected_version, request_id, assigned_agent: 'bot-a' });
  return { db, repo, service, create, claim };
}

test('0011 preserves existing data and versions while adding nullable fields', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON');
    const dir = new URL('../migrations/', import.meta.url);
    for (const name of readdirSync(dir).sort().filter(n => n < '0011')) db.exec(readFileSync(new URL(name, dir), 'utf8'));
    db.exec("INSERT INTO v1_tasks(id,owner_id,version,title,area,status,priority,executor_kind,created_at,updated_at) VALUES('old','owner',7,'Preserved','private','todo','normal','self','2026-10-27T00:00:00Z','2026-10-27T00:00:00Z')");
    const before = db.prepare('SELECT * FROM v1_tasks').get()!;
    db.exec(readFileSync(new URL('0011_v1_agent_work.sql', dir), 'utf8'));
    const after = db.prepare('SELECT * FROM v1_tasks').get()!;
    for (const [key, value] of Object.entries(before)) assert.deepEqual(after[key], value);
    for (const key of ['assigned_agent', 'requester_ref', 'accepted_at', 'waiting_kind', 'waiting_on_ref', 'blocker_summary', 'next_check_at', 'next_check_by']) assert.equal(after[key], null);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally { db.close(); }
});

test('AI creation and dedicated writes default to disabled; human writes remain available', async t => {
  const { repo, service, create } = setup(t);
  const off = new TaskService(repo);
  await assert.rejects(off.create('owner', actor, { request_id: 'off', task: { title: 'AI', executor_kind: 'agent' } }), errorCode('FORBIDDEN'));
  const task = await create();
  const writes = [
    () => off.claim('owner', actor, { id: task.id, expected_version: 1, request_id: 'claim', assigned_agent: 'bot-a' }),
    () => off.logProgress('owner', actor, { id: task.id, request_id: 'progress', summary: 'Update' }),
    () => off.setWaiting('owner', actor, { id: task.id, expected_version: 1, request_id: 'wait', waiting_kind: 'human', waiting_on_ref: 'owner', blocker_summary: 'Review', next_check_at: '2026-10-28T00:00:00Z', next_check_by: 'bot-a' }),
    () => off.handoff('owner', actor, { id: task.id, expected_version: 1, request_id: 'handoff', assigned_agent: 'bot-b', reason: 'Review', next_check_by: 'bot-a' }),
    () => off.update('owner', actor, { id: task.id, expected_version: 1, request_id: 'update', patch: { title: 'Stop' } }),
  ];
  for (const write of writes) await assert.rejects(write(), errorCode('FORBIDDEN'));
  const human = await off.create('owner', actor, { request_id: 'human', task: { title: 'Human' } });
  assert.equal((await off.update('owner', actor, { id: human.id, request_id: 'human-update', expected_version: 1, patch: { title: 'Edited' } })).version, 2);
  assert.equal((await service.listProgress('owner', { id: task.id })).items.length, 0);
});

test('claim, waiting and handoff replay without duplicate events and reset acceptance', async t => {
  const { db, service, create, claim } = setup(t);
  const task = await create({ requester_ref: 'notion:request' });
  const accepted = await claim(task.id, 1, 'claim');
  assert.equal(accepted.status, 'doing'); assert.ok(accepted.accepted_at); assert.equal(accepted.version, 2);
  assert.deepEqual(await claim(task.id, 1, 'claim'), accepted);
  const waiting = { id: task.id, request_id: 'waiting', expected_version: 2, waiting_kind: 'human', waiting_on_ref: 'owner', blocker_summary: 'Review result', next_check_at: '2026-10-28T10:00:00+09:00', next_check_by: 'bot-a' };
  const waited = await service.setWaiting('owner', actor, waiting);
  assert.equal(waited.status, 'waiting'); assert.equal(waited.waiting_kind, 'human');
  assert.deepEqual(await service.setWaiting('owner', actor, waiting), waited);
  const handoff = { id: task.id, request_id: 'handoff', expected_version: 3, assigned_agent: 'bot-b', reason: 'Needs research', next_check_by: 'bot-b', next_check_at: '2026-10-29T00:00:00Z' };
  const handed = await service.handoff('owner', actor, handoff);
  assert.equal(handed.status, 'todo'); assert.equal(handed.accepted_at, null); assert.equal(handed.waiting_kind, null);
  assert.equal(handed.next_check_by, 'bot-b'); assert.equal(handed.version, 4);
  assert.deepEqual(await service.handoff('owner', actor, handoff), handed);
  assert.equal(db.count('v1_task_events'), 4); assert.equal(db.count('v1_operations'), 4);
  const event = db.sqlite.prepare('SELECT payload FROM v1_task_events ORDER BY id DESC LIMIT 1').get()!;
  assert.equal(JSON.parse(event.payload as string).agent_work.reason, handoff.reason);
  await assert.rejects(claim(task.id, 4), errorCode('INVALID_TRANSITION'));
  const next = await service.claim('owner', actor, { id: task.id, request_id: 'next', expected_version: 4, assigned_agent: 'bot-b' });
  assert.equal(next.status, 'doing'); assert.equal(next.next_check_at, null);
});

test('stale writes and database races abort all operation and event writes', async t => {
  const { db, service, create, claim } = setup(t);
  const task = await create();
  const accepted = await claim(task.id);
  await assert.rejects(service.handoff('owner', actor, { id: task.id, request_id: 'stale', expected_version: 1, assigned_agent: 'bot-b', reason: 'Research', next_check_by: 'bot-b' }), errorCode('VERSION_CONFLICT'));
  db.beforeBatch = () => { db.sqlite.prepare("UPDATE v1_tasks SET title='Concurrent',version=version+1 WHERE id=?").run(task.id); };
  await assert.rejects(service.setWaiting('owner', actor, { id: task.id, request_id: 'race', expected_version: accepted.version, waiting_kind: 'external', waiting_on_ref: 'service', blocker_summary: 'Pending', next_check_at: '2026-10-28T00:00:00Z', next_check_by: 'bot-a' }), errorCode('VERSION_CONFLICT'));
  const current = await service.get('owner', { id: task.id });
  assert.equal(current.title, 'Concurrent'); assert.equal(current.status, 'doing');
  assert.equal(db.count('v1_operations'), 2); assert.equal(db.count('v1_task_events'), 2);
});

for (const operation of ['claim', 'handoff'] as const) test(`${operation} cannot overwrite a concurrent terminal transition`, async t => {
  const { db, service, create } = setup(t);
  const task = await create();
  db.beforeBatch = () => { db.sqlite.prepare("UPDATE v1_tasks SET status='cancelled',cancel_reason='Concurrent',version=version+1 WHERE id=?").run(task.id); };
  await assert.rejects(service[operation]('owner', actor, { id: task.id, request_id: 'race-terminal', expected_version: 1, assigned_agent: operation === 'claim' ? 'bot-a' : 'bot-b', ...(operation === 'handoff' ? { reason: 'Research', next_check_by: 'bot-b' } : {}) }), errorCode('VERSION_CONFLICT'));
  assert.equal((await service.get('owner', { id: task.id })).status, 'cancelled');
  assert.equal(db.count('v1_operations'), 1);
});

test('terminal, archived, unaccepted and human tasks reject invalid AI state transitions', async t => {
  const { service, create, claim } = setup(t);
  const task = await create();
  await assert.rejects(service.setWaiting('owner', actor, { id: task.id, request_id: 'wait', expected_version: 1, waiting_kind: 'agent', waiting_on_ref: 'bot-b', blocker_summary: 'Pending', next_check_at: '2026-10-28T00:00:00Z', next_check_by: 'bot-a' }), errorCode('INVALID_TRANSITION'));
  for (const status of ['done', 'cancelled']) {
    const terminal = await create({}, status);
    const finished = status === 'done'
      ? await service.complete('owner', actor, { id: terminal.id, request_id: 'complete', expected_version: 1, evidence: { kind: 'test', summary: 'Verified' } })
      : await service.cancel('owner', actor, { id: terminal.id, request_id: 'cancel', expected_version: 1, reason: 'Cancelled' });
    await assert.rejects(claim(finished.id, 2), errorCode('INVALID_TRANSITION'));
    await assert.rejects(service.handoff('owner', actor, { id: finished.id, request_id: `handoff-${status}`, expected_version: 2, assigned_agent: 'bot-b', reason: 'Research', next_check_by: 'bot-b' }), errorCode('INVALID_TRANSITION'));
  }
  const human = await create({ executor_kind: 'self', assigned_agent: null });
  await assert.rejects(claim(human.id), errorCode('INVALID_TRANSITION'));
  await assert.rejects(service.logProgress('owner', actor, { id: human.id, request_id: 'human-log', summary: 'No' }), errorCode('INVALID_TRANSITION'));
  const archived = await service.archive('owner', actor, { id: task.id, request_id: 'archive', expected_version: 1, reason: 'Archive' });
  await assert.rejects(claim(archived.id, 2), errorCode('INVALID_TRANSITION'));
});

test('progress replay is append-only, records proxy attribution and leaves the complete task unchanged', async t => {
  const { db, service, create, claim } = setup(t);
  const task = await create(); await claim(task.id);
  const before = await service.get('owner', { id: task.id });
  const input = { id: task.id, request_id: 'progress', summary: 'Research completed', attribution: 'proxy', reported_agent: 'offline-bot', source_ref: 'https://example.test/result' };
  const progress = await service.logProgress('owner', actor, input);
  assert.ok(Progress.safeParse(progress).success); assert.equal(progress.actor.client_id, 'bot-a'); assert.equal(progress.reported_agent, 'offline-bot');
  assert.deepEqual(await service.logProgress('owner', actor, input), progress);
  await assert.rejects(service.logProgress('owner', actor, { ...input, summary: 'Different' }), errorCode('IDEMPOTENCY_KEY_REUSED'));
  assert.deepEqual(await service.get('owner', { id: task.id }), before);
  assert.equal(db.count('v1_task_progress'), 1); assert.equal(db.count('v1_task_events'), 2);
  assert.throws(() => db.sqlite.prepare("UPDATE v1_task_progress SET summary='Changed' WHERE id=?").run(progress.id), /append-only/);
  assert.throws(() => db.sqlite.prepare('DELETE FROM v1_task_progress WHERE id=?').run(progress.id), /append-only/);
  assert.throws(() => db.sqlite.prepare("INSERT INTO v1_task_progress SELECT 'foreign',task_id,'other',client_id,'foreign',actor,reported_agent,attribution,summary,source_ref,created_at FROM v1_task_progress").run(), /AI_PROGRESS_TARGET_INVALID|FOREIGN KEY/);
});

test('progress and status writes coexist; failed batches leave no progress or pending operation', async t => {
  const { db, service, create } = setup(t);
  const task = await create();
  db.beforeBatch = () => { db.sqlite.prepare("UPDATE v1_tasks SET title='Concurrent',version=version+1 WHERE id=?").run(task.id); };
  await service.logProgress('owner', actor, { id: task.id, request_id: 'log', summary: 'Independent' });
  assert.equal((await service.get('owner', { id: task.id })).version, 2);
  assert.equal((await service.get('owner', { id: task.id })).title, 'Concurrent');
  db.failAt = 2;
  await assert.rejects(service.logProgress('owner', actor, { id: task.id, request_id: 'failed', summary: 'Rollback' }), /forced batch failure/);
  db.failAt = null;
  assert.equal(db.count('v1_task_progress'), 1); assert.equal(db.count('v1_operations'), 2);
  await service.logProgress('owner', actor, { id: task.id, request_id: 'failed', summary: 'Rollback' });
  assert.equal(db.count('v1_task_progress'), 2);
});

test('progress validates attribution, bounds, state injection and owner boundaries', async t => {
  const { db, service, create, claim } = setup(t);
  const task = await create();
  for (const extra of [ { summary: ' ' }, { summary: 'x'.repeat(2001) }, { attribution: 'proxy' }, { reported_agent: 'another' }, { status: 'done' }, { expected_version: 1 } ])
    await assert.rejects(service.logProgress('owner', actor, { id: task.id, request_id: crypto.randomUUID(), summary: 'Report', ...extra }), errorCode('VALIDATION_FAILED'));
  await assert.rejects(service.logProgress('other', actor, { id: task.id, request_id: 'foreign', summary: 'Forbidden' }), errorCode('NOT_FOUND'));
  await assert.rejects(service.claim('other', actor, { id: task.id, request_id: 'foreign-claim', expected_version: 1, assigned_agent: 'bot-a' }), errorCode('NOT_FOUND'));
  await assert.rejects(service.listProgress('other', { id: task.id }), errorCode('NOT_FOUND'));
  await assert.rejects(service.handoff('other', actor, { id: task.id, request_id: 'foreign-handoff', expected_version: 1, assigned_agent: 'bot-b', reason: 'No', next_check_by: 'bot-b' }), errorCode('NOT_FOUND'));
  await assert.rejects(service.setWaiting('other', actor, { id: task.id, request_id: 'foreign-wait', expected_version: 1, waiting_kind: 'human', waiting_on_ref: 'owner', blocker_summary: 'No', next_check_at: '2026-10-28T00:00:00Z', next_check_by: 'bot-a' }), errorCode('NOT_FOUND'));
  assert.equal(db.count('v1_task_progress'), 0);
  await claim(task.id);
});

test('task and progress request IDs share the owner/client operation namespace', async t => {
  const { service, create, claim } = setup(t);
  const task = await create(); await claim(task.id, 1, 'shared');
  await assert.rejects(service.logProgress('owner', actor, { id: task.id, request_id: 'shared', summary: 'Report' }), errorCode('IDEMPOTENCY_KEY_REUSED'));
  const log = await service.logProgress('owner', actor, { id: task.id, request_id: 'log', summary: 'Report' });
  const otherClient = await service.logProgress('owner', { ...actor, client_id: 'bot-b' }, { id: task.id, request_id: 'log', summary: 'Report' });
  assert.notEqual(log.id, otherClient.id);
  assert.deepEqual((await service.get_operation('owner', actor, { request_id: 'log' })).response_json, log);
});

test('list filters compose, parse false accurately, compare offsets and paginate progress without mixing owners', async t => {
  const { service, create, claim } = setup(t);
  const task = await create(); await claim(task.id);
  const unaccepted = await create({}, 'unaccepted');
  await create({ executor_kind: 'self', assigned_agent: null }, 'human');
  await service.setWaiting('owner', actor, { id: task.id, request_id: 'wait', expected_version: 2, waiting_kind: 'dependency', waiting_on_ref: unaccepted.id, blocker_summary: 'Dependency', next_check_at: '2026-10-28T10:00:00+09:00', next_check_by: 'bot-a' });
  assert.deepEqual((await service.list('owner', { assigned_agent: 'bot-a', waiting_kind: 'dependency', unaccepted: 'false', next_check_before: '2026-10-28T02:00:00Z' })).items.map(t => t.id), [task.id]);
  assert.equal((await service.list('owner', { next_check_before: '2026-10-28T00:00:00Z' })).items.length, 0);
  assert.deepEqual((await service.list('owner', { unaccepted: true })).items.map(t => t.id), [unaccepted.id]);
  assert.equal((await service.list('owner', { executor_kind: 'self' })).items.length, 1);
  assert.equal((await service.list('other', { assigned_agent: 'bot-a' })).items.length, 0);
  await assert.rejects(service.list('owner', { unaccepted: 'yes' }), errorCode('VALIDATION_FAILED'));
  const logs = [];
  for (let i = 0; i < 3; i++) logs.push(await service.logProgress('owner', actor, { id: task.id, request_id: `log${i}`, summary: `Step ${i}` }));
  const first = await service.listProgress('owner', { id: task.id, limit: 2 });
  const second = await service.listProgress('owner', { id: task.id, limit: 2, cursor: first.next_cursor });
  assert.equal(first.has_more, true); assert.equal(second.has_more, false);
  assert.deepEqual(new Set([...first.items, ...second.items].map(x => x.id)), new Set(logs.map(x => x.id)));
  for (const cursor of ['invalid', btoa('1'), btoa('[1,2]')]) await assert.rejects(service.listProgress('owner', { id: task.id, cursor }), errorCode('VALIDATION_FAILED'));
});

test('general patches cannot bypass AI state operations or convert executor kinds', async t => {
  const { service, create } = setup(t);
  const ai = await create();
  const human = await create({ executor_kind: 'self', assigned_agent: null });
  for (const [task, patch] of [[ai, { status: 'doing' }], [ai, { executor_kind: 'self' }], [human, { executor_kind: 'agent' }]] as const)
    await assert.rejects(service.update('owner', actor, { id: task.id, expected_version: 1, request_id: crypto.randomUUID(), patch }), errorCode('INVALID_TRANSITION'));
  assert.equal(inputs.update.safeParse({ id: ai.id, expected_version: 1, request_id: 'bypass', patch: { assigned_agent: 'bot-b' } }).success, false);
  await assert.rejects(create({ status: 'doing' }), errorCode('INVALID_TRANSITION'));
  await assert.rejects(service.create_recurrence_rule('owner', actor, { request_id: 'ai-rule', rule: { template: { title: 'AI rule', executor_kind: 'agent' }, kind: 'daily', starts_on: '2026-10-27' } }), errorCode('FORBIDDEN'));
});

test('MCP retains 20 operations while HTTP also exposes the read-only web list', () => {
  assert.equal(opRegistry.length, 20); assert.equal(httpRegistry.length, 21);
  const schema = generateOpenApi();
  assert.ok(schema.paths['/api/v1/tasks/{id}/progress'].get);
  assert.ok(schema.paths['/api/v1/tasks/{id}/progress'].post);
  assert.equal(opRegistry.some(op => op.name === 'claim'), true);
  assert.equal(httpRegistry.filter(op => op.name === 'list_agent_work').length, 1);
  assert.equal(opRegistry.some(op => (op.name as string) === 'list_agent_work'), false);
  assert.ok(schema.paths['/api/v1/agent-work'].get);
});

test('claim resumes waiting work for the same agent without changing the original acceptance time', async t => {
  const { service, create, claim } = setup(t);
  const task = await create();
  const accepted = await claim(task.id);
  await service.setWaiting('owner', actor, { id: task.id, request_id: 'wait', expected_version: 2, waiting_kind: 'external', waiting_on_ref: 'provider', blocker_summary: 'Response pending', next_check_at: '2026-10-28T00:00:00Z', next_check_by: 'bot-a' });
  const resumed = await claim(task.id, 3);
  assert.equal(resumed.status, 'doing'); assert.equal(resumed.accepted_at, accepted.accepted_at);
  assert.equal(resumed.waiting_kind, null); assert.equal(resumed.next_check_by, null);
  await assert.rejects(claim(task.id, 4), errorCode('INVALID_TRANSITION'));
});

test('claim and handoff failures roll back atomically and changed replay inputs conflict', async t => {
  const { db, service, create, claim } = setup(t);
  const task = await create();
  db.failAt = 3;
  await assert.rejects(claim(task.id, 1, 'retry'), /forced batch failure/);
  db.failAt = null;
  assert.equal(db.count('v1_operations'), 1); assert.equal(db.count('v1_task_events'), 1);
  assert.equal((await service.get('owner', { id: task.id })).accepted_at, null);
  await claim(task.id, 1, 'retry');
  await assert.rejects(service.claim('owner', actor, { id: task.id, expected_version: 1, request_id: 'retry', assigned_agent: 'bot-b' }), errorCode('IDEMPOTENCY_KEY_REUSED'));
  const handoff = { id: task.id, expected_version: 2, request_id: 'handoff', assigned_agent: 'bot-b', reason: 'Research', next_check_by: 'bot-b' };
  await service.handoff('owner', actor, handoff);
  await assert.rejects(service.handoff('owner', actor, { ...handoff, reason: 'Changed' }), errorCode('IDEMPOTENCY_KEY_REUSED'));
});

test('a simultaneous duplicate progress request returns the winning committed response', async t => {
  const { db, service, create } = setup(t);
  const task = await create();
  const input = { id: task.id, request_id: 'simultaneous', summary: 'One report' };
  const normalized = { ...input, source_ref: null, attribution: 'self', reported_agent: actor.client_id };
  const inputHash = await hash({ op: 'log_progress', input: normalized });
  const winner = Progress.parse({ ...normalized, id: 'prg_winner', task_id: task.id, owner_id: 'owner', client_id: actor.client_id, actor, created_at: '2026-10-27T00:00:00Z' });
  db.beforeBatch = () => {
    db.sqlite.prepare("INSERT INTO v1_operations(owner_id,client_id,request_id,op,input_hash,status,actor,task_id,created_at,response_json) VALUES(?,?,?,'log_progress',?,'committed',?,?,?,?)")
      .run('owner', actor.client_id, input.request_id, inputHash, JSON.stringify(actor), task.id, winner.created_at, JSON.stringify(winner));
    db.sqlite.prepare('INSERT INTO v1_task_progress(id,task_id,owner_id,client_id,request_id,actor,reported_agent,attribution,summary,source_ref,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(winner.id, task.id, 'owner', actor.client_id, input.request_id, JSON.stringify(actor), winner.reported_agent, 'self', winner.summary, null, winner.created_at);
  };
  assert.deepEqual(await service.logProgress('owner', actor, input), winner);
  assert.equal(db.count('v1_task_progress'), 1); assert.equal(db.count('v1_operations'), 2);
  assert.equal((await service.get('owner', { id: task.id })).version, 1);
});

test('a concurrent archive rejects progress without leaving a pending operation', async t => {
  const { db, service, create } = setup(t);
  const task = await create();
  db.beforeBatch = () => {
    db.sqlite.prepare("UPDATE v1_tasks SET status='cancelled',archived_at='2026-10-27T00:00:00Z',version=version+1 WHERE id=?").run(task.id);
  };
  await assert.rejects(service.logProgress('owner', actor, { id: task.id, request_id: 'archive-race', summary: 'Too late' }), errorCode('INVALID_TRANSITION'));
  assert.equal(db.count('v1_task_progress'), 0); assert.equal(db.count('v1_operations'), 1);
});
