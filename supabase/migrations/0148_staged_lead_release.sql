-- ============================================================================
-- 0148 — One lead a working day (CLAUDE.md §54)
--
-- Leads are sold as a monthly allocation and, measured on production over 90
-- days, the whole allocation lands in one go: 81% of management leads arrive in
-- the first week of a customer's cycle, a typical delivery day drops 8 on one
-- customer, and customers average TWO delivery days a month. §42 measured what
-- that costs — 97 of 121 first touches abandoned the same day.
--
-- This migration makes ordinary routing release a customer's leads at ONE PER
-- UK WORKING DAY (a 10-lead plan: one every other working day), so each is
-- worked while fresh and the dashboard is opened every morning.
--
-- THE RULE, per product (gr_ columns for GR — invariant 6):
--
--   anchor    := coalesce((gr_)billing_cycle_anchor, created_at::date)
--   today     := (now() at time zone 'Europe/London')::date
--   W         := working days (Mon–Fri) in [anchor, anchor + cycle_days)
--   k         := working days (Mon–Fri) in [anchor, today]
--   E         := (gr_)leads_received_this_month + (gr_)lead_balance
--   allowance := least(E, ceil(k * E / W))
--   today_n   := assignments to this customer+product dated today (London)
--   allow     := release_enabled is false
--             or release_mode = 'immediate'
--             or (today >= coalesce((gr_)release_hold_until, today)
--                 and received_this_month < allowance
--                 and today_n < release_max_per_day)
--
-- WHY THE ENTITLEMENT (E) AND NOT monthly_allocation. Computing the curve on the
-- plan would strand a top-up's credits until month end; computing it on what
-- the customer is actually owed this cycle drips a top-up, or credits carried
-- over from a short month, at the daily cap. Pool debit needs no special case:
-- a claim either spends a credit (E unchanged) or adds debit at zero balance.
--
-- WHY WEEKDAYS ONLY, WITH NO BANK-HOLIDAY TABLE. businessTime.ts reads gov.uk
-- live and cannot be called from SQL. A bank holiday counts as a working day
-- for the schedule; a lead arriving on one simply waits to be opened.
--
-- WHY THE CAP IS PER LONDON DAY. Vercel runs in UTC and Britain is an hour
-- ahead for half the year (§40.12). A cap keyed on the UTC date would let two
-- leads through between 23:00 and 01:00 London time.
--
-- ⚠️ A STALE ANCHOR SATURATES k AND THE RULE LETS EVERYTHING THROUGH. That is
-- why the invoice.period_start bug (§11) had to be fixed first and why the
-- admin allocation page prints anchor age.
--
-- WHERE THE PREDICATE IS ASSERTED — AND WHERE IT DELIBERATELY IS NOT:
--   get_filtered_candidates_for_lead     gated (one clause added to the WHERE)
--   get_unfiltered_candidates_for_lead   gated (same)
--   get_next_customers_for_lead          UNTOUCHED — not on the ingest path;
--                                        inactivity-nudge reads it for nudge
--                                        eligibility, and a quota must never
--                                        suppress a reminder
--   assign_lead_to_customer              UNTOUCHED — admin force-assign, swaps,
--                                        dead-lead replacements and escalation
--                                        pass through it and must not be
--                                        rationed; the money path stays the
--                                        money path
--   claim_pool_lead / admin_assign_lead  UNTOUCHED — a claim is the customer's
--                                        own act; an admin decision is an
--                                        admin decision
--
-- Both candidate bodies are 0107's with the one clause added. 0111 and 0114
-- state they left them alone; 0139–0147 do not touch them. Production's prosrc
-- was diffed against 0107 before this was applied.
--
-- INERT ON APPLY: `release_enabled` ships false, every column defaults to
-- today's meaning, and with the switch off both candidate functions return
-- byte-identical lists (asserted over the live book before merge).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Settings — all on conflict do nothing, so a re-apply changes nothing
-- ---------------------------------------------------------------------------
insert into public.system_settings (key, value) values
  ('release_enabled', 'false'),
  ('release_max_per_day', '2'),
  ('release_cycle_days', '30'),
  ('release_hold_max_days', '14')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Per-customer state
