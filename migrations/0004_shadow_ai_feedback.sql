-- Append-only, content-free owner feedback for completed shadow AI jobs.
-- This table has no Task, Issue, Calendar, provider, or credential data.

CREATE TABLE IF NOT EXISTS shadow_ai_feedback_records (
  job_id TEXT PRIMARY KEY NOT NULL
    REFERENCES shadow_ai_evaluation_records(job_id) ON DELETE RESTRICT
    CHECK (length(job_id) BETWEEN 1 AND 128)
    CHECK (job_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
  task_id TEXT NOT NULL
    CHECK (length(task_id) BETWEEN 1 AND 128)
    CHECK (task_id GLOB '[1-9]*' AND task_id NOT GLOB '*[^0-9]*'),
  base_revision INTEGER NOT NULL
    CHECK (base_revision BETWEEN 1 AND 9007199254740991),
  proposal_hash TEXT NOT NULL
    CHECK (length(proposal_hash) = 64 AND proposal_hash NOT GLOB '*[^0-9a-f]*'),
  decision TEXT NOT NULL
    CHECK (decision IN ('accepted', 'edited', 'rejected')),
  edited_fields_json TEXT NOT NULL
    CHECK (json_valid(edited_fields_json) AND json_type(edited_fields_json) = 'array')
    CHECK (length(edited_fields_json) <= 65536),
  reason_codes_json TEXT NOT NULL
    CHECK (json_valid(reason_codes_json) AND json_type(reason_codes_json) = 'array')
    CHECK (length(reason_codes_json) <= 65536),
  labeled_at TEXT NOT NULL CHECK (length(labeled_at) BETWEEN 1 AND 64),
  reviewer_scope TEXT NOT NULL CHECK (reviewer_scope = 'owner'),
  CHECK (
    (decision = 'accepted'
      AND json_array_length(edited_fields_json) = 0
      AND json_array_length(reason_codes_json) = 0)
    OR (decision = 'edited'
      AND edited_fields_json = '["decomposition"]'
      AND json_array_length(reason_codes_json) = 0)
    OR (decision = 'rejected'
      AND json_array_length(edited_fields_json) = 0
      AND reason_codes_json = '["not_useful"]')
  )
);

CREATE INDEX IF NOT EXISTS shadow_ai_feedback_records_task_idx
  ON shadow_ai_feedback_records (task_id, base_revision, labeled_at DESC);

CREATE TRIGGER IF NOT EXISTS shadow_ai_feedback_records_no_update
BEFORE UPDATE ON shadow_ai_feedback_records
BEGIN
  SELECT RAISE(ABORT, 'shadow_ai_feedback_records are append-only');
END;

CREATE TRIGGER IF NOT EXISTS shadow_ai_feedback_records_no_delete
BEFORE DELETE ON shadow_ai_feedback_records
BEGIN
  SELECT RAISE(ABORT, 'shadow_ai_feedback_records are append-only');
END;
