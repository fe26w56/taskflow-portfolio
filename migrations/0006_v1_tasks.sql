-- Isolated v1 source of truth; legacy tables are intentionally untouched.
CREATE TABLE v1_recurrence_rules (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
 template_json TEXT NOT NULL CHECK(json_valid(template_json)),
 kind TEXT NOT NULL CHECK(kind IN ('daily','weekdays','weekly','monthly')),
 weekdays TEXT CHECK(weekdays IS NULL OR (json_valid(weekdays) AND json_type(weekdays)='array')),
 month_day INTEGER CHECK(month_day BETWEEN 1 AND 31), starts_on TEXT NOT NULL, ends_on TEXT,
 timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo', status TEXT NOT NULL CHECK(status IN ('active','ended')),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE v1_tasks (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>=1),
 title TEXT NOT NULL CHECK(length(trim(title))>0), notes TEXT NOT NULL DEFAULT '',
 area TEXT NOT NULL CHECK(area IN ('private','work')), project_key TEXT,
 status TEXT NOT NULL CHECK(status IN ('todo','doing','waiting','done','cancelled')),
 priority TEXT NOT NULL CHECK(priority IN ('low','normal','high')),
 planned_start_at TEXT, deadline_date TEXT, deadline_at TEXT,
 timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo', estimate_minutes INTEGER CHECK(estimate_minutes>=0),
 definition_of_done TEXT, completed_at TEXT,
 completion_evidence TEXT CHECK(completion_evidence IS NULL OR json_valid(completion_evidence)),
 cancel_reason TEXT, executor_kind TEXT NOT NULL CHECK(executor_kind IN ('self','agent')),
 source_ref TEXT, context_refs TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(context_refs) AND json_type(context_refs)='array'),
 series_id TEXT REFERENCES v1_recurrence_rules(id), occurrence_key TEXT, legacy_issue_number INTEGER,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT,
 CHECK(deadline_date IS NULL OR deadline_at IS NULL), UNIQUE(series_id, occurrence_key)
);
-- Update by identity, NEVER WHERE version=expected_version. NEW.version carries expected+1.
-- Thus stale writers hit this trigger and abort the entire D1 batch, rather than no-op.
CREATE TRIGGER v1_tasks_version BEFORE UPDATE ON v1_tasks
 WHEN NEW.version != OLD.version + 1
 BEGIN SELECT RAISE(ABORT,'VERSION_CONFLICT'); END;
CREATE TABLE v1_task_checklist_items (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES v1_tasks(id), position INTEGER NOT NULL CHECK(position>=0),
 text TEXT NOT NULL CHECK(length(trim(text))>0), done INTEGER NOT NULL CHECK(done IN (0,1)), done_at TEXT,
 UNIQUE(task_id,position)
);
CREATE TABLE v1_task_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES v1_tasks(id), owner_id TEXT NOT NULL,
 operation_request_id TEXT NOT NULL,
 type TEXT NOT NULL CHECK(type IN ('created','updated','completed','reopened','cancelled','occurrence_skipped')),
 actor TEXT NOT NULL CHECK(json_valid(actor)), task_version INTEGER NOT NULL CHECK(task_version>=1),
 payload TEXT NOT NULL CHECK(json_valid(payload)), created_at TEXT NOT NULL
);
CREATE TRIGGER v1_events_no_update BEFORE UPDATE ON v1_task_events BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE TRIGGER v1_events_no_delete BEFORE DELETE ON v1_task_events BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE TABLE v1_operations (
 owner_id TEXT NOT NULL, client_id TEXT NOT NULL, request_id TEXT NOT NULL, op TEXT NOT NULL,
 input_hash TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','committed')),
 actor TEXT NOT NULL CHECK(json_valid(actor)), response_json TEXT CHECK(response_json IS NULL OR json_valid(response_json)),
 task_id TEXT REFERENCES v1_tasks(id) DEFERRABLE INITIALLY DEFERRED, created_at TEXT NOT NULL,
 UNIQUE(owner_id,client_id,request_id)
);
CREATE INDEX v1_tasks_list ON v1_tasks(owner_id,created_at,id);
CREATE INDEX v1_tasks_filters ON v1_tasks(owner_id,status,area,project_key);
CREATE INDEX v1_tasks_due_date ON v1_tasks(owner_id,deadline_date);
CREATE INDEX v1_tasks_due_at ON v1_tasks(owner_id,deadline_at);
CREATE INDEX v1_events_changes ON v1_task_events(owner_id,id);
CREATE INDEX v1_checklist_task ON v1_task_checklist_items(task_id,position);
