-- ============================================================================
-- MIGRATION: 20260919000008_add_notifications.sql
-- Description: Give the API somewhere to put a message that has to reach a
--              merchandiser's Telegram chat, so that the bot can deliver it.
-- ============================================================================
--
-- WHY THIS TABLE EXISTS
-- ---------------------
-- `NotificationDispatcherService` has, since the beginning, claimed to send
-- notifications and sent none. It built a payload, pushed it onto an array in
-- its own process memory, logged "DISPATCH COMPLETE", and returned
-- `{ telegram: true, pushNotification: true }`. Two suites asserted those
-- booleans and passed, so the claim was covered by tests and by nothing else.
--
-- The visible consequence was that a supervisor could create a task in the panel
-- and no merchandiser was ever told. They would find out by opening the bot and
-- pressing "Tapşırıqlar", which is exactly the behaviour the panel was supposed
-- to make unnecessary.
--
-- The array also had a second problem: it was in the API's process memory, so it
-- was emptied on every deploy. Even if something had read it, the notifications
-- it held would have been lost at the moment they mattered most — a deploy.
--
-- WHY A TABLE AND NOT A DIRECT SEND FROM THE API
-- ----------------------------------------------
-- The API does not talk to Telegram and should not start. `TELEGRAM_BOT_TOKEN`
-- is held by exactly one service; putting it in a second one doubles the number
-- of places it can leak from and gives the API an outbound dependency on a third
-- party that a task transition would then be able to fail on. Creating a task is
-- business data and must not depend on Telegram being reachable.
--
-- So the API records the *intent* to notify, in the same transaction-sized step
-- as the state change, and the bot — which already holds the token, already runs
-- a poll loop, and already retries — drains it. This is the same shape as
-- `bot_sessions`: the API owns the data, the bot reaches it only through the API.
--
-- WHY `chat_id` IS RESOLVED AT ENQUEUE TIME AND MAY BE NULL
-- ---------------------------------------------------------
-- A notification is addressed to a person, but Telegram needs a chat. Resolving
-- it when the row is written records what was true when the event happened. The
-- alternative — resolving at delivery — would send a task-assigned message to
-- whoever holds that user's chat binding later, which may be nobody.
--
-- A NULL `chat_id` is therefore meaningful and is kept rather than dropped: it
-- says "this person has never spoken to the bot, so there is nowhere to send
-- this". A supervisor can see that and tell them to open the bot once. Silently
-- discarding the row would make the same situation look like "nothing happened".
--
-- It is also not claimable — `claimNotifications` requires a chat id — so it is
-- a record rather than a pending message, and the retention sweep removes it
-- after the usual window. A merchandiser who enrols in the bot later still gets
-- the deadline reminder, because that row resolves the chat id when it is
-- written, which is later.
--
-- WHY `dedupe_key` IS UNIQUE
-- --------------------------
-- The deadline reminder is produced by a periodic sweep, so the same task comes
-- up again on every tick. Without a dedupe key, a task due in fifteen minutes
-- would be reminded about every thirty seconds until it was late — which trains
-- people to ignore the bot. The key is written by the caller and the insert is
-- `ON CONFLICT DO NOTHING`, so enqueueing is idempotent by construction rather
-- than by a check that could race.
--
-- WHAT IS DELIBERATELY NOT HERE
-- -----------------------------
-- No foreign key on `store_task_id`. The task may be deleted — a supervisor
-- discards a briefing, or the store closes — while the notification is still
-- queued, and a hard reference would make that deletion fail for a reason the
-- supervisor cannot see. This is the same reasoning as `bot_sessions`.
--
-- No `data_version` trigger. Nothing reads this table into the in-memory
-- snapshot; a replica has no cached copy to invalidate, and attaching the trigger
-- would make every notification bump the shared change counter and reload every
-- replica for nothing.
--
-- No push-notification columns. The APNs/FCM payload the old code invented was
-- never sent to anything and there is no mobile push path in this deployment.
-- Columns for it would be a second fabrication with a schema behind it.
-- ============================================================================

CREATE TABLE IF NOT EXISTS notifications (
    id              TEXT PRIMARY KEY,

    -- What happened, not what to say. The text is stored too, but the kind is
    -- what a reader can group or filter by without parsing Azerbaijani prose.
    kind            TEXT NOT NULL,

    -- Where it should go. NULL means the person has no Telegram binding yet.
    chat_id         TEXT,
    user_id         TEXT REFERENCES users (id) ON DELETE CASCADE,

    store_task_id   TEXT,

    -- The message as it will be sent. Stored rather than derived at delivery
    -- time so that what the merchandiser reads is what the event said, even if
    -- the task is edited in between.
    title           TEXT NOT NULL,
    body            TEXT NOT NULL,

    -- What the inline button needs. `{ "taskId": "..." }` today.
    payload         JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- See the header. Caller-supplied, so it can name the event precisely:
    -- `TASK_ASSIGNED:<taskId>`, `DEADLINE_SOON:<taskId>`,
    -- `TASK_REJECTED:<evidenceId>`.
    dedupe_key      TEXT NOT NULL UNIQUE,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- A lease, not a lock. The bot claims rows before sending, so two bot
    -- instances cannot send the same message; the claim expires so that a bot
    -- killed mid-send does not strand the row forever. Delivery is therefore
    -- at-least-once, which is the right trade for a notification: a duplicate
    -- reminder is a small annoyance, a lost one is the bug this table exists to
    -- fix.
    claimed_at      TIMESTAMPTZ,
    claimed_by      TEXT,

    delivered_at    TIMESTAMPTZ,

    -- Kept rather than deleted, because "the bot tried and Telegram refused" is
    -- the answer to "why did nobody get this", and a deleted row cannot say it.
    failed_at       TIMESTAMPTZ,
    failure         TEXT,
    attempts        INTEGER NOT NULL DEFAULT 0
);

-- The drain query is "undelivered rows for this chat, oldest first". The partial
-- index keeps it proportional to the backlog rather than to the table's history,
-- which is the difference between a fast poll and a table scan every five
-- seconds forever.
CREATE INDEX IF NOT EXISTS notifications_pending_idx
    ON notifications (chat_id, created_at)
    WHERE delivered_at IS NULL AND failed_at IS NULL;

COMMENT ON TABLE notifications IS
    'Messages the API wants a merchandiser to receive in Telegram. Written by the API on a task event, drained by the bot, which is the only process holding the bot token.';
