# Database tests

SQL-level tests for the parts of the schema where money moves. They run against
a throwaway local Postgres, never a Supabase project, so they cost nothing and
can be run as often as you like.

## Running them

```bash
export PGDATA=/tmp/leaddb
initdb -D "$PGDATA" -A trust -U postgres
pg_ctl -D "$PGDATA" -o '-p 55440' -l /tmp/pg.log start

export PGHOST=localhost PGPORT=55440 PGUSER=postgres
psql -c 'create database leadtest'
psql -d leadtest -f supabase/tests/_local_supabase_stubs.sql

# pg_cron is Supabase-managed and cannot be installed here; the two calls the
# migrations make are stubbed above.
for f in supabase/migrations/*.sql; do
  sed '/create extension if not exists pg_cron/d' "$f" \
    | psql -v ON_ERROR_STOP=1 -q -d leadtest
done

psql -v ON_ERROR_STOP=1 -q -d leadtest -f supabase/tests/0137_dead_lead_claims_test.sql
```

A passing run ends with `0137 BEHAVIOURAL TESTS PASSED` and exits 0. Any failed
assertion raises and stops the script.

Note for §45.14: applying every migration in order from 0001 to 0137 succeeds on
Postgres 16. That section's warning about a rebuild failing at 0124 is stale,
as §48.10 already suspected.

## What `0137_dead_lead_claims_test.sql` covers

0137 amends **invariant 4**, so these assertions are all about money:

- **The effort gate.** A lead with no engagement events is not claimable. A
  `nudge_sent` alone does not qualify anyone — it is system-generated (§3), and
  counting it would let our own nudges qualify the least engaged customers. An
  operator `tel_click` does qualify it.
- **The bars.** Outside the claim window, already `won`, or claimed from the
  pool (§19.6, invariant 11) — none are claimable.
- **One credit, once.** An upheld claim restores exactly one credit, rolls back
  the monthly counter, spends one of the hidden allowance and resets the clean
  streak. A second claim on the same assignment is refused and the balance does
  not move.
- **The slot is not reopened.** `leads.assignment_count` is unchanged by an
  upheld claim, so a lead shown to be dead is never sold on to another operator.
- **Review applies once.** A second decision on a settled claim returns false
  and refunds nothing.
- **Corroboration is free.** A claim agreeing with an already-settled one spends
  no allowance.
- **Both products.** A guaranteed-rent claim refunds `gr_lead_balance` and
  leaves the management balance alone (invariant 6).
- **The allowance resets** on the customer's own billing anchor day, and holds
  on every other day.
- **Invariant 7.** `anon` and `authenticated` hold zero execute grants on any
  0137 function.

## Adding a test file

Write assertions with the helpers the suite defines:

```sql
select test_util.assert_eq(actual, expected, 'what this proves');
select test_util.assert_raises($q$ ... $q$, 'what must be refused');
```

Both raise on failure, so a failure stops the run. They live in the `test_util`
schema deliberately: anything created in `public` would show up as a difference
when a database built from migrations is compared against `supabase/schema.sql`.
