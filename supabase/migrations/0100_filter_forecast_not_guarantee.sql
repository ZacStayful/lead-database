-- ============================================================================
-- The filter volume FORECAST — 0098's guarantee, with the promise removed.
--
-- 0098 turned the volume estimate into a priced commitment: a guaranteed number
-- of leads, and a shortfall credited to lead_balance at each renewal. The model
-- behind it was sound and is kept in full. The framing was not, and is removed
-- here.
--
-- WHY
-- ---------------------------------------------------------------------------
-- The number 0098 called a guarantee is the largest N with P(X >= N) >= 0.83.
-- A figure carrying a 17% miss rate BY CONSTRUCTION is not a guarantee, and
-- 0098's own notes said as much — it recorded "a shortfall roughly one month in
-- six" as a known gap while the UI promised the opposite. Calling it a forecast
-- and showing the confidence beside it is the honest version of the same
-- arithmetic.
--
-- So the customer is now TOLD what to expect and how sure we are, and is owed
-- nothing when a month comes up short. What survives is descriptive; what is
-- dropped is everything that only existed to pay out.
--
-- NOTHING IS RECOMPUTED HERE. src/lib/filterForecast.ts (renamed from
-- filterGuarantee.ts) is still the only place the numbers are derived, and its
-- arithmetic is untouched by this change — same negative binomial, same 0.83,
-- same allocation cap, same monotonicity.
--
-- WHY THIS IS A RENAME AND NOT A DEPRECATION
-- ---------------------------------------------------------------------------
-- Renaming a live column is normally the wrong move: a deployed reader breaks
-- the moment the name changes. That risk is absent here and was verified rather
-- than assumed. 0098 shipped to the database but its CODE has never been
-- deployed — production runs from `main`, which selects none of these columns —
-- so at the time of writing all 14 columns are NULL across all 38 customers and
-- both new tables are empty. There is no reader to break and no data to
-- migrate. Leaving `filter_guaranteed_leads` in the schema to mean "expected"
-- would be a permanent lie in the one place that is hardest to correct later.
--
-- WHAT IS DROPPED, AND WHY EACH
-- ---------------------------------------------------------------------------
--   filter_guarantee_credit      — the protected shortfall counter. It existed
--                                  so the re-apply clamp could avoid
--                                  confiscating compensation we owed. Nothing
--                                  is owed now, so the clamp goes back to the
--                                  plain Math.min it was before 0098.
--   filter_guarantee_settlements — one row per settled cycle. There are no
--                                  cycles to settle.
--   settle_filter_guarantee()    — the payout itself.
--
-- Dropping the function also retires 0098's settle-before-lift ordering trap:
-- there is no longer a second writer racing execute_filter_lift for the same
-- customer, so the two call sites in the Stripe webhook simply go away.
--
-- WHAT IS KEPT
-- ---------------------------------------------------------------------------
-- The acceptance history, renamed to filter_forecast_acknowledgements. A
-- customer is still shown specific figures at the moment they apply, and still
-- ticks to say they have read them. "You told me four a month" is a question
-- worth being able to answer even when the answer carries no liability, and the
-- table is the only place that record exists.
--
-- NO EXISTING PRIVILEGED FUNCTION IS TOUCHED — same rule 0098 set for itself
-- (the ACL trap in CLAUDE.md §11): not credit_invoice, not execute_filter_lift,
-- not reset_monthly_counts. Dropping a function this migration's predecessor
-- created is not a create-or-replace of somebody else's grants.
--
-- Re-runnable: every statement is guarded.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 — Drop the CHECK before renaming the columns it names.
--
-- A constraint follows its columns through a rename, so leaving it would leave
-- a constraint named ..._filter_guarantee_check policing forecast columns and
-- still requiring the credit column this migration removes. Re-added in §4
-- against the new names.
-- ---------------------------------------------------------------------------
do $$
declare
  p text;
begin
  foreach p in array array['', 'gr_'] loop
    execute format(
      'alter table public.customers drop constraint if exists customers_%sfilter_guarantee_check',
      p
    );
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2 — Rename the six surviving columns, per product.
--
-- `filter_guaranteed_leads` becomes `filter_expected_leads` rather than
-- `filter_forecast_leads` because it is the number a customer reads as "what
-- I'll get"; the other five are the workings behind it and take the
-- `filter_forecast_` prefix.
--
-- Guarded individually: `if exists` on the old name is not enough on a re-run,
-- because after the first pass the OLD name is gone and the NEW one is present,
-- and `alter ... rename` has no `if not exists`. Checking for the new name is
-- what makes a second run a no-op instead of an error.
-- ---------------------------------------------------------------------------
do $$
declare
  p text;
  r record;
