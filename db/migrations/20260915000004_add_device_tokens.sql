-- ============================================================================
-- MIGRATION: 20260915000004_add_device_tokens.sql
-- Description: Give a mobile installation its own credential, so the app no
--              longer has to ship the service credential in its bundle.
-- ============================================================================
--
-- WHY
-- ---
-- The bot is a server: one process, one credential, and the acting person
-- arrives as a chat id the bot derived from the update it is handling. That is
-- safe because a Telegram user cannot call the API directly.
--
-- A mobile app is not a server. It is a bundle anyone can download, and it was
-- authenticating with the shared service credential — defaulting, in fact, to
-- `oneteam-user:usr-admin-001`, so the shipped build acted as an administrator
-- until someone set an environment variable. Extracting one string from the
-- bundle gave full access to every store, every task and every audit.
--
-- This table holds a credential per installation instead. It is issued by
-- `POST /api/portal/field/enroll` against a store code — the same claim the chat
-- channel already uses — and it identifies exactly one user. A leaked device
-- token is worth one device's access; the service credential was worth
-- everything.
--
-- TOKENS ARE STORED AS HASHES
-- ---------------------------
-- `token_hash` is a SHA-256 of the token, never the token itself. A database
-- dump, a backup, or a read-only leak therefore yields no usable credentials —
-- the same reasoning that applies to passwords, and it costs one hash per
-- request.
--
-- REVOCATION IS A TIMESTAMP, NOT A DELETE
-- ---------------------------------------
-- Setting `revoked_at` keeps the record of which device was enrolled and when it
-- was cut off. A row that disappears cannot answer "was this device ever
-- authorised", which is the question asked after an incident.
-- ============================================================================

CREATE TABLE IF NOT EXISTS device_tokens (
    token_hash   TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    device_id    TEXT NOT NULL,
    label        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ,
    revoked_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS device_tokens_user_idx ON device_tokens (user_id);

-- One live token per installation. Partial, because revoked rows are kept and a
-- device that is re-enrolled must be able to get a new token without the old
-- revoked ones blocking it.
--
-- Note for anyone writing an upsert against this index: a partial index is not
-- inferred by a bare `ON CONFLICT (device_id)`. The predicate has to be
-- repeated, or PostgreSQL answers "no unique or exclusion constraint matching
-- the ON CONFLICT specification". The enrolment path sidesteps this by revoking
-- and inserting in one transaction, which is clearer than a conditional upsert
-- and does not depend on getting the inference right.
CREATE UNIQUE INDEX IF NOT EXISTS device_tokens_active_device_idx
    ON device_tokens (device_id)
    WHERE revoked_at IS NULL;

COMMENT ON TABLE device_tokens IS
    'One credential per mobile installation. Stores only a SHA-256 of the token; revoke by setting revoked_at.';
