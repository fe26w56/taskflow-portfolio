-- TaskFlow Foundation v1
--
-- The canonical design keeps GitHub Issues as the Task authority.  D1 owns
-- high-frequency proposal/decision, actual, audit, and sync metadata; the
-- task_projections table is therefore explicitly a projection of an external
-- Task authority.  All mutation rows carry an operation and idempotency key.
--
-- Integer values are bounded to JavaScript Number.MAX_SAFE_INTEGER because
-- Worker/D1 reads expose SQLite INTEGER values as numbers.

CREATE TABLE IF NOT EXISTS operations (
  operation_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(operation_id) BETWEEN 1 AND 256),
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (length(idempotency_key) BETWEEN 1 AND 256),
  entity_type TEXT NOT NULL
    CHECK (length(entity_type) BETWEEN 1 AND 128),
  entity_id TEXT NOT NULL
    CHECK (length(entity_id) BETWEEN 1 AND 256),
  expected_revision INTEGER NOT NULL CHECK (expected_revision BETWEEN 0 AND 9007199254740991),
  payload_hash TEXT NOT NULL
    CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL CHECK (length(status) BETWEEN 1 AND 64),
  result_json TEXT NOT NULL
    CHECK (json_valid(result_json) AND length(result_json) <= 65536),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 64),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 1 AND 64)
);

CREATE INDEX IF NOT EXISTS operations_entity_idx
  ON operations (entity_type, entity_id, created_at DESC);

-- GitHub Issues remain the source of truth for Tasks.  This table is a
-- replaceable, one-way D1 projection and never an authoritative task writer.
CREATE TABLE IF NOT EXISTS task_projections (
  projection_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(projection_id) BETWEEN 1 AND 256),
  source_id TEXT NOT NULL
    CHECK (length(source_id) BETWEEN 1 AND 256),
  source_authority TEXT NOT NULL DEFAULT 'projection'
    CHECK (source_authority = 'projection'),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
  source_revision INTEGER NOT NULL CHECK (source_revision BETWEEN 0 AND 9007199254740991),
  payload_json TEXT NOT NULL
    CHECK (json_valid(payload_json) AND length(payload_json) <= 65536),
  operation_id TEXT NOT NULL REFERENCES operations(operation_id),
  idempotency_key TEXT NOT NULL UNIQUE REFERENCES operations(idempotency_key),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 1 AND 64)
);

CREATE UNIQUE INDEX IF NOT EXISTS task_projections_source_idx
  ON task_projections (source_authority, source_id);
CREATE INDEX IF NOT EXISTS task_projections_revision_idx
  ON task_projections (source_id, source_revision DESC);

-- Actual / episode is a D1 canonical record.  It is immutable at the
-- repository boundary and deliberately rejects Calendar projections as an
-- actual source; scheduled time is not measured effort in the design.
CREATE TABLE IF NOT EXISTS actuals (
  actual_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(actual_id) BETWEEN 1 AND 256),
  task_id TEXT NOT NULL
    CHECK (length(task_id) BETWEEN 1 AND 256),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
  active_min REAL CHECK (active_min IS NULL OR active_min >= 0),
  elapsed_days REAL CHECK (elapsed_days IS NULL OR elapsed_days >= 0),
  interruptions_json TEXT
    CHECK (interruptions_json IS NULL OR (json_valid(interruptions_json) AND length(interruptions_json) <= 65536)),
  rework_json TEXT
    CHECK (rework_json IS NULL OR (json_valid(rework_json) AND length(rework_json) <= 65536)),
  source TEXT NOT NULL
    CHECK (length(source) BETWEEN 1 AND 128 AND lower(trim(source)) NOT IN ('calendar', 'calendar_projection', 'scheduled_block')),
  payload_json TEXT NOT NULL
    CHECK (json_valid(payload_json) AND length(payload_json) <= 65536),
  operation_id TEXT NOT NULL REFERENCES operations(operation_id),
  idempotency_key TEXT NOT NULL UNIQUE REFERENCES operations(idempotency_key),
  captured_at TEXT NOT NULL CHECK (length(captured_at) BETWEEN 1 AND 64),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 64)
);

