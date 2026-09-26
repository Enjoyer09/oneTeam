#!/usr/bin/env bash
# ==============================================================================
# oneTeam — PostgreSQL logical backup
# ==============================================================================
#
# Takes a compressed pg_dump of the database named by DATABASE_URL, writes it to
# a timestamped file under PGDUMP_DIR, and prunes backups older than
# RETENTION_DAYS. Designed to run from cron, a container, or the GitHub Actions
# workflow in .github/workflows/db-backup.yml.
#
# ENVIRONMENT
# -----------
#   DATABASE_URL    (required) postgres://<user>:<password>@host:port/db  — the database
#                   to dump. Never printed by this script.
#   PGDUMP_DIR      (optional) output directory. Default: ./backups
#   RETENTION_DAYS  (optional) delete *.sql.gz older than this many days.
#                   Default: 14. Set to 0 to disable pruning.
#   PGDUMP_JOBS     (optional) reserved for future directory-format parallelism;
#                   this script uses the plain SQL format so it stays restorable
#                   with psql alone.
#
# USAGE
# -----
#   DATABASE_URL=postgres://... ./scripts/ops/db-backup.sh
#   DATABASE_URL=postgres://... PGDUMP_DIR=/var/backups/oneteam \
#     RETENTION_DAYS=30 ./scripts/ops/db-backup.sh
#
# RESTORE  (see docs "Backup & Restore")
#   gunzip -c backups/oneteam-YYYYMMDDTHHMMSSZ.sql.gz | psql "$DATABASE_URL"
#
# EXIT CODES
#   0 success · 1 usage/precondition · 2 dump failed
# ==============================================================================

set -euo pipefail

# --- Configuration ------------------------------------------------------------
DATABASE_URL="${DATABASE_URL:-}"
PGDUMP_DIR="${PGDUMP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

if [ -z "${DATABASE_URL}" ]; then
  echo "ERROR: DATABASE_URL is not set. Refusing to guess a connection." >&2
  exit 1
fi

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "ERROR: pg_dump not found on PATH. Install the postgresql client tools." >&2
  exit 1
fi

# --- Prepare output -----------------------------------------------------------
mkdir -p "${PGDUMP_DIR}"

# UTC, sortable, filesystem-safe. Example: oneteam-20260926T031500Z.sql.gz
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUTFILE="${PGDUMP_DIR}/oneteam-${TIMESTAMP}.sql.gz"
TMPFILE="${OUTFILE}.partial"

# Clean up a partial file if the dump is interrupted, so a broken backup is
# never mistaken for a good one.
cleanup() {
  if [ -f "${TMPFILE}" ]; then
    rm -f "${TMPFILE}"
  fi
}
trap cleanup EXIT

echo "[db-backup] Dumping database to ${OUTFILE}"

# --- Dump ---------------------------------------------------------------------
# Plain SQL format piped straight into gzip, so the artefact restores with psql
# alone (no pg_restore needed). --no-owner/--no-privileges keep the dump portable
# across role names between environments. The connection string is passed as a
# single argument and is not echoed.
if ! pg_dump \
      --dbname="${DATABASE_URL}" \
      --format=plain \
      --no-owner \
      --no-privileges \
      --clean \
      --if-exists \
    | gzip -9 > "${TMPFILE}"; then
  echo "[db-backup] ERROR: pg_dump failed." >&2
  exit 2
fi

# Atomic-ish rename: the final filename only appears once the dump succeeded.
mv "${TMPFILE}" "${OUTFILE}"
trap - EXIT

BYTES="$(wc -c < "${OUTFILE}" | tr -d ' ')"
echo "[db-backup] Wrote ${OUTFILE} (${BYTES} bytes)"

# --- Prune old backups --------------------------------------------------------
if [ "${RETENTION_DAYS}" -gt 0 ] 2>/dev/null; then
  echo "[db-backup] Pruning backups older than ${RETENTION_DAYS} day(s) in ${PGDUMP_DIR}"
  # -mtime +N is "older than N*24h". Only touch this script's own artefacts.
  find "${PGDUMP_DIR}" -maxdepth 1 -type f -name 'oneteam-*.sql.gz' \
    -mtime "+${RETENTION_DAYS}" -print -delete || true
else
  echo "[db-backup] Retention disabled (RETENTION_DAYS=${RETENTION_DAYS}); keeping all backups."
fi

echo "[db-backup] Done."