begin
  foreach p in array array['', 'gr_'] loop
    for r in
      select * from (values
        ('filter_guaranteed_leads',              'filter_expected_leads'),
        ('filter_guarantee_estimate',            'filter_forecast_estimate'),
        ('filter_guarantee_likelihood_pct',      'filter_forecast_likelihood_pct'),
        ('filter_guarantee_cost_per_lead_pence', 'filter_forecast_cost_per_lead_pence'),
        ('filter_guarantee_plan_price_pence',    'filter_forecast_plan_price_pence'),
        ('filter_guarantee_accepted_at',         'filter_forecast_acknowledged_at')
      ) as t(old_name, new_name)
    loop
      if exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'customers'
          and column_name = p || r.old_name
      ) and not exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'customers'
          and column_name = p || r.new_name
      ) then
        execute format(
          'alter table public.customers rename column %I to %I',
          p || r.old_name, p || r.new_name
        );
      end if;
    end loop;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 3 — Drop what only served the payout.
-- ---------------------------------------------------------------------------
alter table public.customers
  drop column if exists filter_guarantee_credit,
  drop column if exists gr_filter_guarantee_credit;

drop function if exists public.settle_filter_guarantee(
  uuid, public.lead_type, date, date, text
);

drop table if exists public.filter_guarantee_settlements;

-- ---------------------------------------------------------------------------
-- 4 — Re-add the CHECK against the new names, minus the credit clause.
--
-- Same bounds as 0098: counts non-negative, likelihood a percentage, money
-- strictly positive (a zero cost per lead would mean a free plan, and a zero
-- plan price means the row was written from a plan we could not resolve —
-- both are bugs worth refusing rather than storing).
-- ---------------------------------------------------------------------------
do $$
declare
  p text;
begin
  foreach p in array array['', 'gr_'] loop
    -- Drop-then-add, as 0098 did. Without the drop this migration is not
    -- re-runnable: §1 only drops the GUARANTEE-named constraint, so a second
    -- pass finds the forecast-named one already present and fails.
    execute format(
      'alter table public.customers drop constraint if exists customers_%sfilter_forecast_check',
      p
    );
    execute format($f$
      alter table public.customers add constraint customers_%sfilter_forecast_check check (
        (%1$sfilter_expected_leads is null or %1$sfilter_expected_leads >= 0)
        and (%1$sfilter_forecast_estimate is null or %1$sfilter_forecast_estimate >= 0)
        and (%1$sfilter_forecast_likelihood_pct is null
             or %1$sfilter_forecast_likelihood_pct between 0 and 100)
        and (%1$sfilter_forecast_cost_per_lead_pence is null
             or %1$sfilter_forecast_cost_per_lead_pence > 0)
        and (%1$sfilter_forecast_plan_price_pence is null
             or %1$sfilter_forecast_plan_price_pence > 0)
      )
    $f$, p);
  end loop;
end $$;

comment on column public.customers.filter_expected_leads is
  'Leads/month this filter is forecast to deliver, at FORECAST_CONFIDENCE. A LOWER BOUND, not a mean, and not a commitment — nothing is credited if a month falls short. NULL = no filter in force. Read only while filter_status is active or pending_lift.';
comment on column public.customers.filter_forecast_likelihood_pct is
  'P(delivered >= filter_expected_leads), whole percent floored. Always >= 83 when a forecast was offerable. Shown beside the figure so the bound is never read as a promise.';

-- ---------------------------------------------------------------------------
-- 5 — The acknowledgement history keeps its rows and loses the word.
--
-- Renamed rather than recreated so the table, its FK and its RLS state survive
-- as one object. `guaranteed_leads` becomes `expected_leads` to match §2.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.filter_guarantee_acceptances') is not null
     and to_regclass('public.filter_forecast_acknowledgements') is null then
    alter table public.filter_guarantee_acceptances
      rename to filter_forecast_acknowledgements;
  end if;
end $$;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'filter_forecast_acknowledgements'
      and column_name = 'guaranteed_leads'
  ) then
    alter table public.filter_forecast_acknowledgements
      rename column guaranteed_leads to expected_leads;
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'filter_forecast_acknowledgements'
      and column_name = 'accepted_by_user_id'
  ) then
    alter table public.filter_forecast_acknowledgements
      rename column accepted_by_user_id to acknowledged_by_user_id;
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'filter_forecast_acknowledgements'
      and column_name = 'accepted_at'
  ) then
    alter table public.filter_forecast_acknowledgements
      rename column accepted_at to acknowledged_at;
  end if;
end $$;

alter index if exists idx_filter_guarantee_acceptances_customer
  rename to idx_filter_forecast_acknowledgements_customer;

-- RLS stays enabled with NO policy — deny-all to the browser, as
-- subscription_pauses and operator_proof_snapshots. Re-asserted because the
-- rename above does not change it and a rebuilt schema must not miss it.
alter table public.filter_forecast_acknowledgements enable row level security;

comment on table public.filter_forecast_acknowledgements is
  'What figures a customer was shown when they applied a filter, and when they acknowledged them. Best-effort audit trail: LIVE state is customers.(gr_)filter_expected_leads, never this table. Carries no liability — a forecast is not a guarantee.';
