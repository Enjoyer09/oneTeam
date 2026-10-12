-- Indexes on the foreign-key columns that are scanned on reads and on delete.
--
-- Each of these columns is a FK that the application filters on or that a
-- parent delete must check, but none had an index — so every such query was a
-- sequential scan of a table that grows with field activity:
--
--   store_tasks.template_id        — countStoreTasksForTemplate() (WHERE
--                                    template_id = $1) and the RESTRICT check
--                                    when a template is deleted.
--   task_evidences.submitted_by_id — countEvidencesForUser() and the per-user
--                                    join, plus the RESTRICT check when a user
--                                    is deleted (scans the growing evidence
--                                    table). task_evidences already indexes
--                                    store_task_id; this is the other FK.
--   audit_logs.actor_id            — the ON DELETE SET NULL fix-up when a user
--                                    is deleted scans the append-only, forever-
--                                    growing audit log.
--   notifications.store_task_id    — deleteStoreTaskRow() does
--                                    DELETE FROM notifications WHERE
--                                    store_task_id = $1; there is no FK, so
--                                    nothing created this index implicitly.
--
-- Plain (non-CONCURRENT) CREATE INDEX: the migration runner wraps each file in
-- a transaction, and CONCURRENTLY cannot run inside one. The brief lock is
-- acceptable for these table sizes and is what every other index here uses.
-- IF NOT EXISTS keeps the file idempotent and safe to re-run.

CREATE INDEX IF NOT EXISTS store_tasks_template_id_idx
    ON store_tasks (template_id);

CREATE INDEX IF NOT EXISTS task_evidences_submitted_by_idx
    ON task_evidences (submitted_by_id);

CREATE INDEX IF NOT EXISTS audit_logs_actor_id_idx
    ON audit_logs (actor_id);

CREATE INDEX IF NOT EXISTS notifications_store_task_id_idx
    ON notifications (store_task_id);
