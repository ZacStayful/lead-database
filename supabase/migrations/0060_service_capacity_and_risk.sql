-- ============================================================================
-- Live service capacity, and a churn-risk list.
--
-- Two questions, one migration, because they are two halves of the same
-- decision: how many customers can this lead supply actually serve, and which
-- of the ones I have are about to leave.
--
-- WHY CAPACITY IS DERIVED, NOT CONFIGURED
-- ---------------------------------------
-- system_settings.max_active_customers is a number somebody typed (currently
-- 14). It cannot know that lead volume moved last week, and it cannot know that
-- escalation now sells some leads to four operators instead of three. A typed
-- number goes stale silently and is trusted anyway, which is the worst
-- combination.
--
-- get_service_capacity() derives the figure from what actually happened:
-- leads ingested in the window, and the caps those leads carry. Because
-- escalation RAISES leads.max_assignments, the capacity number rises by itself
-- as escalations fire. Nobody has to remember to re-tune it.
--
-- The typed setting is deliberately left in place and untouched. It still gates
-- signup and the invite warning, and switching a live gate onto a derived
-- number is a behaviour change that belongs in its own decision — the panel
-- shows both, so the gap between them is visible rather than assumed away.
--
-- WHY RISK IS RULES, NOT A MODEL
-- ------------------------------
-- No customer has ever cancelled, so there is nothing to train on and any
-- "probability" would be invented. These are stated rules over observed
-- behaviour, and they say so. When cancellations do start, the snapshot series
-- (0058) plus cancelled_at gives the material to replace the rules with
-- something fitted — and the rules stay readable in the meantime, which a
-- fitted model would not be.
--
-- Re-engagement clears the flag by construction: every band is defined on DAYS
-- SINCE LAST ACTIVITY, so a customer who signs in or opens a lead drops to zero
-- days and out of the list on the next read. There is no state to reset and no
-- way for a stale flag to linger.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 — Live capacity, per product.
--
-- Window is 28 days — four whole weeks, so the figure is never skewed by which
-- weekday it is read on — then scaled to a 30-day month.
--
-- slots_per_month is the sum of max_assignments over leads ingested in the
-- window, NOT a count of leads times a constant. That distinction is what makes
-- it self-updating: pre-0055 leads carry 2, current ones 3, escalated ones 4 or
-- 5, and the sum reflects whatever the book actually holds.
-- ---------------------------------------------------------------------------
create or replace function public.get_service_capacity()
returns table (
  lead_type            public.lead_type,
  leads_per_month      numeric,
  slots_per_month      numeric,
  demand_per_month     integer,
  headroom_per_month   numeric,
  utilisation          numeric,
  active_customers     integer,
  open_slots_now       integer,
  unsold_leads_now     integer
)
language sql
stable
security definer
set search_path = public
as $$
  with w as (select 28 as days),
  supply as (
    select
      lt.lead_type,
      count(l.id)                                          as leads_in_window,
      coalesce(sum(l.max_assignments), 0)                  as slots_in_window
    from (select unnest(enum_range(null::public.lead_type)) as lead_type) lt
    left join public.leads l
      on l.lead_type = lt.lead_type
     and l.created_at >= now() - make_interval(days => (select days from w))
    group by lt.lead_type
  ),
  demand as (
    select
      'management'::public.lead_type as lead_type,
      -- is_active is the master switch, and it belongs in the demand figure as
      -- much as in routing. The admin demo account is switched off there but
      -- still carries an allocation, and counting it would have this panel
      -- report 20 leads a month of commitment that nobody is owed.
      coalesce(sum(c.monthly_allocation) filter (
        where c.is_active
          and c.account_status = 'active' and c.subscription_status = 'active'
      ), 0)::integer as demand,
      count(*) filter (
        where c.is_active
          and c.account_status = 'active' and c.subscription_status = 'active'
      )::integer as customers
    from public.customers c
    union all
    select
      'guaranteed_rent'::public.lead_type,
      coalesce(sum(c.gr_monthly_allocation) filter (
        where c.is_active and c.gr_subscription_status = 'active'
      ), 0)::integer,
      count(*) filter (where c.is_active and c.gr_subscription_status = 'active')::integer
    from public.customers c
  ),
  inventory as (
    select
      lt.lead_type,
      coalesce(sum(greatest(l.max_assignments - l.assignment_count, 0)), 0)::integer as open_slots,
      count(l.id) filter (where l.assignment_count = 0)::integer                     as unsold
    from (select unnest(enum_range(null::public.lead_type)) as lead_type) lt
    left join public.leads l on l.lead_type = lt.lead_type
    group by lt.lead_type
  )
  select
    s.lead_type,
    round(s.leads_in_window * 30.0 / (select days from w), 1),
    round(s.slots_in_window * 30.0 / (select days from w), 1),
    d.demand,
    round(s.slots_in_window * 30.0 / (select days from w) - d.demand, 1),
    case when s.slots_in_window > 0
         then round(d.demand / (s.slots_in_window * 30.0 / (select days from w)), 3)
    end,
    d.customers,
    i.open_slots,
    i.unsold
  from supply s
  join demand d    on d.lead_type = s.lead_type
  join inventory i on i.lead_type = s.lead_type;
$$;

revoke execute on function public.get_service_capacity() from public, anon, authenticated;
grant execute on function public.get_service_capacity() to service_role;

