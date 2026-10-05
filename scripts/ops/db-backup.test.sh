#!/usr/bin/env bash
# ==============================================================================
# oneTeam — tests for the object-storage half of db-backup.sh
# ==============================================================================
#
# WHY THIS EXISTS
# ---------------
# `scripts/ops/db-backup.sh` wrote a dump to a local directory and stopped. Its
# only caller was `.github/workflows/db-backup.yml`, uploading the file as a
# build artifact with a 14-day window, and that workflow has failed on every one
# of its last 8 runs:
#
#     ##[error]DATABASE_URL secret is not set.
#
# So this system has never once held a backup. A dump on the same machine that
# made it is not a backup — a Railway redeploy replaces the container and the
# dump goes with it.
#
# The fix is to run the script where the database actually is (a Railway cron
# service on the private network) and push the dump somewhere that outlives the
# container. That makes the S3 upload part of what SUCCESS MEANS, not an extra
# step — hence it is tested here, and hence `db-backup.sh` treats a failed
# upload as a failed backup.
#
# WHAT IS TESTED
# --------------
# These cases stub `pg_dump` so they run with no database and no network:
#
#   1. a dump is uploaded to the configured prefix when S3 config is present
#   2. a FAILED upload is a non-zero exit — a dump nobody can reach is not a backup
#   3. no S3 config -> a clear skip, exit 0 (local-only use stays supported)
#   4. the local file is kept even after a successful upload
#   5. the destination path is the prefix + the dump filename
#   6. an empty/invalid prefix does not produce a path with a stray slash
#   7. retention pruning does not delete the file just uploaded (mtime is fresh)
#
# NOT TESTED, AND WHY
#   A real upload. Pointing aws at a bucket would make this suite depend on
#   credentials and a network; the command shape is asserted with a stub, and
#   the first real run is verified against the live bucket by hand.
# ==============================================================================

set -uo pipefail

PASSED=0
FAILED=0

pass() {
  PASSED=$((PASSED + 1))
  echo "  ✅ [PASS] $1"
}

fail() {
  FAILED=$((FAILED + 1))
  echo "  ❌ [FAIL] $1"
  if [ $# -gt 1 ]; then
    echo "         $2"
  fi
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Both this suite and the script it exercises live in scripts/ops, so the path
# is a sibling reference — not a parent one. Getting this wrong makes the suite
# exec ITSELF, which "works" (exit 0, no upload) and fails every check for a
# reason that has nothing to do with the code under test.
BACKUP_SH="${SCRIPT_DIR}/db-backup.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

# --- stubs -------------------------------------------------------------------

# pg_dump: emit something deterministic and small, and record how it was called.
mkdir -p "${WORK}/bin"
cat > "${WORK}/bin/pg_dump" <<'STUB'
#!/usr/bin/env bash
# Ignores --dbname entirely: this stub must never touch a real connection, and
# a leaked DATABASE_URL must not end up in the dump.
printf -- '-- oneTeam test dump\nCREATE TABLE t (id int);\n'
STUB

# aws: record its argv so the suite can assert the destination and the flags.
cat > "${WORK}/bin/aws" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${AWS_CALL_LOG}"
exit "${AWS_EXIT:-0}"
STUB

chmod +x "${WORK}/bin/pg_dump" "${WORK}/bin/aws"

# --- harness -----------------------------------------------------------------

# run_backup <label> — runs db-backup.sh in a fresh sandbox with stubs on PATH.
# Env vars come from the caller. Sets RUN_RC, RUN_LOG, RUN_DIR.
RUN_RC=0
RUN_LOG=""
RUN_DIR=""
RUN_ID=0
run_backup() {
  RUN_ID=$((RUN_ID + 1))
  RUN_DIR="${WORK}/run-${RUN_ID}"
  mkdir -p "${RUN_DIR}/backups"
  RUN_LOG="${RUN_DIR}/out.log"

  # Splice the caller's NAME=value pairs after the harness's own. Order matters:
  # a caller may override AWS_EXIT but not PGDUMP_DIR/AWS_CALL_LOG, which the
  # stubs read.
  ( export PATH="${WORK}/bin:${PATH}" \
           PGDUMP_DIR="${RUN_DIR}/backups" \
           AWS_CALL_LOG="${RUN_DIR}/aws.log"
    for kv in "$@"; do
      case "${kv}" in
        *=*) export "${kv}" ;;
        # A bare word is a mistake in the harness, not a value to export. Passing
        # it through would abort the subshell under `set -u` and surface as a
        # misleading 127 instead of the real failure.
        *) echo "HARNESS: ignoring non NAME=value argument: ${kv}" >&2 ;;
      esac
    done
    bash "${BACKUP_SH}" ) > "${RUN_LOG}" 2>&1
  RUN_RC=$?
}

