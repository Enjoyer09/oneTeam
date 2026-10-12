-- Down: reverse of 20261011000001_add_fk_indexes.
--
-- Drops the four FK-column indexes. Dropping an index removes only the access
-- path, never a row, so this rollback loses no data — the queries just return
-- to a sequential scan. IF EXISTS keeps it safe to run even if an index was
-- never created.
DROP INDEX IF EXISTS store_tasks_template_id_idx;
DROP INDEX IF EXISTS task_evidences_submitted_by_idx;
DROP INDEX IF EXISTS audit_logs_actor_id_idx;
DROP INDEX IF EXISTS notifications_store_task_id_idx;
