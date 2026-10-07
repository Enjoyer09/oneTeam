-- Wave 1.4: manual OSA / share of shelf ("işçi sayır, sistem faizi hesablayır").
--
-- `units` is the worker's count of units at this slot. 0 is a valid answer —
-- "the product belongs here and is absent" — and NULL means "nobody counted
-- this slot". OSA must treat those two differently (an uncounted slot is not
-- a miss), so they cannot share a value: the CHECK keeps 0 from drifting into
-- NULL semantics at the write side and refuses negatives outright.
--
-- `counted_at` says WHEN the number was taken: a count with no timestamp
-- cannot be reconciled with anything observed later, and the panel shows it
-- next to the number so nobody reads yesterday's count as today's.
--
-- ponytail: current state only — one number per slot, overwritten by the next
-- count. The upgrade path is a `shelf_counts` history table (one row per
-- count, store-scoped), when the vision model has to be graded against what a
-- human saw at a specific visit.
ALTER TABLE shelf_positions
    ADD COLUMN units INTEGER,
    ADD COLUMN counted_at TIMESTAMPTZ;

ALTER TABLE shelf_positions
    ADD CONSTRAINT shelf_positions_units_nonneg CHECK (units IS NULL OR units >= 0);