--
-- release_mode:  'daily' (the rule) or 'immediate' (exempt — an operator who
--                genuinely wants the batch on renewal day, or one an admin is
--                placating). Admin-set only; never customer-settable, or every
--                customer picks it on day one.
-- release_hold_until / gr_release_hold_until: "I'm away until <date> — hold my
--                leads." NOT a pause: billing continues, credits are kept,
--                nothing is voided; the entitlement catches up at the cap when
--                the hold ends. Customer-settable, bounded by
--                release_hold_max_days at the route.
-- ---------------------------------------------------------------------------
alter table public.customers
  add column if not exists release_mode text not null default 'daily',
  add column if not exists release_hold_until date,
  add column if not exists gr_release_hold_until date;

alter table public.customers drop constraint if exists customers_release_mode_valid;
alter table public.customers
  add constraint customers_release_mode_valid
  check (release_mode in ('daily', 'immediate'));

-- ---------------------------------------------------------------------------
-- 3. Working days between two dates, inclusive of both ends. Mon–Fri only.
-- ---------------------------------------------------------------------------
create or replace function public.working_days_between(p_from date, p_to date)
returns integer
language sql
immutable
set search_path = public
as $$
  select case
    when p_from is null or p_to is null or p_to < p_from then 0
    else (
      select count(*)::integer
      from generate_series(p_from, p_to, interval '1 day') d
      where extract(isodow from d) < 6
    )
  end;
$$;

revoke execute on function public.working_days_between(date, date) from public, anon, authenticated;
grant execute on function public.working_days_between(date, date) to service_role;

