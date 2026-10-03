-- =============================================================================
-- 20260923000012 — persist the location-integrity flags on evidence
-- =============================================================================
--
-- WHY THIS MIGRATION EXISTS
-- ------------------------
-- Two defects, one root cause: the anti-fraud decision was made from flags that
-- were never written down.
--
-- 1. `isAiAutoApproveEligible` checked `locationMocked` but not
--    `locationUnverified`. A Telegram submission with the location skipped
--    arrives with `locationMocked = false` (there is no device to report a mock)
--    and `locationUnverified = true`; the API then substitutes the store's own
--    coordinates, so the geofence passes by construction. Such a submission with
--    a high, confident AI score was auto-approved. The one channel that cannot
--    prove where anyone was was the one channel that never had to.
--
-- 2. `location_mocked` was never persisted at all — it lived only in the
--    in-memory record, so it did not survive a restart and was invisible to the
--    panel, which is why the spoof warning it drives could not be trusted.
--
-- WHY THE COLUMNS ARE NULLABLE, NOT `NOT NULL DEFAULT false`
-- -------------------------------------------------------
-- A NULL means "this row predates the column". Back-filling false would assert
-- that those historical submissions had a verified location, which is exactly
-- the claim this migration exists to stop making. NULL reads as "unknown",
-- which is the honest state for a row written before anyone recorded it.
--
-- `IF NOT EXISTS` throughout, so re-applying is a no-op rather than an error —
-- the API re-runs every migration on every boot.
-- =============================================================================

-- The device reported the fix as mock/simulated.
ALTER TABLE task_evidences
    ADD COLUMN IF NOT EXISTS location_mocked BOOLEAN;

-- There was no real fix at all; the store's coordinates were substituted.
ALTER TABLE task_evidences
    ADD COLUMN IF NOT EXISTS location_unverified BOOLEAN;

COMMENT ON COLUMN task_evidences.location_mocked IS
    'Device reported this fix as mock/simulated. Blocks auto-approval; NULL = written before this column existed (unknown, not verified).';

COMMENT ON COLUMN task_evidences.location_unverified IS
    'No real fix was captured (Telegram skip, or location declined), so store coordinates were substituted and the geofence proved nothing. NULL = written before this column existed.';