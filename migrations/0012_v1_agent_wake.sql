-- D1 runs migrations in a transaction. Defer FK checks while replacing CHECK constraints.
-- Preserve every row/version/history value; foreign_keys stays ON throughout.
-- Reinsert into the original name (rather than rename a prefilled replacement)
-- so SQLite resolves deferred child references before COMMIT.
PRAGMA defer_foreign_keys=ON;
DROP TRIGGER v1_progress_agent;
CREATE TABLE v1_tasks_wake_backup AS SELECT * FROM v1_tasks;
DROP TABLE v1_tasks;
CREATE TABLE v1_tasks (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>=1),
 title TEXT NOT NULL CHECK(length(trim(title))>0), notes TEXT NOT NULL DEFAULT '',
 area TEXT NOT NULL CHECK(area IN ('private','work')), project_key TEXT,
 status TEXT NOT NULL CHECK(status IN ('todo','doing','waiting','done','cancelled')),
 priority TEXT NOT NULL CHECK(priority IN ('low','normal','high','urgent')),
 planned_start_at TEXT, deadline_date TEXT, deadline_at TEXT,
 timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo', estimate_minutes INTEGER CHECK(estimate_minutes>=0),
 definition_of_done TEXT, completed_at TEXT,
 completion_evidence TEXT CHECK(completion_evidence IS NULL OR json_valid(completion_evidence)),
 cancel_reason TEXT, executor_kind TEXT NOT NULL CHECK(executor_kind IN ('self','agent')),
 source_ref TEXT, context_refs TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(context_refs) AND json_type(context_refs)='array'),
 series_id TEXT REFERENCES v1_recurrence_rules(id), occurrence_key TEXT, legacy_issue_number INTEGER,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT,
 assigned_agent TEXT,
 requester_ref TEXT,
 accepted_at TEXT,
 waiting_kind TEXT CHECK(waiting_kind IN ('human','agent','external','dependency')),
 waiting_on_ref TEXT,
 blocker_summary TEXT CHECK(blocker_summary IS NULL OR length(blocker_summary) BETWEEN 1 AND 2000),
 next_check_at TEXT,
 next_check_by TEXT,
 CHECK(priority!='urgent' OR executor_kind='agent'),
 CHECK(deadline_date IS NULL OR deadline_at IS NULL), UNIQUE(series_id, occurrence_key)
);
-- Update by identity, NEVER WHERE version=expected_version. NEW.version carries expected+1.
-- Thus stale writers hit this trigger and abort the entire D1 batch, rather than no-op.
CREATE TRIGGER v1_tasks_version BEFORE UPDATE ON v1_tasks
 WHEN NEW.version != OLD.version + 1
 BEGIN SELECT RAISE(ABORT,'VERSION_CONFLICT'); END;
CREATE INDEX v1_tasks_list ON v1_tasks(owner_id,created_at,id);
CREATE INDEX v1_tasks_filters ON v1_tasks(owner_id,status,area,project_key);
CREATE INDEX v1_tasks_due_date ON v1_tasks(owner_id,deadline_date);
CREATE INDEX v1_tasks_due_at ON v1_tasks(owner_id,deadline_at);
CREATE UNIQUE INDEX v1_tasks_owner_identity ON v1_tasks(owner_id,id);
CREATE INDEX v1_tasks_agent ON v1_tasks(owner_id,assigned_agent,accepted_at,created_at,id) WHERE executor_kind='agent' AND archived_at IS NULL;
CREATE INDEX v1_tasks_waiting ON v1_tasks(owner_id,waiting_kind,created_at,id) WHERE executor_kind='agent' AND archived_at IS NULL;
CREATE INDEX v1_tasks_next_check ON v1_tasks(owner_id,next_check_at) WHERE executor_kind='agent' AND archived_at IS NULL;

INSERT INTO v1_tasks SELECT * FROM v1_tasks_wake_backup;
DROP TABLE v1_tasks_wake_backup;

CREATE TABLE v1_task_progress_wake_new (
 id TEXT PRIMARY KEY,
 task_id TEXT NOT NULL,
 owner_id TEXT NOT NULL,
 client_id TEXT NOT NULL,
 request_id TEXT NOT NULL,
 actor TEXT NOT NULL CHECK(json_valid(actor)),
 reported_agent TEXT NOT NULL CHECK(length(trim(reported_agent))>0),
 attribution TEXT NOT NULL CHECK(attribution IN ('self','proxy','system')),
 summary TEXT NOT NULL CHECK(length(trim(summary))>0 AND length(summary)<=2000),
 source_ref TEXT,
 created_at TEXT NOT NULL,
 FOREIGN KEY(owner_id,task_id) REFERENCES v1_tasks(owner_id,id),
 UNIQUE(owner_id,client_id,request_id)
);
INSERT INTO v1_task_progress_wake_new SELECT * FROM v1_task_progress;
DROP TABLE v1_task_progress;
ALTER TABLE v1_task_progress_wake_new RENAME TO v1_task_progress;
CREATE INDEX v1_progress_task ON v1_task_progress(owner_id,task_id,created_at,id);
CREATE TRIGGER v1_progress_no_update BEFORE UPDATE ON v1_task_progress BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE TRIGGER v1_progress_no_delete BEFORE DELETE ON v1_task_progress BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE TRIGGER v1_progress_agent BEFORE INSERT ON v1_task_progress
 WHEN NOT EXISTS(SELECT 1 FROM v1_tasks WHERE owner_id=NEW.owner_id AND id=NEW.task_id AND executor_kind='agent' AND series_id IS NULL AND (archived_at IS NULL OR NEW.attribution='system'))
 BEGIN SELECT RAISE(ABORT,'AI_PROGRESS_TARGET_INVALID'); END;

-- Immutable admission decisions. 'queued' reserves capacity before any network I/O.
-- Failed and interrupted sends consume capacity too; skipped decisions do not.
CREATE TABLE v1_agent_wake_attempts (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL,
 task_id TEXT NOT NULL,
 bot TEXT NOT NULL,
 client_id TEXT NOT NULL,
 request_id TEXT NOT NULL,
 reason TEXT NOT NULL CHECK(reason IN ('urgent','wake_now')),
 disposition TEXT NOT NULL CHECK(disposition IN ('queued','skipped:disabled','skipped:unconfigured','skipped:duplicate','skipped:rate_limited')),
 created_at TEXT NOT NULL,
 FOREIGN KEY(owner_id,task_id) REFERENCES v1_tasks(owner_id,id),
 UNIQUE(owner_id,client_id,request_id)
);
CREATE INDEX v1_wake_task_bot ON v1_agent_wake_attempts(owner_id,task_id,bot,created_at) WHERE disposition='queued';
CREATE INDEX v1_wake_bot ON v1_agent_wake_attempts(bot,created_at) WHERE disposition='queued';
CREATE TRIGGER v1_wake_no_update BEFORE UPDATE ON v1_agent_wake_attempts BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE TRIGGER v1_wake_no_delete BEFORE DELETE ON v1_agent_wake_attempts BEGIN SELECT RAISE(ABORT,'append-only'); END;
