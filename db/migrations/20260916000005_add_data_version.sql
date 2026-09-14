-- oneTeam — cross-replica change signal
-- ============================================================================
--
-- WHY THIS EXISTS
-- ---------------
-- The application reads from in-memory arrays that are hydrated once at
-- start-up and then updated in place by its own writes. That is fast and it is
-- correct for a single process. It is silently wrong for two: replica B
-- hydrates at boot and never learns about anything replica A wrote afterwards.
-- Nothing fails — B simply answers with yesterday's data, forever, while
-- reporting a healthy status.
--
-- The fix is a cheap way for a replica to notice that the data moved. This
-- migration provides it: one row holding a counter, and a trigger on every
-- table the snapshot reads from that increments it.
--
-- WHY A TRIGGER RATHER THAN APPLICATION CODE
-- ------------------------------------------
-- The obvious alternative is for each write path to bump the counter itself.
-- That is the same shape of mistake as the `mobile_device_id` column that was
-- written but never read: it works until someone adds a write path and forgets,
-- and the symptom is a replica that is quietly stale rather than an error.
--
-- A trigger cannot be forgotten. It is a property of the table changing, not of
-- the code that changed it — including changes made by psql, by a migration, or
-- by a future service that has never heard of this counter.
--
-- STATEMENT-LEVEL, DELIBERATELY
-- -----------------------------
-- `FOR EACH STATEMENT` rather than `FOR EACH ROW`, so seeding ten thousand rows
-- bumps the counter once instead of ten thousand times. The reader only needs to
-- know "something changed"; how much changed is not information it can use.
--
-- WHAT IT COSTS
-- -------------
-- One small UPDATE per writing statement, and one row read per polling interval
-- per replica. The reload that follows a change is the expensive part, and it is
-- bounded by the polling interval rather than by the write rate: a burst of
-- writes still produces at most one reload per tick. That bound is what makes
-- this safe to leave on.

-- ---------------------------------------------------------------------------
-- The counter: exactly one row, enforced by the primary key and the CHECK.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS data_version (
    id BOOLEAN PRIMARY KEY DEFAULT TRUE,
    version BIGINT NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- A second row is not a thing that can mean anything here, so it is not
    -- merely discouraged, it is impossible.
    CONSTRAINT data_version_single_row CHECK (id)
);

INSERT INTO data_version (id, version)
VALUES (TRUE, 1)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- The trigger function.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION oneteam_bump_data_version() RETURNS trigger AS $$
BEGIN
    UPDATE data_version
       SET version = version + 1,
           updated_at = now()
     WHERE id = TRUE;

    -- An AFTER trigger's return value is ignored; NULL is the honest answer for
    -- a statement-level trigger that changes nothing about the row it fired on.
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Attach it to every table the in-memory snapshot reads from.
-- ---------------------------------------------------------------------------
-- DROP-then-CREATE rather than `CREATE TRIGGER IF NOT EXISTS`, which PostgreSQL
-- does not have before 14. This file is re-run on every start-up by the
-- migration runner's baseline pass, so it has to be idempotent by construction.
--
-- The list must match what `loadAll` reads. A table in the snapshot but not in
-- this list is a table whose changes never propagate — the silent-staleness bug
-- this migration exists to remove.
DO $$
DECLARE
    target TEXT;
BEGIN
    FOREACH target IN ARRAY ARRAY[
        'users',
        'regions',
        'stores',
        'campaigns',
        'task_templates',
        'store_tasks',
        'task_evidences',
        'audit_logs'
    ]
    LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS oneteam_version_bump ON %I', target);
        EXECUTE format(
            'CREATE TRIGGER oneteam_version_bump '
            'AFTER INSERT OR UPDATE OR DELETE ON %I '
            'FOR EACH STATEMENT EXECUTE FUNCTION oneteam_bump_data_version()',
            target
        );
    END LOOP;
END;
$$;
