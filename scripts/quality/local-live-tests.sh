#!/bin/bash
# Run CI's live-test environment locally: Postgres + schema + seed + API + suites.
# Mirrors .github/workflows/ci.yml job `live-tests`, which cannot run on this
# private repo because Actions minutes are exhausted.
set -uo pipefail
# scripts/quality/ -> repo root is two levels up, not one.
cd "$(dirname "$0")/../.."

export DATABASE_URL="postgres://postgres:postgres@localhost:55445/oneteam"
export PGPASSWORD=postgres

# Overridable, and every consumer is derived from it, so one value moves the
# API, the suites, the bot and the portal together. Changing this without
# changing the three ONETEAM/VITE values below would reintroduce exactly the
# split this script is meant to prevent.
export API_PORT="${API_PORT:-3001}"
# The API reads PORT, not API_PORT. Without this the process binds its own
# default of 3000, the suites are pointed at 3001, and every request is refused
# for a reason that has nothing to do with the code under test.
export PORT="$API_PORT"
export ONETEAM_API_URL="http://localhost:${API_PORT}"
export VITE_API_BASE_URL="http://localhost:${API_PORT}"
export ONETEAM_API_TOKEN="oneteam-user:usr-admin-001"
export TELEGRAM_BOT_TOKEN="ci-not-a-real-bot-token"
export TELEGRAM_WEBHOOK_SECRET="ci-not-a-real-webhook-secret"
export CORS_ALLOWED_ORIGINS="http://localhost,http://localhost:5173"
export NO_PROXY="localhost,127.0.0.1"
export no_proxy="localhost,127.0.0.1"

say() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

say "Build packages and API"
npm run build:packages >/tmp/lt_build.log 2>&1
rc=$?; [ $rc -ne 0 ] && { echo "build:packages FAILED ($rc)"; tail -25 /tmp/lt_build.log; exit $rc; }
npm run api:build >>/tmp/lt_build.log 2>&1
rc=$?; [ $rc -ne 0 ] && { echo "api:build FAILED ($rc)"; tail -25 /tmp/lt_build.log; exit $rc; }
echo "ok"

say "Provision database (schema + seed)"
for f in db/api-schema.sql db/api-seed.sql; do
  if ! docker exec -i oneteam-livepg psql -U postgres -d oneteam -v ON_ERROR_STOP=1 -f - <"$f" >/tmp/lt_$(basename "$f").log 2>&1; then
    echo "FAILED: $f"; tail -20 /tmp/lt_$(basename "$f").log; exit 1
  fi
  echo "  applied $f"
done

say "Start API"

# A stale process holding :3001 answers /api/health perfectly well, so the
# suites below would silently run against whatever it is — that is how 12 checks
# reported a phantom failure on 2026-10-05: this script started a second API,
# the port was already taken by a 7-day-old dev process with no DATABASE_URL,
# and every suite talked to that one instead. Refuse rather than test the wrong
# process.
STALE=$(lsof -ti tcp:"$API_PORT" 2>/dev/null | head -5)
if [ -n "$STALE" ]; then
  echo "  port $API_PORT is already held by PID(s): $(echo "$STALE" | tr '\n' ' ')"
  ps -o lstart=,command= -p "$(echo "$STALE" | head -1)" 2>/dev/null | sed 's/^/    /'
  echo
  echo "  Refusing to test somebody else's process. Stop it first:"
  echo "    kill $STALE"
  echo "  or point this script elsewhere:"
  echo "    API_PORT=3002 bash scripts/quality/local-live-tests.sh"
  exit 1
fi

node apps/api/dist/main.js >/tmp/lt_api.log 2>&1 &
API_PID=$!
trap 'kill "$API_PID" 2>/dev/null || true' EXIT

healthy=0
for i in $(seq 1 60); do
  if curl -fsS "http://localhost:${API_PORT}/api/health" >/dev/null 2>&1; then
    echo "  API healthy after ${i} attempt(s)."; healthy=1; break
  fi
  # Confirm the port belongs to the process this script started. Without the
  # pid check a pre-existing listener answers first and the suite silently runs
  # against somebody else's build.
  if ! kill -0 "$API_PID" 2>/dev/null; then
    echo "  API process exited early:"; tail -40 /tmp/lt_api.log; exit 1
  fi
  if [ "$i" -eq 1 ] && ! lsof -ti tcp:"$API_PORT" >/dev/null 2>&1; then
    echo "  nothing is listening on $API_PORT yet (the API is still booting)"
  fi
  sleep 2
done
if [ "$healthy" -ne 1 ]; then
  echo "  API never became healthy on port $API_PORT."
  echo "  its start-up line said:"
  grep -o 'is running on.*' /tmp/lt_api.log | tail -1 | sed 's/^/    /'
  tail -20 /tmp/lt_api.log
  exit 1
fi

# /api/health reports `persistence`, which is the only place the API says
# whether it reached Postgres or fell back to the in-memory seed. A live suite
# run against "memory" proves nothing: the suites' DB checks would query an empty
# database while the API answered from memory, and 12 of them went red that way
# before this check existed.
PERSIST=$(curl -fsS "http://localhost:${API_PORT}/api/health" 2>/dev/null \
          | sed -n 's/.*"persistence":"\([^"]*\)".*/\1/p' | head -1)
if [ "$PERSIST" != "postgres" ]; then
  echo "  API is running on persistence=${PERSIST:-unknown}, not postgres."
  echo "  Every DB-backed check below would fail against memory. Stop this run:"
  echo "    DATABASE_URL is probably not reaching the API process."
  exit 1
fi
echo "  persistence: postgres"

say "Run DB-backed live suites (test:live)"

# Four of these suites start their own API process and refuse to run when
# NODE_ENV=production. That guard is correct and is not being bypassed: it
# exists so nobody points a row-writing suite at a deployed database by
# accident. GitHub Actions never set NODE_ENV, so CI always ran them. This
# script has to strip it for the same reason — the DATABASE_URL above is a
# throwaway container, which is exactly the environment those suites are for.
unset NODE_ENV
# SUITES=a,b,c narrows the run while keeping everything above — the API, the
# schema, the persistence check. Narrowing from the outside would skip those.
if [ -n "${SUITES:-}" ]; then
  echo "  narrowed to: $SUITES"
  node scripts/quality/run-live-suites.mjs --only "$SUITES"
else
  npm run test:live
fi
LIVE_RC=$?

say "Break detectors"
BREAK_RC=0
if [ -n "${SUITES:-}" ]; then
  echo "  skipped: narrowing the run, not changing the code under test"
else
for b in test:break test:break:credentials test:break:device-revoke; do
  echo "-- npm run $b"
  if ! npm run "$b"; then BREAK_RC=1; echo "   ^^ $b FAILED"; fi
done
fi

say "Result"
echo "test:live exit: $LIVE_RC"
echo "break detectors exit: $BREAK_RC"
[ "$LIVE_RC" -ne 0 ] && { echo "--- api log tail ---"; tail -30 /tmp/lt_api.log; }
exit $(( LIVE_RC != 0 ? LIVE_RC : BREAK_RC ))