-- ---------------------------------------------------------------------------
-- 2 — Churn risk, per customer.
--
-- Bands, in the order they are tested:
--
--   critical  never engaged at all, and past the point where onboarding
--             explains it. These are the customers paying for something they
--             have not once used.
--   high      silent 21+ days, or silent 14+ days having worked under a
--             quarter of what they were sent.
--   medium    silent 14+ days, or silent 10+ with a weak working record.
--   watch     silent 7+ days.
--   ok        active within the last week.
--
-- The two inputs are deliberately different in kind. Days-since-activity is the
-- fast signal — it moves within a week. Lifetime worked rate is the slow one,
-- and it separates a good customer having a quiet fortnight from somebody who
-- never got started. Treating those two the same is the mistake this is built
-- to avoid: they need different conversations, and only one of them is
-- recoverable by a reminder email.
--
-- Revenue is NOT computed here. monthly_allocation is returned and priced in
-- lib/plans.ts, which already owns every price in the system; duplicating the
-- 10 -> £150 / 20 -> £300 mapping in SQL is exactly how the GR lead price went
-- stale (see plans.ts).
-- ---------------------------------------------------------------------------
create or replace function public.get_customer_risk()
returns table (
  customer_id              uuid,
  business_name            text,
  email                    text,
  monthly_allocation       integer,
  gr_monthly_allocation    integer,
  holds_management         boolean,
  holds_gr                 boolean,
  days_since_last_activity integer,
  tenure_days              integer,
  paying_days              integer,
  lifetime_delivered       integer,
  lifetime_worked          integer,
  lifetime_worked_rate     numeric,
  risk_band                text,
  risk_reason              text
)
language sql
stable
security definer
set search_path = public
as $$
  with base as (
    select
      c.id, c.business_name, c.email,
      c.monthly_allocation, c.gr_monthly_allocation,
      (c.account_status = 'active' and c.subscription_status = 'active') as holds_mgmt,
      (c.gr_subscription_status = 'active')                              as holds_gr,
      (current_date - c.created_at::date)::integer                       as tenure_days,
      (current_date - coalesce(c.billing_cycle_anchor, c.gr_billing_cycle_anchor))::integer
                                                                         as paying_days,
      (current_date - greatest(
        (select max(e.created_at)::date from public.lead_events e
           join public.lead_assignments la on la.id = e.assignment_id
          where la.customer_id = c.id
            and e.event_type in ('detail_opened', 'tel_click', 'mailto_click')),
        (select max(n.created_at)::date from public.lead_notes n where n.customer_id = c.id),
        (select max(nt.read_at)::date from public.notifications nt where nt.customer_id = c.id),
        (select u.last_sign_in_at::date from auth.users u where u.id = c.user_id)
      ))::integer                                                        as quiet_days,
      (select count(*) from public.lead_assignments la where la.customer_id = c.id)::integer
                                                                         as delivered,
      (select count(*) from public.lead_assignments la
         where la.customer_id = c.id
           and (exists (select 1 from public.lead_events e
                         where e.assignment_id = la.id
                           and e.event_type in ('detail_opened','tel_click','mailto_click'))
             or exists (select 1 from public.lead_notes n where n.lead_assignment_id = la.id)
             or exists (select 1 from public.lead_files f where f.lead_assignment_id = la.id))
      )::integer                                                         as worked
    from public.customers c
    where c.is_active = true
      and (
        (c.account_status = 'active' and c.subscription_status = 'active')
        or c.gr_subscription_status = 'active'
      )
  ),
  rated as (
    select b.*,
      case when b.delivered > 0
           then round(b.worked::numeric / b.delivered, 3) end as worked_rate
    from base b
  )
  select
    r.id, r.business_name, r.email,
    r.monthly_allocation, r.gr_monthly_allocation,
    r.holds_mgmt, r.holds_gr,
    r.quiet_days, r.tenure_days, r.paying_days,
    r.delivered, r.worked, r.worked_rate,
    case
      when r.delivered >= 5 and r.worked = 0 and r.tenure_days >= 10 then 'critical'
      when r.quiet_days is null then 'critical'
      when r.quiet_days >= 21 then 'high'
      when r.quiet_days >= 14 and coalesce(r.worked_rate, 0) < 0.25 then 'high'
      when r.quiet_days >= 14 then 'medium'
      when r.quiet_days >= 10 and coalesce(r.worked_rate, 0) < 0.25 then 'medium'
      when r.quiet_days >= 7 then 'watch'
      else 'ok'
    end,
    case
      when r.delivered >= 5 and r.worked = 0 and r.tenure_days >= 10
        then 'Has never worked a single lead of ' || r.delivered || ' delivered'
      when r.quiet_days is null then 'No recorded activity ever'
      when r.quiet_days >= 21 then 'No activity for ' || r.quiet_days || ' days'
      when r.quiet_days >= 14 and coalesce(r.worked_rate, 0) < 0.25
        then 'Quiet ' || r.quiet_days || ' days, and has worked only '
             || round(coalesce(r.worked_rate, 0) * 100) || '% of leads sent'
      when r.quiet_days >= 14 then 'No activity for ' || r.quiet_days || ' days'
      when r.quiet_days >= 10 and coalesce(r.worked_rate, 0) < 0.25
        then 'Quiet ' || r.quiet_days || ' days, working '
             || round(coalesce(r.worked_rate, 0) * 100) || '% of leads sent'
      when r.quiet_days >= 7 then 'Quiet for ' || r.quiet_days || ' days'
      else 'Active in the last week'
    end
  from rated r;
$$;

revoke execute on function public.get_customer_risk() from public, anon, authenticated;
grant execute on function public.get_customer_risk() to service_role;
