-- ============================================================================
-- Pause subscription (3-month, management-only).
--
-- A management subscriber may pause their subscription once. While paused:
--   * Stripe collection is paused (invoices voided — see the app-side route), so
--     they are not billed.
--   * They receive no new management lead assignments (eligibility gate below).
--   * Their account_status STAYS 'active', so their capacity slot is RESERVED
--     for their return (capacity = count(account_status='active')). Pausing is
--     "still a customer, just paused", not "vacated".
--   * Their lead_balance is preserved — credits carry forward and are there when
--     they resume (same "credits never reset" principle as the renewal top-up).
--
-- A daily cron (/api/cron/resume-paused-subscriptions) clears the pause and
-- resumes Stripe collection once pause_resumes_at has passed.
--
-- SCHEMA-CONVENTION NOTE: additive only — three new nullable/defaulted columns
-- and in-place re-definitions of the existing routing functions to add one gate.
-- Nothing is dropped or renamed. Pause is MANAGEMENT-ONLY: the gate is added to
-- the management branch of each function only; guaranteed-rent routing is
-- untouched, so a paused management customer who also holds a GR subscription
-- keeps receiving GR leads.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 — customers: pause state.
--   paused_at        — when the pause began (null = not paused).
--   pause_resumes_at — paused_at + 3 months; the resume cron fires at/after this.
--   pause_count      — how many times the customer has used their pause. The
--                      app enforces a one-time allowance (pause_count >= 1 blocks
--                      re-pausing) to prevent indefinite pause/resume cycling to
--                      avoid ever being billed.
-- ---------------------------------------------------------------------------
alter table public.customers
  add column if not exists paused_at        timestamptz,
  add column if not exists pause_resumes_at timestamptz,
  add column if not exists pause_count      integer not null default 0;

-- ---------------------------------------------------------------------------
-- 2 — get_next_customers_for_lead (lead-type aware, 0015). Add `paused_at is
-- null` to the management branch. Definition otherwise verbatim from 0015.
-- ---------------------------------------------------------------------------
drop function if exists public.get_next_customers_for_lead(uuid, integer, uuid[], public.lead_type);
create or replace function public.get_next_customers_for_lead(
  p_lead_id uuid,
  p_max integer,
  p_exclude_customer_ids uuid[] default '{}'::uuid[],
  p_lead_type public.lead_type default 'management'
)
returns table (customer_id uuid)
language sql
security definer
set search_path = public
as $$
  select c.id
  from public.customers c
  where c.is_active = true
    and not (c.id = any (coalesce(p_exclude_customer_ids, '{}'::uuid[])))
    and not exists (
      select 1 from public.lead_assignments la
      where la.lead_id = p_lead_id
        and la.customer_id = c.id
    )
    and (
      (
        p_lead_type = 'management'
        and c.account_status = 'active'
        and c.subscription_status = 'active'
        and c.lead_balance > 0
        and c.paused_at is null
      )
      or (
        p_lead_type = 'guaranteed_rent'
        and c.gr_subscription_status = 'active'
        and c.gr_lead_balance > 0
      )
    )
  order by
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
    end desc,
    case
      when p_lead_type = 'guaranteed_rent' then c.gr_last_assignment_at
      else c.last_assignment_at
    end asc nulls first,
    c.created_at asc
  limit p_max;
$$;

-- ---------------------------------------------------------------------------
-- 3 — get_unfiltered_candidates_for_lead (0026). Add `paused_at is null` to the
-- management branch. Definition otherwise verbatim from 0026.
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
  order by
    deficit desc,
    case when p_lead_type = 'guaranteed_rent' then c.gr_last_assignment_at
         else c.last_assignment_at end asc nulls first,
    c.created_at asc
  limit p_max;
$$;

-- ---------------------------------------------------------------------------
-- 4 — get_filtered_candidates_for_lead (0026). Add `paused_at is null` to the
-- management branch. Definition otherwise verbatim from 0026.
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
  order by
    priority_score desc,
    case when p_lead_type = 'guaranteed_rent' then c.gr_last_assignment_at
         else c.last_assignment_at end asc nulls first,
    c.created_at asc
  limit p_max;
$$;
