-- ============================================================================
-- oneTeam — least-privilege application database role (ops runbook)
-- File: db/ops/least-privilege-role.sql
-- ============================================================================
--
-- WHY THIS IS NOT A MIGRATION
-- ---------------------------
-- Migrations run at boot on the API's own connection and are checked in. A role
-- with a password does not belong in either place: the password would live in
-- the repository, and a role the app creates for itself is no restriction at
-- all. So this is an operator script, run once by an administrator against the
-- production database, NOT a file in db/migrations/.
--
-- THE MODEL
-- ---------
-- Two roles instead of one:
--
--   oneteam_migrator  owns the schema and may change it (CREATE/ALTER/DROP).
--                     Used only to APPLY migrations — by CI, or by an operator.
--
--   oneteam_app       may read and write ROWS and nothing else. No DDL, so a
--                     compromised API cannot drop a table, add a column, or
--                     disable the updated_at triggers. This is the role the
--                     running API connects as.
--
-- The running API must then be started with ONETEAM_AUTO_MIGRATE=0, because the
-- app role cannot migrate — schema changes are applied out of band with the
-- migrator role (see docs/DATABASE-ROLES.md).
--
-- HOW TO USE
-- ----------
--   1. Replace the two passwords below (or set them with \set before running).
--   2. Connect as a superuser / the database owner and run this file:
--        psql "$ADMIN_DATABASE_URL" -f db/ops/least-privilege-role.sql
--   3. Apply the schema as the migrator (once, and on every deploy that ships
--      new migrations):
--        DATABASE_URL="postgres://oneteam_migrator:<password>@host/db" \
--          ONETEAM_AUTO_MIGRATE=1 node apps/api/dist/main.js  # or a CI step
--   4. Point the API at the app role and turn boot migrations OFF:
--        DATABASE_URL=postgres://oneteam_app:<password>@host/db
--        ONETEAM_AUTO_MIGRATE=0
--
-- Idempotent: guarded so it can be re-run to re-assert the grants.

\set app_pw 'CHANGE_ME_app'
\set migrator_pw 'CHANGE_ME_migrator'

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oneteam_migrator') THEN
        CREATE ROLE oneteam_migrator LOGIN PASSWORD :'migrator_pw';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oneteam_app') THEN
        CREATE ROLE oneteam_app LOGIN PASSWORD :'app_pw';
    END IF;
END
$$;

-- Connect + schema usage for both roles.
DO $$
BEGIN
    EXECUTE format(
        'GRANT CONNECT ON DATABASE %I TO oneteam_migrator, oneteam_app',
        current_database()
    );
END
$$;
GRANT USAGE ON SCHEMA public TO oneteam_migrator, oneteam_app;

-- The migrator owns and may change the schema.
GRANT CREATE ON SCHEMA public TO oneteam_migrator;

-- The app may touch rows only — SELECT/INSERT/UPDATE/DELETE, no DDL.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO oneteam_app;

-- Tables the migrator creates LATER must be reachable by the app too, without
-- re-running this script. Default privileges apply only to objects the
-- migrator creates, which is why migrations should be applied as that role.
ALTER DEFAULT PRIVILEGES FOR ROLE oneteam_migrator IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO oneteam_app;

-- The schema uses TEXT primary keys, so there are no sequences to grant. If a
-- future migration introduces a serial/identity column, add here:
--   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO oneteam_app;
--   ALTER DEFAULT PRIVILEGES FOR ROLE oneteam_migrator IN SCHEMA public
--       GRANT USAGE, SELECT ON SEQUENCES TO oneteam_app;
