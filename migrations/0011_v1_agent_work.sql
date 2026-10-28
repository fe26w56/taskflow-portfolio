-- Additive AI work metadata; existing rows and task versions remain intact.
ALTER TABLE v1_tasks ADD COLUMN assigned_agent TEXT;
ALTER TABLE v1_tasks ADD COLUMN requester_ref TEXT;
ALTER TABLE v1_tasks ADD COLUMN accepted_at TEXT;
ALTER TABLE v1_tasks ADD COLUMN waiting_kind TEXT CHECK(waiting_kind IN ('human','agent','external','dependency'));
ALTER TABLE v1_tasks ADD COLUMN waiting_on_ref TEXT;
ALTER TABLE v1_tasks ADD COLUMN blocker_summary TEXT CHECK(blocker_summary IS NULL OR length(blocker_summary) BETWEEN 1 AND 2000);
ALTER TABLE v1_tasks ADD COLUMN next_check_at TEXT;
ALTER TABLE v1_tasks ADD COLUMN next_check_by TEXT;

CREATE UNIQUE INDEX v1_tasks_owner_identity ON v1_tasks(owner_id,id);
CREATE INDEX v1_tasks_agent ON v1_tasks(owner_id,assigned_agent,accepted_at,created_at,id) WHERE executor_kind='agent' AND archived_at IS NULL;
CREATE INDEX v1_tasks_waiting ON v1_tasks(owner_id,waiting_kind,created_at,id) WHERE executor_kind='agent' AND archived_at IS NULL;
CREATE INDEX v1_tasks_next_check ON v1_tasks(owner_id,next_check_at) WHERE executor_kind='agent' AND archived_at IS NULL;

CREATE TABLE v1_task_progress (
 id TEXT PRIMARY KEY,
 task_id TEXT NOT NULL,
 owner_id TEXT NOT NULL,
 client_id TEXT NOT NULL,
 request_id TEXT NOT NULL,
 actor TEXT NOT NULL CHECK(json_valid(actor)),
 reported_agent TEXT NOT NULL CHECK(length(trim(reported_agent))>0),
 attribution TEXT NOT NULL CHECK(attribution IN ('self','proxy')),
 summary TEXT NOT NULL CHECK(length(trim(summary))>0 AND length(summary)<=2000),
 source_ref TEXT,
 created_at TEXT NOT NULL,
 FOREIGN KEY(owner_id,task_id) REFERENCES v1_tasks(owner_id,id),
 UNIQUE(owner_id,client_id,request_id)
);
CREATE INDEX v1_progress_task ON v1_task_progress(owner_id,task_id,created_at,id);
CREATE TRIGGER v1_progress_no_update BEFORE UPDATE ON v1_task_progress BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE TRIGGER v1_progress_no_delete BEFORE DELETE ON v1_task_progress BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE TRIGGER v1_progress_agent BEFORE INSERT ON v1_task_progress
 WHEN NOT EXISTS(SELECT 1 FROM v1_tasks WHERE owner_id=NEW.owner_id AND id=NEW.task_id AND executor_kind='agent' AND series_id IS NULL AND archived_at IS NULL)
 BEGIN SELECT RAISE(ABORT,'AI_PROGRESS_TARGET_INVALID'); END;