CREATE INDEX IF NOT EXISTS actuals_task_captured_idx
  ON actuals (task_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS actuals_source_idx
  ON actuals (source, captured_at DESC);

CREATE TRIGGER IF NOT EXISTS actuals_no_update
BEFORE UPDATE ON actuals
BEGIN
  SELECT RAISE(ABORT, 'actuals are append-only');
END;

CREATE TRIGGER IF NOT EXISTS actuals_no_delete
BEFORE DELETE ON actuals
BEGIN
  SELECT RAISE(ABORT, 'actuals are append-only');
END;

-- An FK child guard prevents INSERT OR REPLACE from deleting the original row
-- even when SQLite recursive triggers are disabled.  D1 enforces foreign keys;
-- focused tests enable them explicitly as well.
CREATE TABLE IF NOT EXISTS actual_immutability_guards (
  actual_id TEXT PRIMARY KEY NOT NULL
    REFERENCES actuals(actual_id) ON DELETE RESTRICT
);

INSERT OR IGNORE INTO actual_immutability_guards (actual_id)
SELECT actual_id FROM actuals;

CREATE TRIGGER IF NOT EXISTS actuals_create_immutability_guard
AFTER INSERT ON actuals
BEGIN
  INSERT OR IGNORE INTO actual_immutability_guards (actual_id) VALUES (NEW.actual_id);
END;

CREATE TRIGGER IF NOT EXISTS actual_guards_no_update
BEFORE UPDATE ON actual_immutability_guards
BEGIN
  SELECT RAISE(ABORT, 'actual immutability guards are append-only');
END;

CREATE TRIGGER IF NOT EXISTS actual_guards_no_delete
BEFORE DELETE ON actual_immutability_guards
BEGIN
  SELECT RAISE(ABORT, 'actual immutability guards are append-only');
END;

-- AI output is a proposal, never an external mutation.  Its status is kept as
-- text because the canonical design does not define a closed proposal enum.
CREATE TABLE IF NOT EXISTS proposals (
  proposal_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(proposal_id) BETWEEN 1 AND 256),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
  status TEXT NOT NULL CHECK (length(status) BETWEEN 1 AND 64),
  source_revision INTEGER NOT NULL CHECK (source_revision BETWEEN 0 AND 9007199254740991),
  payload_json TEXT NOT NULL
    CHECK (json_valid(payload_json) AND length(payload_json) <= 65536),
  operation_id TEXT NOT NULL REFERENCES operations(operation_id),
  idempotency_key TEXT NOT NULL UNIQUE REFERENCES operations(idempotency_key),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 64),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 1 AND 64)
);

CREATE INDEX IF NOT EXISTS proposals_status_idx
  ON proposals (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS proposals_source_revision_idx
  ON proposals (source_revision, updated_at DESC);

-- A decision is an immutable ledger entry against the proposal revision that
-- was reviewed.  A later decision is a new row/operation, never an overwrite.
CREATE TABLE IF NOT EXISTS proposal_decisions (
  decision_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(decision_id) BETWEEN 1 AND 256),
  proposal_id TEXT NOT NULL REFERENCES proposals(proposal_id),
  proposal_revision INTEGER NOT NULL CHECK (proposal_revision BETWEEN 0 AND 9007199254740991),
  decision TEXT NOT NULL CHECK (length(decision) BETWEEN 1 AND 64),
  payload_json TEXT NOT NULL
    CHECK (json_valid(payload_json) AND length(payload_json) <= 65536),
  operation_id TEXT NOT NULL REFERENCES operations(operation_id),
  idempotency_key TEXT NOT NULL UNIQUE REFERENCES operations(idempotency_key),
  decided_at TEXT NOT NULL CHECK (length(decided_at) BETWEEN 1 AND 64),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 64)
);

CREATE INDEX IF NOT EXISTS proposal_decisions_proposal_idx
  ON proposal_decisions (proposal_id, proposal_revision, decided_at DESC);
CREATE INDEX IF NOT EXISTS proposal_decisions_decision_idx
  ON proposal_decisions (decision, decided_at DESC);

