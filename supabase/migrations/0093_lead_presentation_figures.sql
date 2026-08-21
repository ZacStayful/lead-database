-- ---------------------------------------------------------------------------
-- 0093 — Everything else the analysis states, so a lead can pre-fill the
--        income presentation an operator walks a landlord through.
--
-- `public/income-presentation/` has existed for a while and every management
-- customer reaches it from Documents. Until now the operator typed every figure
-- into it by hand — the tool's own copy says "enter your own numbers, or bring
-- them across from the STR Analyser" — while the PDF we already download states
-- all of them. 0089 and 0090 took three numbers out of that report; this takes
-- the rest.
--
-- WHAT IS DELIBERATELY NOT TAKEN FROM THE REPORT: the management fee. The PDF
-- charges 15% OF GROSS, because that is STAYFUL'S fee. The operator presenting
-- is not Stayful, and seeding our fee would have them quote it to a landlord as
-- their own. Their fee, their contract terms and their process live in
-- customers.presentation_settings below and never come from a lead. See §26.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1 — The rest of the report's figures.
--
-- All nullable, all FAILING ALONE. Gross remains the only figure whose absence
-- fails the whole parse (§25): 149 leads are live with a gross today, and a
-- regression that blanked them because a platform-fee percentage could not be
-- read would trade a working figure for a missing one.
-- ---------------------------------------------------------------------------
alter table public.leads
  add column if not exists net_annual_income       numeric,
  add column if not exists long_let_annual_income  numeric,
  add column if not exists platform_fee_pct        numeric,
  add column if not exists cleaning_fee_pct        numeric,
  add column if not exists monthly_revenue_profile numeric[];

comment on column public.leads.net_annual_income is
  'NET ANNUAL REVENUE from the report''s Short-Term Rental breakdown — what the '
  'landlord keeps after platform, management and cleaning at STAYFUL''S fee '
  'structure. '
  'RENDERED NOWHERE, deliberately. The presentation computes its own net from '
  'the operator''s fee, which is not ours, so this figure would disagree with '
  'what the operator shows a landlord. It is stored because gross minus the '
  'report''s own total operating costs must equal it — the strongest '
  'corroboration available that the breakdown table was read coherently rather '
  'than a match straddling two unrelated cells.';

comment on column public.leads.long_let_annual_income is
  'Gross Rental Income from the report''s Long-Term Let table — the annual rent '
  'the property would fetch on an ordinary tenancy. GROSS, not the net the '
  'report''s own headline comparison uses, because it seeds a presentation '
  'field labelled "Current long-let income" and that is what a landlord''s rent '
  'actually is. Consequence: our uplift-vs-long-let reads higher than the '
  'report''s own.';

comment on column public.leads.platform_fee_pct is
  'Platform commission as the percentage the report prints (15, not 0.15). '
  'Stored only when the money on that line equals gross x pct.';

comment on column public.leads.cleaning_fee_pct is
  'Cleaning and laundry as a percentage of gross, same rule as '
  'platform_fee_pct. Both are operating facts about the market, which is why '
  'they DO come from the report where the management fee does not.';

comment on column public.leads.monthly_revenue_profile is
  'The report''s twelve-month forecast, January first, in the order printed. '
  'Used as a SEASONAL SHAPE rather than as absolute figures: they are net at '
  'Stayful''s fee and would not sum to the operator''s own net, so the '
  'presentation scales them. Exactly twelve elements or null — see the CHECK.';

-- Twelve or nothing. A partial forecast is not a curve, and a shape built from
-- nine months would silently misprice a season.
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'leads_monthly_revenue_profile_len'
  ) then
    alter table public.leads
      add constraint leads_monthly_revenue_profile_len
      check (
        monthly_revenue_profile is null
        or cardinality(monthly_revenue_profile) = 12
      );
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2 — The operator's own half of the presentation.
--
-- One jsonb blob on customers rather than a table, following
-- notification_preferences (0034): it is read by one route and by
-- getCurrentCustomer()'s select("*") on the service role, and a table would buy
-- a join for nothing. There is no write policy on customers and this does not
-- add one — the settings route writes on the service role like everything else
-- (invariant 7).
--
-- THE TIMESTAMP IS THE "HAS THIS BEEN SET UP" TEST, not the blob's emptiness.
-- A customer who deliberately saves a profile identical to the defaults HAS
-- configured it, and inferring "never set" from the contents would call them
-- unconfigured for ever and nag them about it. Null means never set — the same
-- NULL-is-not-zero distinction §13 draws for management_customer_goal.
--
-- It is also what the tool compares against to notice that a lead was seeded
-- before the profile existed, so it can offer to apply the new terms rather
-- than silently overwriting an operator's edits.
-- ---------------------------------------------------------------------------
alter table public.customers
  add column if not exists presentation_settings            jsonb not null default '{}'::jsonb,
  add column if not exists presentation_settings_updated_at timestamptz;

comment on column public.customers.presentation_settings is
  'The operator''s own half of the income presentation: their management fee '
  'and its basis, cleaning treatment, contract terms, compliance and vetting '
  'wording, onboarding steps, what they manage, the landlord''s '
  'responsibilities, and their discovery and next-step lists. Validated '
  'against a key whitelist in src/lib/presentationSettings.ts — an unbounded '
  'blob written from the browser into a column read on every dashboard load is '
  'its own problem. Never contains anything read from a lead.';

comment on column public.customers.presentation_settings_updated_at is
  'When the profile was last saved. NULL means never set, which is what the '
  'dashboard and the tool prompt on. Not derived from the blob being empty: a '
  'profile deliberately saved as the defaults is configured.';
