#!/usr/bin/env bash
# ==============================================================================
# oneTeam — PostgreSQL logical backup
# ==============================================================================
#
# Takes a compressed pg_dump of the database named by DATABASE_URL, writes it to
# a timestamped file under PGDUMP_DIR, and prunes backups older than
# RETENTION_DAYS. Designed to run from cron, a container, or a scheduled
# service — this is the entry point of the Railway cron service that backs the
# production database up nightly.
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
#   BACKUP_S3_BUCKET          (optional) upload the dump here when all of
#                             BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY_ID and
#                             BACKUP_S3_SECRET_ACCESS_KEY are set. Absent -> the
#                             dump is local-only and the script says so.
#   BACKUP_S3_ENDPOINT        (optional) S3-compatible endpoint (R2, MinIO).
#   BACKUP_S3_REGION          (optional) region; "auto" for most S3-compatible
#                             providers.
#   BACKUP_S3_ACCESS_KEY_ID / BACKUP_S3_SECRET_ACCESS_KEY
#   BACKUP_S3_PREFIX          (optional) key prefix, e.g. "backups/db".
#
# WHY THE UPLOAD IS PART OF WHAT SUCCESS MEANS
# -------------------------------------------
# This script's only caller was a GitHub Actions workflow that uploads the dump
# as a 14-day build artifact — and that workflow has failed on all 8 of its
# last runs with "DATABASE_URL secret is not set". The repository has therefore
# never held a backup.
#
# A dump written to the same machine that produced it is not a backup: a
# redeploy replaces the container and the dump goes with it. So when S3 config is
# present the upload is required, and a failed upload exits non-zero. Silence
# here is what produced zero backups with a workflow that looked configured.
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

# --- Upload to object storage -------------------------------------------------
# The local copy above is not a backup: a redeploy replaces the container, and
# the dump goes with it. When object storage is configured, the upload is part
# of the job, not a nicety — so a failure here fails the whole run rather than
# printing a warning next to a green exit.
BACKUP_S3_BUCKET="${BACKUP_S3_BUCKET:-}"
BACKUP_S3_PREFIX="${BACKUP_S3_PREFIX:-}"

if [ -n "${BACKUP_S3_BUCKET}" ] && [ -n "${BACKUP_S3_ACCESS_KEY_ID:-}" ] && [ -n "${BACKUP_S3_SECRET_ACCESS_KEY:-}" ]; then
  if ! command -v aws >/dev/null 2>&1; then
    echo "[db-backup] ERROR: BACKUP_S3_BUCKET is set but the aws CLI is not on PATH." >&2
    echo "[db-backup] The dump exists at ${OUTFILE} but was NOT uploaded." >&2
    exit 3
  fi

  # Trim a trailing slash so an empty prefix cannot produce "bucket//file",
  # which some S3-compatible endpoints reject outright.
  PREFIX="${BACKUP_S3_PREFIX%/}"
  if [ -n "${PREFIX}" ]; then
    DEST="s3://${BACKUP_S3_BUCKET}/${PREFIX}/$(basename "${OUTFILE}")"
  else
    DEST="s3://${BACKUP_S3_BUCKET}/$(basename "${OUTFILE}")"
  fi

  echo "[db-backup] Uploading to ${DEST}"
  AWS_ARGS=(--region "${BACKUP_S3_REGION:-auto}" s3 cp "${OUTFILE}" "${DEST}")
  if [ -n "${BACKUP_S3_ENDPOINT:-}" ]; then
    AWS_ARGS+=(--endpoint-url "${BACKUP_S3_ENDPOINT}")
  fi

  if AWS_ACCESS_KEY_ID="${BACKUP_S3_ACCESS_KEY_ID}" \
     AWS_SECRET_ACCESS_KEY="${BACKUP_S3_SECRET_ACCESS_KEY}" \
     aws "${AWS_ARGS[@]}"; then
    echo "[db-backup] Uploaded $(basename "${OUTFILE}") to object storage."
  else
    echo "[db-backup] ERROR: upload to ${DEST} failed." >&2
    echo "[db-backup] The dump exists at ${OUTFILE} but is not durably stored." >&2
    exit 3
  fi
else
  echo "[db-backup] BACKUP_S3_BUCKET not configured — dump is LOCAL ONLY."
  echo "[db-backup] It will not survive a redeploy. Configure BACKUP_S3_* to fix this."
fi

echo "[db-backup] Done."
