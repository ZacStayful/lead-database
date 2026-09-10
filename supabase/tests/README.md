# Database tests

SQL-level tests for the parts of the schema where the money moves. They run
against a throwaway local Postgres, not a Supabase project, so they cost
nothing and can be run as often as you like.

## Running them

```bash
# 1. Start a scratch Postgres (any port you like)
export PGDATA=/tmp/pgdata
initdb -D "$PGDATA" -A trust -U postgres
pg_ctl -D "$PGDATA" -o '-p 55432 -k /tmp' -l /tmp/pg.log start

# 2. Create the database and stub the Supabase platform objects the
#    migrations reference (auth.uid, storage.buckets, the realtime
#    publication, pg_cron).
psql -h /tmp -p 55432 -U postgres -c 'create database mig'
psql -h /tmp -p 55432 -U postgres -d mig -f supabase/tests/_local_supabase_stubs.sql

# 3. Apply every migration in order. pg_cron cannot be installed locally, so
#    the create-extension line is stripped; the stubs cover the two calls.
for f in supabase/migrations/*.sql; do
  sed '/create extension if not exists pg_cron/d' "$f" \
    | psql -h /tmp -p 55432 -U postgres -v ON_ERROR_STOP=1 -q -d mig
done

# 4. Run the tests.
psql -h /tmp -p 55432 -U postgres -d mig -v ON_ERROR_STOP=1 -q \
  -f supabase/tests/0027_lead_quality_test.sql
```

A passing run ends with `ALL BEHAVIOURAL TESTS PASSED` and exits 0. Any failed
assertion raises and stops the script.

## What `0027_lead_quality_test.sql` covers

The invariants that would cost real money or real trust if they broke:

- a lead goes to three operators and a fourth is refused
- an upheld quality claim restores exactly one credit, rolls back the monthly
  counter, spends allowance and resets the clean streak
- **an upheld claim does not reopen the slot** — the claimed lead stays with the
  operators who kept it and is never resold, and `invalid_contact` behaves the
  same way
- claiming twice is an idempotent no-op, so nobody can double-refund
- a lead is only flagged `dead` once every assigned operator has written it off,
  and a dead lead is never assigned again
- corroborated claims cost no allowance
- `find_replacement_lead` honours the city and bedroom filters, skips leads the
  customer already holds, and returns null rather than a bad match
- the backfill queue is oldest-first and excludes dead leads
- a review decision applies once and only once
- an ineligible report is recorded as feedback but leaves the assignment
  claimable
- `reset_monthly_counts` zeroes the allowance on the customer's anchor day and
  leaves it alone on every other day

The claim policy itself (the window, the effort gate, the hidden allowance
maths, peer corroboration and contradiction) is unit-tested separately in
`src/lib/quality/claimPolicy.test.ts` — run it with `npm test`.