-- Sync metadata records the directed source -> projection relationship.  The
-- values are deliberately opaque names; only the explicitly designed health
-- states are constrained here.
CREATE TABLE IF NOT EXISTS sync_state (
  sync_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(sync_id) BETWEEN 1 AND 256),
  source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 128),
  projection TEXT NOT NULL CHECK (length(projection) BETWEEN 1 AND 128),
  status TEXT NOT NULL CHECK (status IN ('success', 'partial', 'stale', 'missing', 'conflict')),
  source_revision INTEGER CHECK (source_revision IS NULL OR source_revision BETWEEN 0 AND 9007199254740991),
  projection_revision INTEGER CHECK (projection_revision IS NULL OR projection_revision BETWEEN 0 AND 9007199254740991),
  metadata_json TEXT
    CHECK (metadata_json IS NULL OR (json_valid(metadata_json) AND length(metadata_json) <= 65536)),
  operation_id TEXT NOT NULL REFERENCES operations(operation_id),
  idempotency_key TEXT NOT NULL UNIQUE REFERENCES operations(idempotency_key),
  last_synced_at TEXT,
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 1 AND 64),
  UNIQUE (source, projection)
);

CREATE INDEX IF NOT EXISTS sync_state_status_idx
  ON sync_state (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS sync_state_source_idx
  ON sync_state (source, projection);

-- Transactional outbox is D1-owned.  Publishing is outside the transaction;
-- published_at is set only after the dispatcher confirms delivery.
CREATE TABLE IF NOT EXISTS outbox (
  outbox_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(outbox_id) BETWEEN 1 AND 256),
  operation_id TEXT NOT NULL REFERENCES operations(operation_id),
  idempotency_key TEXT NOT NULL UNIQUE REFERENCES operations(idempotency_key),
  topic TEXT NOT NULL CHECK (length(topic) BETWEEN 1 AND 128),
  payload_json TEXT NOT NULL
    CHECK (json_valid(payload_json) AND length(payload_json) <= 65536),
  available_at TEXT NOT NULL CHECK (length(available_at) BETWEEN 1 AND 64),
  published_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 9007199254740991),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 64)
);

CREATE INDEX IF NOT EXISTS outbox_pending_idx
  ON outbox (published_at, available_at, created_at);

-- Audit is append-only and stores bounded metadata, not request/payload bodies.
CREATE TABLE IF NOT EXISTS audit_log (
  audit_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(audit_id) BETWEEN 1 AND 256),
  operation_id TEXT NOT NULL REFERENCES operations(operation_id),
  idempotency_key TEXT NOT NULL UNIQUE REFERENCES operations(idempotency_key),
  entity_type TEXT NOT NULL CHECK (length(entity_type) BETWEEN 1 AND 128),
  entity_id TEXT NOT NULL CHECK (length(entity_id) BETWEEN 1 AND 256),
  entity_revision INTEGER NOT NULL CHECK (entity_revision BETWEEN 0 AND 9007199254740991),
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 128),
  outcome TEXT NOT NULL CHECK (length(outcome) BETWEEN 1 AND 64),
  authority TEXT NOT NULL CHECK (authority IN ('canonical', 'projection', 'generated', 'archive')),
  metadata_json TEXT NOT NULL
    CHECK (json_valid(metadata_json) AND length(metadata_json) <= 65536),
  occurred_at TEXT NOT NULL CHECK (length(occurred_at) BETWEEN 1 AND 64)
);

CREATE INDEX IF NOT EXISTS audit_log_entity_idx
  ON audit_log (entity_type, entity_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_operation_idx
  ON audit_log (operation_id, occurred_at DESC);

CREATE TRIGGER IF NOT EXISTS audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

-- As above, this child FK guard blocks INSERT OR REPLACE from deleting an
-- audit row regardless of recursive-trigger settings.
CREATE TABLE IF NOT EXISTS audit_immutability_guards (
  audit_id TEXT PRIMARY KEY NOT NULL
    REFERENCES audit_log(audit_id) ON DELETE RESTRICT
);

INSERT OR IGNORE INTO audit_immutability_guards (audit_id)
SELECT audit_id FROM audit_log;

CREATE TRIGGER IF NOT EXISTS audit_log_create_immutability_guard
AFTER INSERT ON audit_log
BEGIN
  INSERT OR IGNORE INTO audit_immutability_guards (audit_id) VALUES (NEW.audit_id);
END;

CREATE TRIGGER IF NOT EXISTS audit_guards_no_update
BEFORE UPDATE ON audit_immutability_guards
BEGIN
  SELECT RAISE(ABORT, 'audit immutability guards are append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_guards_no_delete
BEFORE DELETE ON audit_immutability_guards
BEGIN
  SELECT RAISE(ABORT, 'audit immutability guards are append-only');
END;
