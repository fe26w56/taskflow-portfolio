-- One repository per owner: the primary key deliberately matches the legacy contract.
CREATE TABLE v1_legacy_task_map (
  owner_id TEXT NOT NULL,
  legacy_issue_number INTEGER NOT NULL CHECK(legacy_issue_number > 0),
  task_id TEXT REFERENCES v1_tasks(id),
  recurrence_rule_id TEXT REFERENCES v1_recurrence_rules(id),
  repository TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  imported_at TEXT NOT NULL,
  PRIMARY KEY(owner_id, legacy_issue_number),
  CHECK(task_id IS NOT NULL OR recurrence_rule_id IS NOT NULL)
);
