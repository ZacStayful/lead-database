-- ============================================================================
-- Lead filtering.
--
-- Lets a subscriber narrow the leads they are matched to by postcode area and
-- bedroom range, trading the volume guarantee for relevance. Adds:
--   * postcode / postcode_area columns on leads (extracted at ingest)
--   * a per-product filter (management + guaranteed_rent, gr_ mirror) on
--     customers: status, selected areas, bedroom bounds, timestamps
--   * two routing helpers so ingest can rank a filtered pool against the
--     existing unfiltered (deficit-first) pool, per lead type
--
-- SCHEMA-CONVENTION NOTE: this codebase models state columns as TEXT + CHECK,
-- not native enums (only lead_type is a native enum — see 0015). filter_status
-- therefore follows the account_status / pipeline_stage pattern (TEXT + CHECK),
-- not `create type`. All changes are additive: new nullable columns and new
-- functions only; nothing is dropped or renamed.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 — leads: extracted postcode + postcode area (letters before the first
-- digit). Both nullable; NULL when no postcode could be parsed from the
-- address. A lead with a NULL postcode_area (or NULL bedroom count) is never a
-- candidate for filtered routing, but stays fully available to the unfiltered
-- pool.
-- ---------------------------------------------------------------------------
alter table public.leads
  add column if not exists postcode      text,
  add column if not exists postcode_area text;

create index if not exists idx_leads_postcode_area on public.leads(postcode_area);

-- ---------------------------------------------------------------------------
-- 2 — customers: management filter columns.
-- filter_areas and the bedroom bounds are independently nullable — a customer
-- may set only areas, only a bedroom range, or both. min = max means "exactly N
-- bedrooms".
-- ---------------------------------------------------------------------------
alter table public.customers
  add column if not exists filter_status              text not null default 'off',
  add column if not exists filter_areas               text[],
  add column if not exists filter_min_bedrooms        integer,
  add column if not exists filter_max_bedrooms        integer,
  add column if not exists filter_enabled_at          timestamptz,
  add column if not exists filter_lift_effective_date date;

alter table public.customers
  drop constraint if exists customers_filter_status_check;
alter table public.customers
  add constraint customers_filter_status_check
  check (filter_status in ('off', 'active', 'pending_lift'));

-- ---------------------------------------------------------------------------
-- 3 — customers: guaranteed-rent filter columns (gr_ mirror of the above).
-- ---------------------------------------------------------------------------
alter table public.customers
  add column if not exists gr_filter_status              text not null default 'off',
  add column if not exists gr_filter_areas               text[],
  add column if not exists gr_filter_min_bedrooms        integer,
  add column if not exists gr_filter_max_bedrooms        integer,
  add column if not exists gr_filter_enabled_at          timestamptz,
  add column if not exists gr_filter_lift_effective_date date;

alter table public.customers
  drop constraint if exists customers_gr_filter_status_check;
alter table public.customers
  add constraint customers_gr_filter_status_check
  check (gr_filter_status in ('off', 'active', 'pending_lift'));

