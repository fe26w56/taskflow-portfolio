-- Bounded, read-only indexes for the actual-history repository.
--
-- This migration is intentionally schema-only: it does not backfill, rewrite,
-- or delete existing rows.  The actuals table remains append-only under the
-- triggers from 0001_foundation.sql.

-- Keep actuals ordered for the repository's ROW_NUMBER() window.  The partial
-- predicate narrows the index to positive measurements; the repository keeps
-- the source deny-list in the query and at the output boundary.
CREATE INDEX IF NOT EXISTS actuals_history_latest_idx
  ON actuals (task_id, captured_at DESC, actual_id DESC, active_min, source)
  WHERE active_min >= 1;

-- Restrict the projection side to closed, leaf, projection-authority rows and
-- put the requested family first so the bounded family read can use an
-- expression index before joining on source_id.  CASE expressions match the
-- repository query's malformed-JSON-safe predicates.
CREATE INDEX IF NOT EXISTS task_projections_history_family_idx
  ON task_projections (
    CASE
      WHEN json_valid(payload_json)
      THEN json_extract(payload_json, '$.task_family')
      ELSE NULL
    END,
    source_id,
    source_revision DESC
  )
  WHERE source_authority = 'projection'
    AND CASE
          WHEN json_valid(payload_json)
          THEN json_extract(payload_json, '$.state')
          ELSE NULL
        END = 'closed'
    AND CASE
          WHEN json_valid(payload_json)
          THEN json_type(payload_json, '$.subtasks')
          ELSE NULL
        END = 'array'
    AND CASE
          WHEN json_valid(payload_json)
          THEN json_array_length(payload_json, '$.subtasks')
          ELSE NULL
        END = 0;
