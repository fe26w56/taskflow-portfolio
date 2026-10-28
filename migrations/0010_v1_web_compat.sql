-- Web compatibility metadata; never user tasks or recurrence occurrences.
CREATE TABLE v1_web_heads (
 owner_id TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
 metric INTEGER NOT NULL, tick INTEGER NOT NULL, last_operation_id TEXT,
 extra_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(extra_json)),
 PRIMARY KEY(owner_id,id)
);
CREATE TRIGGER v1_web_heads_version BEFORE UPDATE ON v1_web_heads
 WHEN NEW.tick != OLD.tick + 1
 BEGIN SELECT RAISE(ABORT,'VERSION_CONFLICT'); END;
-- Used transiently inside a batch to abort on source changes after planning.
CREATE TABLE v1_web_guards (id TEXT PRIMARY KEY, ok INTEGER CONSTRAINT web_guard CHECK(ok=1));
CREATE TABLE v1_web_series_aliases (
 owner_id TEXT NOT NULL, master_id TEXT NOT NULL, rule_id TEXT NOT NULL REFERENCES v1_recurrence_rules(id),
 task_id TEXT REFERENCES v1_tasks(id),
 PRIMARY KEY(owner_id,master_id), UNIQUE(owner_id,rule_id)
);
CREATE TABLE v1_sections (
 owner_id TEXT NOT NULL, area TEXT NOT NULL CHECK(area IN ('private','work')),
 name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 64), sort_order INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, PRIMARY KEY(owner_id,area,name)
);
CREATE TABLE v1_web_settings (
 owner_id TEXT NOT NULL, id TEXT NOT NULL CHECK(id IN ('sys_wake','sys_sleep')),
 task_json TEXT NOT NULL CHECK(json_valid(task_json)), version INTEGER NOT NULL,
 PRIMARY KEY(owner_id,id)
);
CREATE TRIGGER v1_web_settings_version BEFORE UPDATE ON v1_web_settings
 WHEN NEW.version != OLD.version + 1
 BEGIN SELECT RAISE(ABORT,'VERSION_CONFLICT'); END;
CREATE TABLE v1_web_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT NOT NULL, operation_request_id TEXT NOT NULL,
 actor TEXT NOT NULL CHECK(json_valid(actor)), payload TEXT NOT NULL CHECK(json_valid(payload)), created_at TEXT NOT NULL
);
CREATE TRIGGER v1_web_events_no_update BEFORE UPDATE ON v1_web_events BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE TRIGGER v1_web_events_no_delete BEFORE DELETE ON v1_web_events BEGIN SELECT RAISE(ABORT,'append-only'); END;
