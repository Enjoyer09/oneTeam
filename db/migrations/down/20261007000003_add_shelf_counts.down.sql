-- Wave 1.4 down: reverse of 20261007000003_add_shelf_counts.
--
-- Drops the manual-count columns and their non-negative CHECK. Rollback of
-- `ALTER TABLE ADD COLUMN` is `DROP COLUMN`; the whole statement is
-- transactional in Postgres, so a failure leaves the columns in place.
--
-- ponytail: data in `units`/`counted_at` is LOST by this rollback on purpose —
-- manual counts are current-state only (one number per slot, overwritten by
-- the next count), so there is no history to preserve. The upgrade path for
-- history (a `shelf_counts` table) is the same one documented in the up file.
ALTER TABLE shelf_positions
    DROP COLUMN IF EXISTS counted_at,
    DROP COLUMN IF EXISTS units;