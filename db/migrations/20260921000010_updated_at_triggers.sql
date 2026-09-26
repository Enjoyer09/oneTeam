-- ============================================================================
-- oneTeam migration — stamp updated_at from the database, not just the app
-- File: db/migrations/20260921000010_updated_at_triggers.sql
-- ============================================================================
--
-- WHAT THIS CHANGES
-- -----------------
-- `updated_at` was maintained entirely in application code: every UPDATE
-- statement in `postgres.ts` sets `updated_at = $n` by hand. That works only
-- for as long as every write goes through those statements and every one of
-- them remembers the column. A statement that forgets it — a hotfix run in
-- psql, a future query that updates one field, a bulk backfill — leaves
-- `updated_at` stale, and a stale "last modified" is worse than none: the
-- replica refresh loop and the portal timeline both trust it.
--
-- This installs a BEFORE UPDATE trigger that sets `updated_at = now()` on the
-- core business tables, so the value is correct no matter which code path (or
-- which human) issued the UPDATE. The application may keep setting the column;
-- the trigger simply guarantees the floor.
--
-- SCOPE
-- -----
-- Only the seven tables whose `updated_at` means "when this record last
-- changed": users, regions, stores, campaigns, task_templates, store_tasks,
-- task_evidences. Deliberately excluded:
--   * audit_logs        — append-only, has no updated_at.
--   * data_version      — updated_at is a version-bump marker set deliberately.
--   * bot_sessions      — has its own expiry/refresh semantics.
--   * notifications, device_tokens, panel_tokens — no updated_at column; they
--     track claimed_at / last_seen_at with their own meaning.
--
-- Idempotent: the function is CREATE OR REPLACE and each trigger is dropped
-- before it is created, so the migration is safe to re-run.

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
    tbl TEXT;
    targets TEXT[] := ARRAY[
        'users', 'regions', 'stores', 'campaigns',
        'task_templates', 'store_tasks', 'task_evidences'
    ];
BEGIN
    FOREACH tbl IN ARRAY targets LOOP
        -- Skip a table the baseline has not created yet, so this cannot fail on
        -- a fresh database that is still being built up.
        IF EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = tbl
        ) THEN
            EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', 'set_updated_at_' || tbl, tbl);
            EXECUTE format(
                'CREATE TRIGGER %I BEFORE UPDATE ON %I ' ||
                'FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
                'set_updated_at_' || tbl, tbl
            );
        END IF;
    END LOOP;
END
$$;
