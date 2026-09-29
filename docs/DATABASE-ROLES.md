# Database roles — least privilege for the API

The API talks to PostgreSQL over a single `DATABASE_URL`. By default that
connection can do anything the database owner can, including dropping tables and
altering the schema. A least-privilege deployment splits that into two roles so
the _running_ API can only read and write rows — never change the schema.

## The two roles

| Role               | May do                                            | Used by                                 |
| ------------------ | ------------------------------------------------- | --------------------------------------- |
| `oneteam_migrator` | `CREATE` / `ALTER` / `DROP` — owns the schema     | Migration step only (CI or an operator) |
| `oneteam_app`      | `SELECT` / `INSERT` / `UPDATE` / `DELETE` on rows | The running API process                 |

Because `oneteam_app` has no DDL rights, a compromised or buggy API cannot drop
`task_evidences`, add a column, or disable the `updated_at` triggers. The blast
radius of the app's credential is row data, not the shape of the database.

## Why the API must run with `ONETEAM_AUTO_MIGRATE=0`

The API applies migrations at boot on its own connection (see
`packages/database/src/index.ts`). The app role cannot run DDL, so that boot
migration would fail. In the two-role model the schema is applied **out of
band** by the migrator role, and the API is told not to migrate:

```
# API process — app role, no boot migrations
DATABASE_URL=postgres://oneteam_app:<password>@host/db
ONETEAM_AUTO_MIGRATE=0
```

The API still runs its read-only schema _check_ on boot (`checkSchema`), so if
the migrator has not applied a needed migration, `/api/health` reports the
mismatch loudly instead of failing writes silently.

## Applying migrations as the migrator

Migrations must be applied by `oneteam_migrator` so that the tables they create
are owned by it and the `ALTER DEFAULT PRIVILEGES` grant reaches `oneteam_app`
automatically. Either run the API once with the migrator credential and
`ONETEAM_AUTO_MIGRATE=1`, or run the migration step in CI/deploy against the
migrator URL, before the app rolls out.

## Setup

Run [`db/ops/least-privilege-role.sql`](../db/ops/least-privilege-role.sql) once
as a superuser or the database owner, after setting the two passwords. It
creates both roles, grants the app role row-level DML, and sets default
privileges so future migrator-created tables are reachable by the app without
re-running the script.

## Single-role deployments

If you keep one role (the default, simplest setup), leave `ONETEAM_AUTO_MIGRATE`
unset so the API applies migrations at boot. This is fine for development and
low-risk deployments; the two-role split is the hardening step for production.
