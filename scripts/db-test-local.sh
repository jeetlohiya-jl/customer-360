#!/usr/bin/env bash
# Runs the migrations and pgTAP tests on a temporary local PostgreSQL cluster.
# For machines without Docker. Requires PostgreSQL 15+ server binaries,
# pgTAP and pg_prove (Ubuntu/Debian: postgresql-16-pgtap and
# libtap-parser-sourcehandler-pgtap-perl; macOS Homebrew: postgresql@16, pgtap).
#
# The cluster lives in a temp directory and is deleted on exit. It never
# touches a hosted Supabase project.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGBIN="${PGBIN:-$(pg_config --bindir)}"
PORT="${PGPORT_TEST:-54329}"
WORK="$(mktemp -d)"
DATA="$WORK/data"

cleanup() {
  "$PGBIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -A trust -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $WORK -c listen_addresses=''" -l "$WORK/pg.log" -w start >/dev/null

PSQL=(psql -h "$WORK" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q)
"${PSQL[@]}" -d postgres -c "create database c360_test;"
"${PSQL[@]}" -d c360_test -c "alter database c360_test set search_path = \"\$user\", public, extensions;"

echo "==> Loading local auth stub"
"${PSQL[@]}" -d c360_test -f "$ROOT/scripts/db/local-auth-stub.sql"

echo "==> Applying migrations"
for f in "$ROOT"/supabase/migrations/*.sql; do
  echo "    $(basename "$f")"
  "${PSQL[@]}" -d c360_test -f "$f"
done
# Pending (unapproved) migrations: local test database only, never hosted.
for f in "$ROOT"/supabase/pending/*.sql; do
  [ -e "$f" ] || continue
  echo "    $(basename "$f") (pending)"
  "${PSQL[@]}" -d c360_test -f "$f"
done

echo "==> Loading synthetic seed (as supabase db start/reset does)"
"${PSQL[@]}" -d c360_test -f "$ROOT/supabase/seed.sql" >/dev/null

echo "==> Running pgTAP tests"
pg_prove -h "$WORK" -p "$PORT" -U postgres -d c360_test "$ROOT"/supabase/tests/*.sql $(ls "$ROOT"/supabase/pending/tests/*.sql 2>/dev/null)

if [[ "${CHECK_ROLLBACK:-1}" == "1" ]]; then
  echo "==> Checking reverse migrations and re-apply"
  for f in $(ls "$ROOT"/supabase/rollback/*.down.sql | sort -r); do
    echo "    $(basename "$f")"
    "${PSQL[@]}" -d c360_test -f "$f"
  done
  for f in "$ROOT"/supabase/migrations/*.sql $(ls "$ROOT"/supabase/pending/*.sql 2>/dev/null); do
    "${PSQL[@]}" -d c360_test -f "$f"
  done
  # As the seed does: synthetic test users are active without invites (014 tests invite mode itself).
  "${PSQL[@]}" -d c360_test -c "update private.settings set value = 'workspace' where key = 'access_mode';"
  pg_prove -h "$WORK" -p "$PORT" -U postgres -d c360_test "$ROOT"/supabase/tests/*.sql $(ls "$ROOT"/supabase/pending/tests/*.sql 2>/dev/null) >/dev/null
  echo "    rollback + re-apply OK, tests still pass"
fi
