-- ============================================================================
-- MIGRATION: 20260914000003_add_mobile_device_id.sql
-- Description: Give the mobile field client an identity key, alongside the
--              Telegram chat id the bot already uses.
-- ============================================================================
--
-- APPLIED AUTOMATICALLY
-- ---------------------
-- This file is not something an operator has to run. `packages/database/src/
-- migrations.ts` applies every `db/migrations/*.sql` in filename order when the
-- API starts, and records each one in `schema_migrations`.
--
-- That mechanism exists because of this exact file. The first version of it was
-- written, committed, and then never applied to the database the code actually
-- ran against: the column was absent, `upsertDeviceUser` failed into a log line
-- nobody was reading, and a bound device existed in memory and nowhere else. A
-- migration that only exists as a file is a wish.
--
-- To apply it by hand instead — for a database the API never boots against —
-- run: psql -f db/migrations/20260914000003_add_mobile_device_id.sql
-- ============================================================================
--
-- WHY
-- ---
-- `users.telegram_chat_id` is how the chat channel names the person acting. The
-- mobile client is a second channel and needs its own key: a device, not a chat.
-- Both keys live on the same row because they are two names for one person, and
-- the anti-fraud rules (`canUserAccessTask`, the geofence, the checklist) are
-- written against the person rather than against the channel.
--
-- This is what lets the mobile client read real stores and real tasks instead of
-- the hardcoded pair it used to render.
--
-- SAFE TO RE-RUN
-- --------------
-- The column and the index are both created conditionally, so applying this to a
-- database that already has them is a no-op.
--
-- A NULLABLE COLUMN IS CORRECT HERE
-- ---------------------------------
-- Every existing user is Telegram-only and must stay valid, so the column cannot
-- be NOT NULL. Uniqueness still holds where it matters: a unique index treats
-- NULLs as distinct in PostgreSQL, so any number of chat-only users coexist while
-- no two users can share a device.
-- ============================================================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
        AND table_name = 'users'
        AND column_name = 'mobile_device_id'
    ) THEN
        ALTER TABLE public.users ADD COLUMN mobile_device_id VARCHAR(255);
    END IF;
END $$;

-- `ON CONFLICT (mobile_device_id)` in `upsertDeviceUser` requires this index to
-- exist; without it the upsert fails and the bind is only kept in memory.
--
-- It also requires the *predicate* to be repeated in the statement —
-- `ON CONFLICT (mobile_device_id) WHERE mobile_device_id IS NOT NULL`. A bare
-- column list only infers a total unique index, and PostgreSQL answers
-- "there is no unique or exclusion constraint matching the ON CONFLICT
-- specification" for a partial one. That is not obvious from the index
-- definition, which looks like it covers the column, so it is written here and
-- in postgres.ts.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_mobile_device_id
    ON public.users(mobile_device_id)
    WHERE mobile_device_id IS NOT NULL;

COMMENT ON COLUMN public.users.mobile_device_id IS
    'Stable identifier of the mobile app installation bound to this user. One external key per channel; not an authentication factor.';
