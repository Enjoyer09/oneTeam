-- ============================================================================
-- oneTeam migration — shelf map (rəf xəritəsi)
-- File: db/migrations/20261007000002_add_shelf_positions.sql
-- ============================================================================
--
-- WHAT THIS CHANGES
-- -----------------
-- Wave 1.3 of the Shelf Map plan (docs/PRODUCT-PLAN-AZ.md §9.3): the structured
-- base the planogram comparison reads — "which product belongs at
-- (bölmə, səviyyə, mövqe)". Before this migration that mapping lived only in
-- task-template planogram_rules rows with a free-text shelfRow, and nowhere a
-- supervisor could maintain it.
--
-- DESIGN NOTES
-- ------------
-- * UNIQUE (section, level, position) rather than a check in application code:
--   a check-then-insert has a race window, the constraint has none. The API
--   translates 23505 into a readable 409 (SHELF_POSITION_TAKEN), the same way
--   barcode uniqueness works one migration earlier.
-- * `product_id` REFERENCES products ON DELETE RESTRICT — the constraint
--   20261007000001_add_products.sql promised ("wave 1.3 will add their own
--   RESTRICT constraint referencing this table"). A product standing on a
--   shelf cannot vanish from underneath the map: the delete is refused with a
--   readable 409 (PRODUCT_ON_SHELF) until the map lets go.
-- * `product_id` is nullable: a slot with nothing assigned yet is a real
--   state — the panel shows it as an empty position, not as a broken row.
-- * CHECK (>= 1) on level/position is the last line of defence; the API
--   validates the same bounds first so the normal answer is a readable 400,
--   never a raw constraint violation.
-- * Global map (no store_id): the planogram baseline is chain-wide today.
--   ponytail: add store_id (per-store layouts) when two chains' grids
--   actually diverge — the UNIQUE index becomes (store_id, section, level,
--   position) with it.
-- * `updated_at` gets the shared BEFORE UPDATE trigger from migration
--   20260921000010.

CREATE TABLE IF NOT EXISTS shelf_positions (
    id          text PRIMARY KEY,
    section     text NOT NULL,
    level       integer NOT NULL CHECK (level >= 1),
    position    integer NOT NULL CHECK (position >= 1),
    product_id  text REFERENCES products(id) ON DELETE RESTRICT,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT shelf_positions_slot UNIQUE (section, level, position)
);

COMMENT ON TABLE shelf_positions IS
    'Shelf map: section / level / position slots and the product assigned to each (wave 1.3).';

DROP TRIGGER IF EXISTS shelf_positions_set_updated_at ON shelf_positions;
CREATE TRIGGER shelf_positions_set_updated_at
    BEFORE UPDATE ON shelf_positions
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
