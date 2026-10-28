-- Credential-free persistence for bounded shadow AI jobs.
-- Shadow output is observational only; this schema has no Task/Issue writer.

CREATE TABLE IF NOT EXISTS shadow_ai_jobs (
  job_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(job_id) BETWEEN 1 AND 128),
  task_id TEXT NOT NULL
    CHECK (length(task_id) BETWEEN 1 AND 128),
  base_revision INTEGER NOT NULL
    CHECK (base_revision BETWEEN 1 AND 9007199254740991),
  input_hash TEXT NOT NULL
    CHECK (length(input_hash) = 64 AND input_hash NOT GLOB '*[^0-9a-f]*'),
  prompt_version TEXT NOT NULL
    CHECK (length(prompt_version) BETWEEN 1 AND 128),
  model_id TEXT NOT NULL
    CHECK (length(model_id) BETWEEN 1 AND 128),
  status TEXT NOT NULL
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'stale')),
  attempt INTEGER NOT NULL
    CHECK (attempt IN (0, 1)),
  input_json TEXT NOT NULL
    CHECK (json_valid(input_json) AND json_type(input_json) = 'object' AND length(input_json) <= 65536),
  observation_json TEXT
    CHECK (observation_json IS NULL OR (json_valid(observation_json) AND json_type(observation_json) = 'object' AND length(observation_json) <= 65536)),
  error_code TEXT
    CHECK (error_code IS NULL OR (length(error_code) BETWEEN 1 AND 128 AND error_code NOT GLOB '*[^A-Za-z0-9._:-]*')),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 64),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 1 AND 64),
  CHECK (
    (status = 'queued' AND attempt = 0 AND observation_json IS NULL AND error_code IS NULL)
    OR (status = 'running' AND attempt = 1 AND observation_json IS NULL AND error_code IS NULL)
    OR (status = 'succeeded' AND attempt = 1 AND observation_json IS NOT NULL AND error_code IS NULL)
    OR (status IN ('failed', 'stale') AND attempt = 1 AND observation_json IS NULL AND error_code IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS shadow_ai_jobs_task_idx
  ON shadow_ai_jobs (task_id, base_revision, updated_at DESC);
CREATE INDEX IF NOT EXISTS shadow_ai_jobs_status_idx
  ON shadow_ai_jobs (status, updated_at DESC);

-- Only the content-free, unlabeled evaluation record is retained. Labels are
-- supplied by a separate pure path and are never written by this store.
CREATE TABLE IF NOT EXISTS shadow_ai_evaluation_records (
  job_id TEXT PRIMARY KEY NOT NULL
    REFERENCES shadow_ai_jobs(job_id) ON DELETE RESTRICT,
  task_id TEXT NOT NULL
    CHECK (length(task_id) BETWEEN 1 AND 128),
  base_revision INTEGER NOT NULL
    CHECK (base_revision BETWEEN 1 AND 9007199254740991),
  proposal_hash TEXT NOT NULL
    CHECK (length(proposal_hash) = 64 AND proposal_hash NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL CHECK (status = 'unlabeled'),
  edited_fields_json TEXT NOT NULL
    CHECK (json_valid(edited_fields_json) AND json_type(edited_fields_json) = 'array' AND length(edited_fields_json) <= 65536),
  reason_codes_json TEXT NOT NULL
    CHECK (json_valid(reason_codes_json) AND json_type(reason_codes_json) = 'array' AND length(reason_codes_json) <= 65536),
  recorded_at TEXT NOT NULL CHECK (length(recorded_at) BETWEEN 1 AND 64)
);

CREATE INDEX IF NOT EXISTS shadow_ai_evaluation_records_task_idx
  ON shadow_ai_evaluation_records (task_id, base_revision, recorded_at DESC);

CREATE TRIGGER IF NOT EXISTS shadow_ai_evaluation_records_no_update
BEFORE UPDATE ON shadow_ai_evaluation_records
BEGIN
  SELECT RAISE(ABORT, 'shadow_ai_evaluation_records are append-only');
END;

CREATE TRIGGER IF NOT EXISTS shadow_ai_evaluation_records_no_delete
BEFORE DELETE ON shadow_ai_evaluation_records
BEGIN
  SELECT RAISE(ABORT, 'shadow_ai_evaluation_records are append-only');
END;
