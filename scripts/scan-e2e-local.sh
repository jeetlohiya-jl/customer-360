#!/usr/bin/env bash
# End-to-end test of the Stage 3.1 scan on a temporary local PostgreSQL with a
# SYNTHETIC mailbox (no Google, no real email). Runs the real worker code
# through the real c360_worker login. Deleted on exit. Never touches a hosted
# project. Needs PostgreSQL 15+ server binaries and pgTAP-free psql.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGBIN="${PGBIN:-$(pg_config --bindir)}"
PORT="${PGPORT_E2E:-54340}"
WORK="$(mktemp -d)"
DATA="$WORK/data"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -A trust -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $WORK -c listen_addresses=127.0.0.1" -l "$WORK/pg.log" -w start >/dev/null
PSQL=(psql -h "$WORK" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q)
"${PSQL[@]}" -d postgres -c "create database c360_e2e;"
"${PSQL[@]}" -d c360_e2e -f "$ROOT/scripts/db/local-auth-stub.sql"
for f in "$ROOT"/supabase/migrations/*.sql; do "${PSQL[@]}" -d c360_e2e -f "$f"; done
# Local-only password for the worker login (the hosted one is set by an operator).
"${PSQL[@]}" -d c360_e2e -c "alter role c360_worker with login password 'local-e2e-only';"

E2E_DB_ADMIN_URL="postgres://postgres@127.0.0.1:$PORT/c360_e2e" \
E2E_DB_WORKER_URL="postgres://c360_worker:local-e2e-only@127.0.0.1:$PORT/c360_e2e" \
  node "$ROOT/node_modules/vitest/vitest.mjs" run --config "$ROOT/vitest.e2e.config.mts" --root "$ROOT"
