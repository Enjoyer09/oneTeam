-- ============================================================================
-- oneTeam migration — product (SKU) catalogue
-- File: db/migrations/20261007000001_add_products.sql
-- ============================================================================
--
-- WHAT THIS CHANGES
-- -----------------
-- Wave 1.2 of the Shelf Map plan (docs/PRODUCT-PLAN-AZ.md §9.3): the barcode
-- scanner resolves `barkod → məhsul`, and the panel maintains that mapping.
-- Before this migration the catalogue simply did not exist anywhere in the
-- system — an auditor's scan had no row to resolve against.
--
-- DESIGN NOTES
-- ------------
-- * `barcode` is UNIQUE rather than checked in application code: a
--   check-then-insert has a race window between the two statements, the
--   constraint has none. The API translates the resulting error into a
--   readable 409 (PRODUCT_BARCODE_TAKEN), the same way STORE_CODE_TAKEN works.
-- * `size` and `variant` are nullable: plenty of products are fully described
--   by their name ("Kola"), and forcing an empty string here would make every
--   reader branch on `''` instead of NULL.
-- * `updated_at` gets the shared BEFORE UPDATE trigger from migration
--   20260921000010, so the stamp is correct even for a write path that
--   forgets to set it.
-- * No FK to shelf maps yet: those tables arrive with wave 1.3 and will add
--   their own RESTRICT constraint referencing this table.

CREATE TABLE IF NOT EXISTS products (
    id          text PRIMARY KEY,
    barcode     text NOT NULL UNIQUE,
    name        text NOT NULL,
    size        text,
    variant     text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE products IS
    'SKU catalogue: barcode → product identity for shelf-audit scans (wave 1.2).';

DROP TRIGGER IF EXISTS products_set_updated_at ON products;
CREATE TRIGGER products_set_updated_at
    BEFORE UPDATE ON products
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