-- ---------------------------------------------------------------------------
-- 4. The rule. Returns true when ordinary routing may hand this customer one
--    more lead of this product today. Mirrored in TypeScript by
--    releaseSchedule() in src/lib/pacing.ts for DISPLAY ONLY — this is the
--    gate; the two must change in one commit.
-- ---------------------------------------------------------------------------
create or replace function public.customer_release_allows(
  p_customer_id uuid,
  p_lead_type public.lead_type default 'management'
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_enabled     boolean;
  v_max_per_day integer;
  v_cycle_days  integer;
  v_c           public.customers%rowtype;
  v_anchor      date;
  v_hold        date;
  v_received    integer;
  v_balance     integer;
  v_today       date := (now() at time zone 'Europe/London')::date;
  v_w           integer;
  v_k           integer;
  v_e           integer;
  v_allowance   integer;
  v_today_n     integer;
begin
  select coalesce(btrim(value) = 'true', false) into v_enabled
    from public.system_settings where key = 'release_enabled';
  if not coalesce(v_enabled, false) then
    return true;
  end if;

  select * into v_c from public.customers where id = p_customer_id;
  if not found then
    return false;
  end if;
  if v_c.release_mode = 'immediate' then
    return true;
  end if;

  v_max_per_day := greatest(public.pool_setting_int('release_max_per_day', 2), 1);
  v_cycle_days  := greatest(public.pool_setting_int('release_cycle_days', 30), 1);

  if p_lead_type = 'guaranteed_rent' then
    v_anchor   := coalesce(v_c.gr_billing_cycle_anchor, v_c.created_at::date);
    v_hold     := v_c.gr_release_hold_until;
    v_received := coalesce(v_c.gr_leads_received_this_month, 0);
    v_balance  := coalesce(v_c.gr_lead_balance, 0);
  else
    v_anchor   := coalesce(v_c.billing_cycle_anchor, v_c.created_at::date);
    v_hold     := v_c.release_hold_until;
    v_received := coalesce(v_c.leads_received_this_month, 0);
    v_balance  := coalesce(v_c.lead_balance, 0);
  end if;

  -- A hold refuses outright; the day it names is the day leads resume.
  if v_hold is not null and v_today < v_hold then
    return false;
  end if;

  v_e := v_received + v_balance;
  if v_e <= 0 then
    return false;
  end if;

  v_w := greatest(public.working_days_between(v_anchor, v_anchor + (v_cycle_days - 1)), 1);
  v_k := public.working_days_between(v_anchor, v_today);
  v_allowance := least(v_e, ceil((v_k::numeric * v_e) / v_w)::integer);

  if v_received >= v_allowance then
    return false;
  end if;

  select count(*)::integer into v_today_n
    from public.lead_assignments la
    join public.leads l on l.id = la.lead_id
   where la.customer_id = p_customer_id
     and l.lead_type = p_lead_type
     and (la.assigned_at at time zone 'Europe/London')::date = v_today;

  return v_today_n < v_max_per_day;
end;
$$;

revoke execute on function public.customer_release_allows(uuid, public.lead_type) from public, anon, authenticated;
grant execute on function public.customer_release_allows(uuid, public.lead_type) to service_role;

-- ---------------------------------------------------------------------------
-- 5. The two ordinary-routing candidate functions — 0107's bodies with ONE
--    clause added to each WHERE. Signatures unchanged, so no overload risk
--    (§34/§35). ACLs re-asserted (§11).
-- ---------------------------------------------------------------------------
create or replace function public.get_filtered_candidates_for_lead(
  p_lead_id uuid,
  p_max integer,
  p_lead_type public.lead_type default 'management'
)
returns table (customer_id uuid, priority_score numeric)
language sql
security definer
set search_path = public
as $$
  with l as (
    select
      postcode_area as area,
      nullif(substring(coalesce(bedrooms, '') from '\d+'), '')::int as bed
    from public.leads
    where id = p_lead_id
  )
  select
    c.id,
    case
      when p_lead_type = 'guaranteed_rent' then
        round(
          (least(greatest(
            extract(day from now() - coalesce(c.gr_billing_cycle_anchor, c.created_at::date)),
            0), 30) / 30.0)
          * public.effective_allocation(c.gr_monthly_allocation, c.gr_pool_debit)
        ) - c.gr_leads_received_this_month
      else
        round(
          (least(greatest(
            extract(day from now() - coalesce(c.billing_cycle_anchor, c.created_at::date)),
            0), 30) / 30.0)
          * public.effective_allocation(c.monthly_allocation, c.pool_debit)
        ) - c.leads_received_this_month
    end as priority_score
  from public.customers c, l
  where not public.lead_retired_from_allocation(p_lead_id)
    and c.is_active = true
    and l.area is not null
    and l.bed is not null
    and not exists (
      select 1 from public.lead_assignments la
      where la.lead_id = p_lead_id and la.customer_id = c.id
    )
    -- The customer who UPLOADED a lead is never a candidate for it: they
    -- already have it on their own system. Their own assignment row used to
    -- cover this through the `not exists` above, but delete-own-copy (0107)
    -- lets them remove that row while the lead lives on with its buyer — so
    -- without this clause they would become eligible for their own lead.
    -- `is distinct from` leaves marketplace leads (owner null) untouched.
    and c.id is distinct from (
      select l_owner.owner_customer_id
      from public.leads l_owner
      where l_owner.id = p_lead_id
    )
    and (
      (
        p_lead_type = 'management'
        and c.account_status = 'active'
        and c.subscription_status = 'active'
        and c.lead_balance > 0
        and c.paused_at is null
        and c.filter_status in ('active', 'pending_lift')
        and (
          c.filter_areas is null
          or array_length(c.filter_areas, 1) is null
          or l.area = any (c.filter_areas)
        )
        and (c.filter_min_bedrooms is null or l.bed >= c.filter_min_bedrooms)
        and (c.filter_max_bedrooms is null or l.bed <= c.filter_max_bedrooms)
      )
      or
      (
        p_lead_type = 'guaranteed_rent'
        and c.gr_subscription_status = 'active'
        and c.gr_lead_balance > 0
        and c.gr_filter_status in ('active', 'pending_lift')
        and (
          c.gr_filter_areas is null
          or array_length(c.gr_filter_areas, 1) is null
          or l.area = any (c.gr_filter_areas)
        )
        and (c.gr_filter_min_bedrooms is null or l.bed >= c.gr_filter_min_bedrooms)
        and (c.gr_filter_max_bedrooms is null or l.bed <= c.gr_filter_max_bedrooms)
      )
    )
    -- 0148: one lead a working day. Inert while release_enabled is false.
    and public.customer_release_allows(c.id, p_lead_type)
  order by
    priority_score desc,
    case when p_lead_type = 'guaranteed_rent' then c.gr_last_assignment_at
         else c.last_assignment_at end asc nulls first,
    c.created_at asc
  limit p_max;
$$;

revoke execute on function public.get_filtered_candidates_for_lead(uuid, integer, public.lead_type) from public, anon, authenticated;
grant execute on function public.get_filtered_candidates_for_lead(uuid, integer, public.lead_type) to service_role;

create or replace function public.get_unfiltered_candidates_for_lead(
  p_lead_id uuid,
  p_max integer,
  p_lead_type public.lead_type default 'management'
)
returns table (customer_id uuid, deficit numeric)
language sql
security definer
set search_path = public
as $$
  select
    c.id,
    case
      when p_lead_type = 'guaranteed_rent' then
        round(
          (least(greatest(
            extract(day from now() - coalesce(c.gr_billing_cycle_anchor, c.created_at::date)),
            0), 30) / 30.0)
          * public.effective_allocation(c.gr_monthly_allocation, c.gr_pool_debit)
        ) - c.gr_leads_received_this_month
      else
        round(
          (least(greatest(
            extract(day from now() - coalesce(c.billing_cycle_anchor, c.created_at::date)),
            0), 30) / 30.0)
          * public.effective_allocation(c.monthly_allocation, c.pool_debit)
        ) - c.leads_received_this_month
    end as deficit
  from public.customers c
  where not public.lead_retired_from_allocation(p_lead_id)
    and c.is_active = true
    and not exists (
      select 1 from public.lead_assignments la
      where la.lead_id = p_lead_id and la.customer_id = c.id
    )
    -- The customer who UPLOADED a lead is never a candidate for it: they
    -- already have it on their own system. Their own assignment row used to
    -- cover this through the `not exists` above, but delete-own-copy (0107)
    -- lets them remove that row while the lead lives on with its buyer — so
    -- without this clause they would become eligible for their own lead.
    -- `is distinct from` leaves marketplace leads (owner null) untouched.
    and c.id is distinct from (
      select l_owner.owner_customer_id
      from public.leads l_owner
      where l_owner.id = p_lead_id
    )
    and (
      (
        p_lead_type = 'management'
        and c.account_status = 'active'
        and c.subscription_status = 'active'
        and c.lead_balance > 0
        and c.paused_at is null
        and c.filter_status = 'off'
      )
      or (
        p_lead_type = 'guaranteed_rent'
        and c.gr_subscription_status = 'active'
        and c.gr_lead_balance > 0
        and c.gr_filter_status = 'off'
      )
    )
    -- 0148: one lead a working day. Inert while release_enabled is false.
    and public.customer_release_allows(c.id, p_lead_type)
  order by
    deficit desc,
    case when p_lead_type = 'guaranteed_rent' then c.gr_last_assignment_at
         else c.last_assignment_at end asc nulls first,
    c.created_at asc
  limit p_max;
$$;

revoke execute on function public.get_unfiltered_candidates_for_lead(uuid, integer, public.lead_type) from public, anon, authenticated;
grant execute on function public.get_unfiltered_candidates_for_lead(uuid, integer, public.lead_type) to service_role;
