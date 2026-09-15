-- ============================================================================
-- MIGRATION: 20260918000007_add_bot_sessions.sql
-- Description: Let a Telegram chat's place in the guided field flow outlive the
--              bot process that collected it.
-- ============================================================================
--
-- WHY THIS TABLE EXISTS
-- ---------------------
-- The bot kept the flow in the grammy session, which lives in the process's own
-- memory. That is fine until the process is replaced — and it is replaced on
-- every deploy. A merchandiser who had answered two of three checklist questions
-- and was standing at the shelf with the camera open would come back to a bot
-- that had forgotten which task they were on, and the answers they had already
-- given were gone.
--
-- The failure is silent: the bot does not error, it just asks "which store are
-- you at?" again. The person is in a shop and has no way to tell the difference
-- between "the bot restarted" and "I did something wrong".
--
-- So the flow's position is stored. It is not business data — nothing is decided
-- by it, and losing it costs a minute of retyping rather than an audit — which is
-- why it is a separate table with a TTL instead of columns on `users`.
--
-- WHY THE DATABASE AND NOT A CACHE, AND WHY THROUGH THE API
-- ---------------------------------------------------------
-- The plan allows Redis. There is no Redis in this deployment, and adding one
-- would put a third service between the bot and its own state for a few hundred
-- bytes per active chat. Postgres is already here, already backed up, and already
-- the thing every other piece of this system agrees on.
--
-- The bot still does not connect to it. It goes through the Core API like every
-- other caller, because one data path is what keeps the bot and the panel from
-- disagreeing — the rule that this project has already paid for once, when the
-- bot talked to an in-memory Supabase mock and cheerfully reported "no tasks"
-- for every real store.
--
-- WHY A TTL AND WHY IT IS NOT DELETED ON READ
-- -------------------------------------------
-- `expires_at` is fifteen minutes ahead of the last write, and every write pushes
-- it forward. A flow that is being used never expires; one that was abandoned
-- does, which is the point — the alternative is rows that live forever and are
-- indistinguishable from live ones.
--
-- An expired row is *ignored*, not deleted, by the reader. Deleting on read makes
-- a `SELECT` a write, and two concurrent reads of the same expired row would
-- race. A periodic sweep removes rows that expired more than an hour ago, so the
-- table stays small without any single request being responsible for that.
--
-- WHY THE CHECKLIST QUESTIONS ARE STORED TOO
-- ------------------------------------------
-- Resuming has to know which question comes next, and `checklist_answers` alone
-- cannot say that: it records what was answered, not what was asked. Storing the
-- questions the flow was started with also means a resumed flow asks the same
-- questions in the same order, even if a supervisor edited the template in the
-- meantime — an audit should be one audit, not half of one and half of another.
--
-- WHAT IS DELIBERATELY NOT HERE
-- -----------------------------
-- No `data_version` trigger, for the same reason `panel_tokens` has none: nothing
-- reads this table into the in-memory snapshot, so a replica has no cached copy to
-- invalidate. Attaching the trigger would bump the shared change counter on every
-- button tap and make every replica reload for nothing.
--
-- No foreign key on `store_id` or `active_task_id`. A session may legitimately
-- point at a store or task that a supervisor deletes while the chat is mid-flow,
-- and a hard reference would make that deletion fail for a reason the supervisor
-- cannot see. The flow re-reads both before using them, and says so when they are
-- gone — which is the honest handling, and the one a foreign key would prevent.
--
-- No column for "the message the bot should edit". The first draft had one, and
-- it was removed rather than left empty: Telegram hands the bot the id of the
-- button that was tapped in `callbackQuery.message.message_id`, so the flow
-- already has it at the only moment it needs it. A stored copy would be a second
-- source of truth for the same fact, and the first thing to go stale.
-- ============================================================================

CREATE TABLE IF NOT EXISTS bot_sessions (
    -- TEXT rather than BIGINT to match `users.telegram_chat_id`, which is TEXT.
    -- Telegram ids are 52-bit and outgrow int4; keeping one representation means
    -- the chat can be joined to a person without a cast that might one day be
    -- wrong. `users.telegram_chat_id` is already UNIQUE, so the same value here
    -- identifies at most one person.
    chat_id             TEXT PRIMARY KEY,

    -- Nullable: a chat is asked for a store code before it is bound to anybody,
    -- so the session exists for a while with no user behind it. CASCADE, because
    -- a deleted person's half-finished flow is not something to keep.
    user_id             TEXT REFERENCES users (id) ON DELETE CASCADE,

    step                TEXT NOT NULL DEFAULT 'idle',

    store_id            TEXT,
    store_code          TEXT,
    store_name          TEXT,

    active_task_id      TEXT,
    active_task_title   TEXT,

    -- The merchandiser's own fix, or NULL when they skipped the prompt. Never
    -- filled in from the store's coordinates: that is the shortcut the geofence
    -- exists to catch, and doing it here would make every chat audit pass a
    -- control that is supposed to fail for anyone standing somewhere else.
    latitude            DOUBLE PRECISION,
    longitude           DOUBLE PRECISION,

    checklist_questions JSONB NOT NULL DEFAULT '[]'::jsonb,
    checklist_answers   JSONB NOT NULL DEFAULT '[]'::jsonb,
    checklist_index     INTEGER,

    -- The photo the merchandiser has just sent, waiting for them to confirm it.
    -- The file is not downloaded until they do, so a bad shot costs a re-shoot
    -- and not a wrong audit in a supervisor's queue.
    pending_photo       JSONB,

    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at          TIMESTAMPTZ NOT NULL
);

-- The sweep asks exactly one question — "which rows expired long enough ago to
-- forget" — so the index is on that column alone.
CREATE INDEX IF NOT EXISTS bot_sessions_expiry_idx ON bot_sessions (expires_at);

-- Looking a person's sessions up by user is not a query this system makes: the
-- bot only ever arrives with a chat id. No index on `user_id` for that reason.

COMMENT ON TABLE bot_sessions IS
    'Where a Telegram chat is in the guided field flow. Fifteen-minute TTL refreshed on every write; expired rows are ignored by readers and swept in the background.';
