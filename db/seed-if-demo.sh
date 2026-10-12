#!/bin/sh
# =============================================================================
#  oneTeam — opt-in demo seed loader for the Postgres initdb hook
# =============================================================================
#
#  The official postgres image runs every *.sql file in
#  /docker-entrypoint-initdb.d/ unconditionally on first boot. That is exactly
#  how db/api-seed.sql used to load named demo users, demo stores, a demo
#  campaign and demo tasks (and, worse, fabricated audit_logs rows) into EVERY
#  fresh database — production included.
#
#  So the demo seed is no longer mounted as a runnable *.sql file. It is placed
#  at /opt/oneteam/demo-seed.sql, and this script — which the init hook runs —
#  loads it ONLY when an operator has explicitly opted in with
#  ONETEAM_SEED_DEMO. A production database gets the schema and nothing else.
#
#  Runs during initdb, where a local server is already up and psql connects
#  over the Unix socket as the superuser. ON_ERROR_STOP makes a bad seed fail
#  the boot loudly rather than leaving a half-populated database.
# =============================================================================
set -eu

SEED_FILE="/opt/oneteam/demo-seed.sql"

case "${ONETEAM_SEED_DEMO:-}" in
  1 | true | TRUE | yes | YES)
    if [ -f "$SEED_FILE" ]; then
      echo "[oneTeam] ONETEAM_SEED_DEMO is set — loading demo seed from $SEED_FILE"
      psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -f "$SEED_FILE"
    else
      echo "[oneTeam] ONETEAM_SEED_DEMO is set but $SEED_FILE is missing — nothing to seed."
    fi
    ;;
  *)
    echo "[oneTeam] ONETEAM_SEED_DEMO is not set — skipping demo seed (production default)."
    ;;
esac
