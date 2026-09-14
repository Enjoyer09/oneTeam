-- ============================================================================
-- MIGRATION: 20260917000006_add_panel_tokens.sql
-- Description: Give the supervisor panel a login of its own, so opening the
--              panel URL stops being the same thing as being an administrator.
-- ============================================================================
--
-- WHY
-- ---
-- The panel had no login. nginx attached `oneteam-user:usr-admin-001` at the
-- edge for every `/api/portal/` request, which kept the credential out of the
-- browser bundle (good) but meant the only thing standing between a stranger
-- and full administrative access was knowing the URL. There was also no way to
-- answer "who approved this audit", because every action was recorded as the
-- same seeded admin.
--
-- This table holds one credential per person. A key resolves to exactly one
-- user, so the audit trail names a real individual, and cutting someone off is
-- one `UPDATE` rather than a shared secret everybody has to be told about.
--
-- WHY ONE ROW PER PERSON RATHER THAN ONE ROW PER USER
-- ---------------------------------------------------
-- There is deliberately no unique index on `user_id`. A person may be signed in
-- on a laptop and a desktop, and forcing one live key would mean signing in on
-- the second device silently signs out the first. Beyond being annoying, that
-- is the kind of behaviour that teaches people to share a single key — which is
-- the thing this table exists to stop.
--
-- (It also means no partial unique index, and therefore none of the
-- `ON CONFLICT` inference trouble documented in 20260915000004.)
--
-- TOKENS ARE STORED AS HASHES
-- ---------------------------
-- `token_hash` is a SHA-256 of the key, never the key itself, so a database
-- dump or a backup yields nothing usable. A key is shown once, at the moment it
-- is minted, and cannot be recovered afterwards — if it is lost, it is replaced.
--
-- REVOCATION IS A TIMESTAMP, NOT A DELETE
-- ---------------------------------------
-- The row stays so that "was this person ever given access, and when was it
-- taken away" remains answerable after an incident. A deleted row cannot.
--
-- NOTE ON data_version
-- --------------------
-- `panel_tokens` is intentionally NOT added to the trigger list in
-- 20260916000005. Nothing reads this table from the in-memory working set — a
-- key is looked up in the database on every request, the same way a device
-- token is — so a replica has no cached copy to invalidate. Adding it would
-- bump the shared change counter on every login for no benefit.
-- ============================================================================

CREATE TABLE IF NOT EXISTS panel_tokens (
    token_hash   TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    label        TEXT,
    -- Who minted this key. Deliberately NOT a foreign key: the authoritative
    -- record of who did what is `audit_logs`, and a hard reference here would
    -- make deleting a departed administrator either fail or silently rewrite
    -- history. This column is a convenience for the key list, not the ledger.
    created_by   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ,
    revoked_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS panel_tokens_user_idx ON panel_tokens (user_id);

-- Supports the two questions the panel asks on every load: "how many live keys
-- are there" (which decides whether the login screen is shown at all) and "show
-- me the live keys". Both filter on `revoked_at IS NULL`, and live rows are the
-- small minority once keys start being rotated.
CREATE INDEX IF NOT EXISTS panel_tokens_live_idx
    ON panel_tokens (created_at)
    WHERE revoked_at IS NULL;

COMMENT ON TABLE panel_tokens IS
    'One login credential per person for the supervisor panel. Stores only a SHA-256 of the key; revoke by setting revoked_at.';
