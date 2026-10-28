-- Task mutation ledger.  GitHub remains the task authority; this table is
-- only the durable replay/conflict/ambiguous record for external writes.
CREATE TABLE IF NOT EXISTS task_mutation_ledger (
  operation_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(operation_id) BETWEEN 1 AND 256),
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (length(idempotency_key) BETWEEN 1 AND 256),
  task_id TEXT NOT NULL
    CHECK (length(task_id) BETWEEN 1 AND 256),
  action TEXT NOT NULL CHECK (action IN ('update', 'complete', 'delete')),
  expected_revision INTEGER NOT NULL CHECK (expected_revision BETWEEN 1 AND 9007199254740991),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL CHECK (status IN ('applied', 'replayed', 'ambiguous', 'conflict', 'not_found')),
  result_json TEXT NOT NULL CHECK (json_valid(result_json) AND length(result_json) <= 65536),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 64),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 1 AND 64)
);

CREATE INDEX IF NOT EXISTS task_mutation_ledger_task_idx
  ON task_mutation_ledger (task_id, created_at DESC);

-- At most one operation may claim a task revision.  This closes the race in
-- which two different operation IDs both read revision N and PATCH N+1.
CREATE UNIQUE INDEX IF NOT EXISTS task_mutation_ledger_task_revision_idx
  ON task_mutation_ledger (task_id, expected_revision)
  WHERE status IN ('ambiguous', 'applied');
