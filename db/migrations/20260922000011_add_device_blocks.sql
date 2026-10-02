-- ============================================================================
-- MIGRATION: 20260922000011_add_device_blocks.sql
-- Description: Let a revocation survive re-enrolment. A device that an operator
--              cut off must stay cut off until an administrator clears it —
--              not come back the moment the phone re-enrols.
-- ============================================================================
--
-- WHY
-- ---
-- `device_tokens` holds the credential, and revoking one sets `revoked_at`. But
-- revocation is about one token, and enrolment issues a new one: the mobile
-- client has no storage layer, so it re-enrols on every process start. A phone
-- that a supervisor cut off at `POST /api/panel/devices/:deviceId/revoke` was
-- therefore back with a working credential the next time it opened the app —
-- the revocation lasted exactly until the device asked again.
--
-- That is the opposite of what revocation is for. "Cut this phone off" has to
-- mean the phone stays off, and on iOS the keychain is not cleared on uninstall,
-- so the device id outlives the person — the next holder of a lost phone would
-- re-enrol into the previous worker's store with no identity check beyond a
-- store code.
--
-- WHAT THIS ADDS
-- --------------
-- A block list keyed by `device_id`. While a device has an active block,
-- enrolment refuses it (`403 DEVICE_BLOCKED`) instead of issuing a fresh token.
-- Revoking a device sets a block as a side effect, so the operator who cuts a
-- phone off gets the behaviour they already expect from the one action they
-- take. Clearing a block is an administrator's decision — the inverse of a
-- revoke, and deliberately a higher bar than setting one, because unblocking is
-- the act that lets a device back in.
--
-- A BLOCK IS A TIMESTAMP, NOT A DELETE
-- ------------------------------------
-- Same reasoning as `device_tokens.revoked_at`: `cleared_at` records that a
-- block was lifted, by whom and when, rather than dropping the row. "Was this
-- device ever blocked, and who let it back in" is the question asked after an
-- incident, and a row that disappears cannot answer it. An active block is one
-- with `cleared_at IS NULL`.
-- ============================================================================

CREATE TABLE IF NOT EXISTS device_blocks (
    device_id   TEXT NOT NULL,
    blocked_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    blocked_by  TEXT REFERENCES users (id) ON DELETE SET NULL,
    reason      TEXT,
    cleared_at  TIMESTAMPTZ,
    cleared_by  TEXT REFERENCES users (id) ON DELETE SET NULL
);

-- One active block per device. Partial, because cleared blocks are kept as
-- history and a device that is blocked, cleared, then blocked again accumulates
-- rows — only one of which may be active at a time.
--
-- As with `device_tokens_active_device_idx`, a bare `ON CONFLICT (device_id)`
-- will not infer this partial index; the predicate has to be repeated. The
-- block path sidesteps it the same way the token path does — clear-then-insert
-- is not needed here because setting a block first checks for an active one.
CREATE UNIQUE INDEX IF NOT EXISTS device_blocks_active_idx
    ON device_blocks (device_id)
    WHERE cleared_at IS NULL;

-- The lookup enrolment does on every attempt: "is there an active block for this
-- device". Covered by the partial unique index above, but named here so the
-- intent is not an accident of the uniqueness constraint.
CREATE INDEX IF NOT EXISTS device_blocks_device_idx ON device_blocks (device_id);

COMMENT ON TABLE device_blocks IS
    'Devices barred from re-enrolment. A block is active while cleared_at IS NULL; set on revoke, lifted only by an admin.';
