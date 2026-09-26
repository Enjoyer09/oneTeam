# Backup & Restore

The database is the only stateful part of oneTeam. Everything else (the API's
in-memory replica, the compiled images) is rebuilt from source or rehydrated
from PostgreSQL, so a good database backup is a full recovery point.

## What to back up

The PostgreSQL database named by `DATABASE_URL`. Photos are stored **inline in
the database** by default, so a logical dump captures them too. If you have set
`STORAGE_DRIVER=s3`, photos live in your bucket instead and that bucket needs its
own backup/versioning policy — the database then holds only the URLs.

## Taking a backup

Use `scripts/ops/db-backup.sh`. It runs `pg_dump`, gzips the output to a
timestamped file, and prunes old dumps.

```bash
# One-off, into ./backups (default)
DATABASE_URL=postgres://<user>:<password>@host:5432/oneteam ./scripts/ops/db-backup.sh

# Custom directory and 30-day retention
DATABASE_URL=postgres://<user>:<password>@host:5432/oneteam \
  PGDUMP_DIR=/var/backups/oneteam \
  RETENTION_DAYS=30 \
  ./scripts/ops/db-backup.sh
```

Environment variables:

| Variable         | Default     | Meaning                                              |
| ---------------- | ----------- | ---------------------------------------------------- |
| `DATABASE_URL`   | (required)  | Connection string to dump. Never printed.            |
| `PGDUMP_DIR`     | `./backups` | Output directory (created if absent).                |
| `RETENTION_DAYS` | `14`        | Delete `oneteam-*.sql.gz` older than this; `0` = off. |

The dump is plain SQL with `--clean --if-exists --no-owner --no-privileges`, so
it restores with `psql` alone and is portable across role names between
environments.

## Scheduled backups

`.github/workflows/db-backup.yml` runs the script nightly (02:30 UTC) and on
demand, then uploads the dump as a workflow artifact. It needs a `DATABASE_URL`
**repository secret**, and the database must be reachable from GitHub's hosted
runners (a public managed endpoint with TLS). For a private database, run the
same script from inside the network — a host cron job, a Railway cron service,
or a self-hosted runner. An artifact is adequate for short-horizon recovery; for
long-term retention push to object storage (see the TODO in the workflow).

## Restoring

```bash
# Full restore (the dump drops and recreates objects via --clean --if-exists)
gunzip -c backups/oneteam-YYYYMMDDTHHMMSSZ.sql.gz | psql "$DATABASE_URL"
```

Restore into a database the API is **not** actively writing to (stop the API/bot
first), then start the API. On boot it re-applies the idempotent schema and any
pending migrations from `db/migrations/`, and hydrates its in-memory replica from
the restored rows.

To restore into a brand-new empty database, the dump is self-contained — the
`--clean --if-exists` header is a no-op on an empty target and the `CREATE`
statements build everything.

## Verifying a backup

A backup you have never restored is a hope, not a backup. Periodically restore
the latest dump into a throwaway database and hit `/api/health` against an API
pointed at it — it reports the persistence driver and whether the schema/
migrations applied cleanly.
