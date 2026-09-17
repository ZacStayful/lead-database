#!/usr/bin/env bash
# Build the schema from supabase/migrations/ on a throwaway Postgres and run
# every SQL suite in supabase/tests/ against it. This is the database half of
# .github/workflows/ci.yml and the same steps supabase/tests/README.md gives
# for a local run, so the two cannot drift.
#
# Connection comes from the usual PG* environment variables. The script creates
# and drops its own database, so it needs a role that may do both.
#
# pg_cron is Supabase-managed and cannot be installed on a bare Postgres: the
# stubs file provides cron.schedule / cron.unschedule, and the one
# `create extension` line (0002) is stripped at apply time. Nothing else is
# edited on the way in — a migration that only applies with hand edits is a
# migration that will fail on the day it is needed.
set -euo pipefail

cd "$(dirname "$0")/../.."

DB="${CI_DB_NAME:-leadtest_ci}"
PSQL=(psql -v ON_ERROR_STOP=1 -q -X)

psql -X -q -c "drop database if exists $DB" >/dev/null
psql -X -q -c "create database $DB" >/dev/null

"${PSQL[@]}" -d "$DB" -f supabase/tests/_local_supabase_stubs.sql

count=0
for f in supabase/migrations/*.sql; do
  sed '/create extension if not exists pg_cron/d' "$f" | "${PSQL[@]}" -d "$DB"
  count=$((count + 1))
done
echo "applied $count migrations"

tests=(supabase/tests/*_test.sql)
if [ "${#tests[@]}" -eq 0 ] || [ ! -e "${tests[0]}" ]; then
  echo "no SQL test files matched supabase/tests/*_test.sql — passing with zero tests is not a pass" >&2
  exit 1
fi
for t in "${tests[@]}"; do
  "${PSQL[@]}" -d "$DB" -f "$t"
done
echo "ran ${#tests[@]} SQL suites"

psql -X -q -c "drop database $DB" >/dev/null
