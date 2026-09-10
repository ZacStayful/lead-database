# Database tests

SQL-level tests for the parts of the schema where the money moves. They run
against a throwaway local Postgres, not a Supabase project, so they cost
nothing and can be run as often as you like.

CI runs exactly the same script on every pull request — see the `database` job
in `.github/workflows/ci.yml`.

## Running them

You need `psql` on your PATH and a Postgres to point it at. Connection details
come from the usual `PG*` environment variables.

```bash
# Against a Postgres you already have running:
PGHOST=localhost PGPORT=5432 PGUSER=postgres supabase/tests/verify.sh
```

To spin one up from scratch:

```bash
export PGDATA=/tmp/leaddb
initdb -D "$PGDATA" -A trust -U postgres
pg_ctl -D "$PGDATA" -o '-p 55432' -l /tmp/pg.log start

PGHOST=localhost PGPORT=55432 PGUSER=postgres supabase/tests/verify.sh
```

A passing run ends with `Database verification passed` and exits 0.

## What `verify.sh` does

1. **Applies every migration in order** to a scratch database. This is the
   upgrade path production will actually take, so a migration that only works
   on a fresh database gets caught here.
2. **Runs the SQL test suite** against the result.
3. **Applies `schema.sql` to a second, empty database**, twice, and compares the
   two databases column for column, function for function, constraint for
   constraint. That snapshot is maintained by hand, so this is the thing that
   stops it drifting from the migrations — and the second application is what
   proves the file really is idempotent, as its header claims.

`pg_cron` is a Supabase-managed extension that cannot be installed locally, so
the `create extension` line is stripped and the two calls the migrations make
are stubbed. Everything else the Supabase platform provides — `auth.uid()`,
`storage.buckets`, the realtime publication — is stubbed in
`_local_supabase_stubs.sql`.

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

`npm test` runs `scripts/assert-tests-found.mjs` first. `node --test` exits 0
when its glob matches nothing, so without that guard a renamed directory would
turn the test step green while running nothing.

## Adding a test file

Anything matching `supabase/tests/*_test.sql` is picked up automatically. Write
assertions with the helper the suite defines:

```sql
select test_util.assert_eq(actual, expected, 'what this proves');
```

It raises on a mismatch, so a failure stops the run and fails CI. The helper
lives in the `test_util` schema deliberately: anything created in `public`
would show up as drift in step 3 above.
