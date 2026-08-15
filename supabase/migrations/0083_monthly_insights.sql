-- ============================================================================
-- Monthly insights: the per-customer half of the leaderboard, for sending.
--
-- The Leaderboard page (§20) answers "what do the operators who sign clients do
-- differently" for whoever is looking at it. This is the same question asked on
-- the customer's behalf, once a month, by email and a short SMS pointer.
--
-- WHY THE FIGURES ARE LIFETIME, NOT LAST-30-DAYS
-- ----------------------------------------------
-- The obvious reading of "monthly" is a 30-day window. It is the wrong choice
-- here: the cohort figures come from operator_proof_snapshots, which measure
-- every management lead ever delivered, and comparing somebody's last 30 days
-- against the cohort's whole history would be two different questions printed
-- side by side as if they were one.
--
-- So "monthly" is the CADENCE, not the window, and the email shows exactly what
-- the customer would see on the Leaderboard page if they opened it. Two
-- customer-facing surfaces disagreeing about the same number is a fault this
-- codebase has already had once (the Goals/Analytics Won figure), and it costs
-- more trust than a rolling window would buy.
--
-- The definitions of opened / attempted / met are copied from
-- get_operator_proof deliberately, for the same reason. All three must change
-- together.
--
-- MANAGEMENT ONLY, matching the page. A GR-only subscriber has no management
-- leads, would score zero on every row, and would be reading about a product
-- they do not hold.
-- ============================================================================

-- When the monthly insights email was last sent, for monthly dedup. Mirrors
-- last_report_sent_at (weekly) and last_nudge_sent_at (daily). Null = never.
alter table public.customers
  add column if not exists last_insights_sent_at timestamptz;

-- ---------------------------------------------------------------------------
-- One row per management subscriber who has actually been sent leads.
--
-- Customers with nothing delivered are excluded at source rather than filtered
-- in the route: there is no honest version of this message for somebody who has
-- never received a lead, and an email reporting 0 out of 0 against a cohort's
-- 100% would be an accusation about nothing.
-- ---------------------------------------------------------------------------
create or replace function public.get_customer_monthly_insights()
returns table (
  customer_id           uuid,
  email                 text,
  contact_name          text,
  phone                 text,
  sms_alerts_enabled    boolean,
  notification_preferences jsonb,
  last_insights_sent_at timestamptz,
  delivered             integer,
  opened                integer,
  attempted             integer,
  meetings              integer,
  wins                  integer,
  notes                 integer,
  open_rate             numeric,
  contact_rate          numeric,
  meeting_rate          numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with per_assignment as (
    select
      la.customer_id as cid,
      la.status,
      (la.viewed_at is not null
       or exists (
         select 1 from public.lead_events e
         where e.assignment_id = la.id and e.event_type = 'detail_opened'
       )) as opened,
      (la.first_contacted_at is not null) as attempted,
      (la.pipeline_stage in (
        'web_meeting_booked', 'web_meeting_no_show', 'web_meeting_attended'
      )) as met
    from public.lead_assignments la
    join public.leads l on l.id = la.lead_id
    where l.lead_type = 'management'
  ),
  per_customer as (
    select
      p.cid,
      count(*)::integer                                  as delivered,
      count(*) filter (where p.opened)::integer          as opened,
      count(*) filter (where p.attempted)::integer       as attempted,
      count(*) filter (where p.met)::integer             as meetings,
      count(*) filter (where p.status = 'won')::integer  as wins
    from per_assignment p
    group by p.cid
  )
  select
    c.id,
    c.email,
    c.contact_name,
    c.phone,
    c.sms_alerts_enabled,
    c.notification_preferences,
    c.last_insights_sent_at,
    pc.delivered,
    pc.opened,
    pc.attempted,
    pc.meetings,
    pc.wins,
    (select count(*)::integer from public.lead_notes n where n.customer_id = c.id),
    round(pc.opened::numeric    / nullif(pc.delivered, 0), 4),
    round(pc.attempted::numeric / nullif(pc.delivered, 0), 4),
    round(pc.meetings::numeric  / nullif(pc.delivered, 0), 4)
  from public.customers c
  join per_customer pc on pc.cid = c.id
  where c.is_active = true
    -- Management subscribers only, the same gate the Goals page uses (§13):
    -- subscription_status is the management subscription, and account_status
    -- excludes cancelled and waitlisted rows.
    and c.account_status = 'active'
    and c.subscription_status = 'active'
    and pc.delivered > 0;
$$;

revoke execute on function public.get_customer_monthly_insights()
  from public, anon, authenticated;
grant execute on function public.get_customer_monthly_insights() to service_role;