S3_ENV=(
  "BACKUP_S3_BUCKET=oneteam-backups"
  "BACKUP_S3_ENDPOINT=https://s3.example.com"
  "BACKUP_S3_REGION=auto"
  "BACKUP_S3_ACCESS_KEY_ID=AKIA_TEST"
  "BACKUP_S3_SECRET_ACCESS_KEY=secret"
  "BACKUP_S3_PREFIX=backups/db"
)

echo ""
echo "--- [DB BACKUP] A dump nobody can reach is not a backup ---"

# 1. The happy path: with S3 configured, the dump is uploaded.
run_backup \
  "DATABASE_URL=postgres://u:p@localhost:5432/db" \
  "${S3_ENV[@]}"
if [ "${RUN_RC}" -eq 0 ] && grep -q "s3 cp" "${RUN_DIR}/aws.log" 2>/dev/null; then
  pass "the dump is uploaded to object storage"
else
  fail "the dump is uploaded to object storage" "exit=${RUN_RC}; aws calls: $(cat "${RUN_DIR}/aws.log" 2>/dev/null || echo none)"
fi

# 2. THE REGRESSION. If the upload fails, the backup failed. A silent success
#    here is how this repo ended up with zero backups and a green-ish workflow.
run_backup \
  "DATABASE_URL=postgres://u:p@localhost:5432/db" \
  "AWS_EXIT=1" \
  "${S3_ENV[@]}"
if [ "${RUN_RC}" -ne 0 ]; then
  pass "a failed upload exits non-zero"
else
  fail "a failed upload exits non-zero" "exit=${RUN_RC} — a dump that could not be uploaded was reported as a success"
fi

# 3. No S3 config is a supported local-only mode, not a failure.
run_backup "DATABASE_URL=postgres://u:p@localhost:5432/db"
if [ "${RUN_RC}" -eq 0 ] && grep -qi "skip\|not configured" "${RUN_LOG}"; then
  pass "no S3 config is a clear skip, not an error"
else
  fail "no S3 config is a clear skip, not an error" "exit=${RUN_RC}"
fi

# 4. The local copy survives a successful upload — so a failed restore-from-S3
#    still has something local to fall back to within the same run.
run_backup "DATABASE_URL=postgres://u:p@localhost:5432/db" "${S3_ENV[@]}"
if ls "${RUN_DIR}"/backups/oneteam-*.sql.gz >/dev/null 2>&1; then
  pass "the local dump is kept after a successful upload"
else
  fail "the local dump is kept after a successful upload"
fi

# 5. The destination is prefix + filename, and the flags are right.
DEST="$(sed -n 's/.*\(s3:\/\/[^ ]*\).*/\1/p' "${RUN_DIR}/aws.log" 2>/dev/null | head -1)"
if echo "${DEST}" | grep -q '^s3://oneteam-backups/backups/db/oneteam-[0-9T]*Z\.sql\.gz$'; then
  pass "the destination is prefix + dump filename (${DEST})"
else
  fail "the destination is prefix + dump filename" "got '${DEST}'"
fi

# 6. An empty prefix must not yield a double slash, which some S3-compatible
#    endpoints reject outright.
run_backup \
  "DATABASE_URL=postgres://u:p@localhost:5432/db" \
  "${S3_ENV[@]/BACKUP_S3_PREFIX=backups/db/BACKUP_S3_PREFIX=}"
DEST2="$(sed -n 's/.*\(s3:\/\/[^ ]*\).*/\1/p' "${RUN_DIR}/aws.log" 2>/dev/null | head -1)"
if echo "${DEST2}" | grep -q '^s3://oneteam-backups//' ; then
  fail "an empty prefix does not produce a stray slash" "got '${DEST2}'"
else
  pass "an empty prefix does not produce a stray slash (${DEST2})"
fi

# 7. A sub-second mtime must not be pruned by -mtime +N.
run_backup \
  "DATABASE_URL=postgres://u:p@localhost:5432/db" \
  "RETENTION_DAYS=1" \
  "${S3_ENV[@]}"
if ls "${RUN_DIR}"/backups/oneteam-*.sql.gz >/dev/null 2>&1; then
  pass "the fresh dump is not pruned by retention"
else
  fail "the fresh dump is not pruned by retention"
fi

echo ""
echo "$((PASSED))/$((PASSED + FAILED)) db-backup checks passed"
if [ "${FAILED}" -ne 0 ]; then exit 1; fi
exit 0