-- ---------------------------------------------------------------------------
-- 4 — filtered candidate pool for a lead.
--
-- Returns customers with an active (or pending_lift) filter for this lead type
-- whose criteria MATCH the lead, ranked by an internal priority_score:
--
--   expected_so_far = ROUND((days_elapsed / 30) * monthly_allocation)
--   priority_score  = expected_so_far - leads_received_this_month
--
-- (same day-elapsed proration as the unfiltered deficit formula, per product).
-- The score is internal only — used purely to rank filtered candidates against
-- each other; it is never surfaced to the customer.
--
-- Matching rules (per spec):
--   * The lead must have a non-NULL postcode_area AND a parseable bedroom count,
--     otherwise it is invisible to every filtered customer.
--   * area:     filter_areas empty  OR  lead.postcode_area = ANY(filter_areas)
--   * bedrooms: filter_min null OR bed >= min  AND  filter_max null OR bed <= max
-- pending_lift customers keep receiving only their filtered leads until cutover,
-- so they are included alongside 'active'.
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
      -- First run of digits in the free-text bedrooms field ("3", "3 bed",
      -- "2-3" -> 2). NULL when no digits present (e.g. "studio").
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
          * c.gr_monthly_allocation
        ) - c.gr_leads_received_this_month
      else
        round(
          (least(greatest(
            extract(day from now() - coalesce(c.billing_cycle_anchor, c.created_at::date)),
            0), 30) / 30.0)
          * c.monthly_allocation
        ) - c.leads_received_this_month
    end as priority_score
  from public.customers c, l
  where c.is_active = true
    and l.area is not null
    and l.bed is not null
    and not exists (
      select 1 from public.lead_assignments la
      where la.lead_id = p_lead_id and la.customer_id = c.id
    )
    and (
      (
        p_lead_type = 'management'
        and c.account_status = 'active'
        and c.subscription_status = 'active'
        and c.lead_balance > 0
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
  order by
    priority_score desc,
    case when p_lead_type = 'guaranteed_rent' then c.gr_last_assignment_at
         else c.last_assignment_at end asc nulls first,
    c.created_at asc
  limit p_max;
$$;

-- ---------------------------------------------------------------------------
-- 5 — unfiltered candidate pool for a lead.
--
-- The existing deficit-first pool, restricted to customers whose filter for
-- this product is OFF (filtered customers live exclusively in the pool above),
-- and now also returning the deficit so the caller can apply the guarantee-floor
-- override (assign a critically-behind unfiltered customer ahead of a filtered
-- one). Mirrors get_next_customers_for_lead's gates and ordering per lead type.
-- ---------------------------------------------------------------------------
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
          * c.gr_monthly_allocation
        ) - c.gr_leads_received_this_month
      else
        round(
          (least(greatest(
            extract(day from now() - coalesce(c.billing_cycle_anchor, c.created_at::date)),
            0), 30) / 30.0)
          * c.monthly_allocation
        ) - c.leads_received_this_month
    end as deficit
  from public.customers c
  where c.is_active = true
    and not exists (
      select 1 from public.lead_assignments la
      where la.lead_id = p_lead_id and la.customer_id = c.id
    )
    and (
      (
        p_lead_type = 'management'
        and c.account_status = 'active'
        and c.subscription_status = 'active'
        and c.lead_balance > 0
        and c.filter_status = 'off'
      )
      or (
        p_lead_type = 'guaranteed_rent'
        and c.gr_subscription_status = 'active'
        and c.gr_lead_balance > 0
        and c.gr_filter_status = 'off'
      )
    )
  order by
    deficit desc,
    case when p_lead_type = 'guaranteed_rent' then c.gr_last_assignment_at
         else c.last_assignment_at end asc nulls first,
    c.created_at asc
  limit p_max;
$$;

-- ---------------------------------------------------------------------------
-- 6 — execute a scheduled filter lift for a customer at their renewal.
--
-- Called from the invoice.paid webhook (the genuine per-customer renewal) when
-- a customer is in 'pending_lift'. Turns the filter off, clears the criteria and
-- the scheduled date, and resets the deficit starting point for that product to
-- THIS moment (anchor = today, monthly counter = 0) so the customer does not
-- read as artificially "critically behind" the instant they re-enter the
-- guarantee system. p_lead_type selects the product. Returns true if a lift was
-- executed (so the caller knows whether to send the completion notification).
-- ---------------------------------------------------------------------------
create or replace function public.execute_filter_lift(
  p_customer_id uuid,
  p_lead_type public.lead_type default 'management'
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_executed boolean := false;
begin
  if p_lead_type = 'guaranteed_rent' then
    update public.customers
      set gr_filter_status = 'off',
          gr_filter_areas = null,
          gr_filter_min_bedrooms = null,
          gr_filter_max_bedrooms = null,
          gr_filter_lift_effective_date = null,
          gr_filter_enabled_at = null,
          -- Fresh deficit baseline from this renewal moment.
          gr_leads_received_this_month = 0,
          gr_billing_cycle_anchor = current_date,
          updated_at = now()
      where id = p_customer_id and gr_filter_status = 'pending_lift';
    v_executed := found;
  else
    update public.customers
      set filter_status = 'off',
          filter_areas = null,
          filter_min_bedrooms = null,
          filter_max_bedrooms = null,
          filter_lift_effective_date = null,
          filter_enabled_at = null,
          leads_received_this_month = 0,
          billing_cycle_anchor = current_date,
          updated_at = now()
      where id = p_customer_id and filter_status = 'pending_lift';
    v_executed := found;
  end if;

  return v_executed;
end;
$$;
