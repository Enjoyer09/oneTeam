-- ============================================================================
-- oneTeam migration — protect audit evidence from cascade deletion
-- File: db/migrations/20260920000009_evidence_fk_restrict.sql
-- ============================================================================
--
-- WHAT THIS CHANGES
-- -----------------
-- `task_evidences.store_task_id` was declared `ON DELETE CASCADE`. Deleting a
-- store task therefore destroyed every photo, GPS reading and checklist answer
-- filed against it — the anti-fraud record the platform exists to keep.
--
-- The application already refuses to delete a task that has evidence
-- (`EnterpriseDatabase.deleteTask` counts evidence from the database, not from
-- the poll-behind in-memory copy, and returns HAS_EVIDENCE). But that check is
-- a pre-check with a race: an audit submitted between the count and the delete
-- would still be cascaded away, silently. A `CASCADE` on compliance data is a
-- loaded gun that only the application's good behaviour keeps unfired.
--
-- This migration moves the guarantee into the database. `RESTRICT` means the
-- delete raises rather than cascading, so the race that used to destroy an
-- evidence row now fails loudly and the task is left in place — the same "safe
-- side to fail on" the delete path already documents. It also matches the
-- sibling foreign keys `store_tasks.store_id` and `store_tasks.template_id`,
-- which are already `ON DELETE RESTRICT` for the same reason.
--
-- WHY THE CONSTRAINT NAME IS LOOKED UP RATHER THAN HARDCODED
-- ---------------------------------------------------------
-- The constraint was created inline by `CREATE TABLE`, so PostgreSQL named it
-- automatically (`task_evidences_store_task_id_fkey` by convention). Rather
-- than trust that name, the block below finds whatever foreign key on
-- `task_evidences.store_task_id` currently points at `store_tasks` and rebuilds
-- it, so the migration is correct even if the name ever differed.
--
-- Idempotent: if a RESTRICT constraint is already in place the block still
-- rebuilds it identically, which is a no-op in effect. Safe to re-run.

DO $$
DECLARE
    fk_name TEXT;
BEGIN
    -- Only act if the table exists — a database that has not yet had the
    -- baseline applied has nothing to alter, and this migration must not fail
    -- there.
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'task_evidences'
    ) THEN
        RAISE NOTICE 'task_evidences does not exist yet; skipping FK hardening.';
        RETURN;
    END IF;

    SELECT con.conname
      INTO fk_name
      FROM pg_constraint con
      JOIN pg_class rel      ON rel.oid = con.conrelid
      JOIN pg_namespace nsp  ON nsp.oid = rel.relnamespace
      JOIN pg_attribute att  ON att.attrelid = con.conrelid
                            AND att.attnum = con.conkey[1]
     WHERE con.contype = 'f'
       AND nsp.nspname = 'public'
       AND rel.relname = 'task_evidences'
       AND att.attname = 'store_task_id'
     LIMIT 1;

    IF fk_name IS NULL THEN
        RAISE NOTICE 'No foreign key on task_evidences.store_task_id found; nothing to change.';
        RETURN;
    END IF;

    EXECUTE format('ALTER TABLE task_evidences DROP CONSTRAINT %I', fk_name);

    ALTER TABLE task_evidences
        ADD CONSTRAINT task_evidences_store_task_id_fkey
        FOREIGN KEY (store_task_id) REFERENCES store_tasks (id) ON DELETE RESTRICT;
END
$$;
