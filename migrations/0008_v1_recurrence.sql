CREATE TRIGGER v1_recurrence_rules_version BEFORE UPDATE ON v1_recurrence_rules
 WHEN NEW.version != OLD.version + 1
 BEGIN SELECT RAISE(ABORT,'VERSION_CONFLICT'); END;
CREATE INDEX v1_recurrence_active ON v1_recurrence_rules(status,updated_at,id);
CREATE INDEX v1_recurrence_owner ON v1_recurrence_rules(owner_id,created_at,id);
CREATE TABLE v1_recurrence_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, rule_id TEXT NOT NULL REFERENCES v1_recurrence_rules(id),
 owner_id TEXT NOT NULL, operation_request_id TEXT NOT NULL, actor TEXT NOT NULL CHECK(json_valid(actor)),
 payload TEXT NOT NULL CHECK(json_valid(payload)), created_at TEXT NOT NULL
);
CREATE TRIGGER v1_recurrence_events_no_update BEFORE UPDATE ON v1_recurrence_events BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE TRIGGER v1_recurrence_events_no_delete BEFORE DELETE ON v1_recurrence_events BEGIN SELECT RAISE(ABORT,'append-only'); END;

CREATE TABLE v1_recurrence_generation (
 rule_id TEXT PRIMARY KEY REFERENCES v1_recurrence_rules(id), processed_at TEXT NOT NULL
);
