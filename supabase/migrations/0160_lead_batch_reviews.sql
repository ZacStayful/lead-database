-- 0160 — Monthly lead-batch review and the shortfall email (§73)
--
-- At the end of each customer's billing cycle, record what that cycle
-- delivered: the allocation, the leads that actually arrived, and what is owed.
-- The cron /api/cron/batch-reviews then sends two things from that record:
-- a shortfall email on reset day to anyone delivered less than their allocation,
-- and seven days later a survey asking about every lead in the batch.
--
-- ⚠️ THE CAPTURE LIVES INSIDE reset_monthly_counts, AND IT HAS TO.
-- That function zeroes leads_received_this_month at 00:05 UTC on the anchor
-- day, and nothing else stores last cycle's figure. A cron running after 00:05
-- would read a balance the new cycle has already moved: monday-lead-sync runs
-- every five minutes overnight (§63), and the release cron runs at 07:30. Like
-- every snapshot here (§18.2), a missed capture cannot be rebuilt afterwards.
--
-- ⚠️ A FAILED CAPTURE MUST NEVER STOP THE COUNTER RESET. The call sits in its
-- own sub-block with an exception handler that raises a warning. Losing a
-- review costs one email; losing the reset leaves every customer on that anchor
-- day paced against last month's count.
--
-- ⚠️ CAPTURE IS NOT GATED ON batch_reviews_enabled. That switch controls
-- SENDING only. Capturing costs nothing and cannot be redone later, so it runs
-- from the day this migration is applied, and turning the switch on finds a
-- history waiting rather than an empty table.
--
-- Additive, and inert for routing: no balance, counter, pacing or capacity
-- column is touched, and the three statements reset_monthly_counts already ran
-- are carried over from 0153 verbatim.
--
-- Accepted edge case: if a renewal's invoice.paid lands before 00:05 UTC on the
-- anchor date, balance_at_reset already includes the new grant. Renewals are
-- finalised about an hour after the period starts (§11), so this needs a period
-- starting between 00:00 and 00:05.

-- ---------------------------------------------------------------------------
-- 1 — the snapshot
-- ---------------------------------------------------------------------------
create table if not exists public.lead_batch_reviews (
  id                      uuid primary key default gen_random_uuid(),
  customer_id             uuid not null references public.customers(id) on delete cascade,
  lead_type               public.lead_type not null,
  cycle_start             date not null,
  -- The reset date. The window is [cycle_start, cycle_end): leads assigned on
  -- this date belong to the NEXT cycle.
  cycle_end               date not null,
  -- The plan allocation for the cycle, before pool debit; pool_debit is kept
  -- beside it. They are reported separately, never netted together (§19.5).
  allocation              integer not null check (allocation >= 0),
  -- Assignments in the window, i.e. the leads the customer can see: the item
  -- row count. Customer-facing figures use this.
  delivered               integer not null default 0 check (delivered >= 0),
  -- leads_received_this_month at the moment of the reset. AUDIT ONLY: reject
  -- (0006) and an upheld dead-lead claim (0137) both decrement the counter, so
  -- it is not a delivery count.
  counter_at_reset        integer not null,
  -- Unspent credit carried into the next cycle — "owed".
  balance_at_reset        integer not null,
  next_allocation         integer not null check (next_allocation >= 0),
  pool_debit              integer not null default 0,
  -- The filter as it stood, so the email can say why the cycle came up short
  -- (§69) without reading a filter the customer has since changed.
  filter_status           text,
  filter_expected_leads   integer,
  filter_areas            text[],
  filter_min_bedrooms     integer,
  filter_max_bedrooms     integer,
  filter_min_gross        integer,
  release_hold_until      date,
  captured_at             timestamptz not null default now(),
  -- Only the sha256 of the survey link token is stored, never the token (the
  -- lead_topup_tokens rule).
  token_hash              text unique,
  token_expires_at        timestamptz,
  -- Each *_sent_at is claimed by a guarded update BEFORE the email is sent —
  -- the credit_invoice discipline — so a double run sends nothing twice.
  shortfall_email_sent_at timestamptz,
  survey_sent_at          timestamptz,
  reminder_sent_at        timestamptz,
  submitted_at            timestamptz,
  quality_rating          smallint check (quality_rating between 1 and 5),
  comment                 text check (comment is null or char_length(comment) <= 2000),
  updated_at              timestamptz not null default now(),
  constraint lead_batch_reviews_window check (cycle_start <= cycle_end),
  -- The idempotency guard. reset_monthly_counts can run more than once on the
  -- same day (0141's suite runs it three times), and the insert is on conflict
  -- do nothing.
  constraint lead_batch_reviews_one_per_cycle unique (customer_id, lead_type, cycle_end)
);

create index if not exists lead_batch_reviews_customer_idx
  on public.lead_batch_reviews (customer_id, cycle_end desc);
-- What the cron scans: sent, still open, and not yet expired.
create index if not exists lead_batch_reviews_open_idx
  on public.lead_batch_reviews (cycle_end)
  where submitted_at is null;

alter table public.lead_batch_reviews enable row level security;

-- ---------------------------------------------------------------------------
-- 2 — one row per lead in the batch
-- ---------------------------------------------------------------------------
create table if not exists public.lead_batch_review_items (
  id                  uuid primary key default gen_random_uuid(),
  review_id           uuid not null references public.lead_batch_reviews(id) on delete cascade,
  -- ⚠️ ON DELETE SET NULL. A discard (§5), a swap (§34) and a Stayful-pipeline
  -- withdrawal (§64) all DELETE the assignment. A cascade here would erase the
  -- batch record in the act of acting on it — the 0139 hazard.
  assignment_id       uuid references public.lead_assignments(id) on delete set null,
  lead_id             uuid references public.leads(id) on delete set null,
  -- Denormalised so reporting survives a deleted lead (the 0138 move).
  postcode_area       text,
  bedrooms            text,
  gross_annual_income numeric,
  assigned_at         timestamptz not null,
  stage_at_capture    text,
  status_at_capture   text,
  -- The customer's answer. Called / not called is DERIVED (anything except
  -- not_called), so it is never asked twice. The vocabulary is the union of
  -- both products; src/lib/batchReview/answers.ts says which apply where, and
  -- a test asserts this list matches it exactly.
  answer              text check (answer in (
                        'not_called', 'no_answer', 'not_interested', 'talking',
                        'meeting_booked', 'meeting_held', 'viewing_booked',
                        'contract_sent', 'likely_later', 'signed')),
  dead_reason         text check (dead_reason in (
                        'couldnt_reach', 'with_other_company', 'not_letting',
                        'wrong_details', 'numbers_dont_work', 'other')),
  answered_at         timestamptz,
  constraint lead_batch_review_items_once unique (review_id, assignment_id)
);

create index if not exists lead_batch_review_items_review_idx
  on public.lead_batch_review_items (review_id);
create index if not exists lead_batch_review_items_assignment_idx
  on public.lead_batch_review_items (assignment_id);
create index if not exists lead_batch_review_items_lead_idx
  on public.lead_batch_review_items (lead_id);

alter table public.lead_batch_review_items enable row level security;

-- ---------------------------------------------------------------------------
-- 3 — switches. Sending ships OFF; capture is never gated.
-- ---------------------------------------------------------------------------
insert into public.system_settings (key, value)
values
  ('batch_reviews_enabled', 'false'),
  ('batch_review_delay_days', '7'),
  ('batch_review_reminder_days', '3'),
  ('batch_review_token_days', '30')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 4 — the opt-out key for the survey, in all four places (§21.7). This is the
-- migration half: the column default and a merge-backfill. `||` is a merge, so
-- an explicit false on any other stream survives.
-- ---------------------------------------------------------------------------
alter table public.customers
  alter column notification_preferences set default
    '{"new_lead": true, "credit_warnings": true, "inactivity_nudge": true,
      "progress_report": true, "monthly_insights": true, "announcements": true,
      "contact_followups": true, "monthly_review": true}'::jsonb;

update public.customers
   set notification_preferences =
       notification_preferences || '{"monthly_review": true}'::jsonb
 where not (notification_preferences ? 'monthly_review');

-- ---------------------------------------------------------------------------
-- 5 — the previous anchor occurrence before p_on
--
-- An anchor on the 31st lands on the last day of a short month, the same clamp
-- reset_monthly_counts and replacement_cycle_start (0153) use.
-- ---------------------------------------------------------------------------
create or replace function public.batch_cycle_start(p_dom integer, p_on date)
returns date
language sql
immutable
set search_path = public
as $$
  select (date_trunc('month', p_on) - interval '1 month')::date
         + (least(p_dom,
                  extract(day from (date_trunc('month', p_on) - interval '1 day'))::integer)
            - 1);
$$;

revoke execute on function public.batch_cycle_start(integer, date) from public, anon, authenticated;
grant execute on function public.batch_cycle_start(integer, date) to service_role;

-- ---------------------------------------------------------------------------
-- 6 — the capture
--
-- A separate function, so the test suite can drive it directly and so the
-- reset can wrap the whole thing in one exception block.
--
-- Who is captured, per product, mirroring holdsProduct():
--   management: is_active, (account_status = 'active' or subscription_status in
--               ('active','past_due')), not paused, not written off (§59)
--   GR:         is_active, gr_subscription_status in ('active','past_due'),
--               not written off. It must never read account_status or paused_at
--               (invariant 6).
-- Day matching uses the SAME expression as the matching counter reset below,
-- so a customer is captured exactly when their counter is zeroed.
--
-- The window starts at whichever is later: the previous anchor occurrence, or
-- the end of the last review captured for this product. The second stops
-- overlapping windows when the anchor moves (a resume from pause re-anchors to
-- the resume date, §21).
--
-- Items are the customer's assignments for this product within the window,
-- EXCLUDING leads they uploaded themselves (§30). Pool claims and swap
-- replacements stay in: both are leads the customer holds.
-- ---------------------------------------------------------------------------
create or replace function public.capture_lead_batch_reviews(p_on date default current_date)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dom      int := extract(day from p_on);
  v_last_dom int := extract(day from (date_trunc('month', p_on) + interval '1 month - 1 day'));
  v_inserted int := 0;
  v_n        int;
begin
  -- Management
  with candidates as (
    select c.*,
           extract(day from coalesce(c.billing_cycle_anchor, c.created_at::date))::int as dom
      from public.customers c
     where c.is_active
       and (c.account_status = 'active'
            or c.subscription_status in ('active', 'past_due'))
       and c.paused_at is null
       and c.lapsed_at is null
       and (extract(day from coalesce(c.billing_cycle_anchor, c.created_at::date)) = v_dom
            or (v_dom = v_last_dom
                and extract(day from coalesce(c.billing_cycle_anchor, c.created_at::date)) > v_last_dom))
  ),
  ins as (
    insert into public.lead_batch_reviews (
      customer_id, lead_type, cycle_start, cycle_end,
      allocation, counter_at_reset, balance_at_reset, next_allocation, pool_debit,
      filter_status, filter_expected_leads, filter_areas,
      filter_min_bedrooms, filter_max_bedrooms, filter_min_gross, release_hold_until)
    select
      c.id, 'management',
      least(p_on, greatest(
        public.batch_cycle_start(c.dom, p_on),
        coalesce((select max(r.cycle_end) from public.lead_batch_reviews r
                   where r.customer_id = c.id and r.lead_type = 'management'
                     and r.cycle_end < p_on),
                 '-infinity'::date))),
      p_on,
      greatest(coalesce(c.monthly_allocation, 0), 0),
      coalesce(c.leads_received_this_month, 0),
      coalesce(c.lead_balance, 0),
      greatest(coalesce(c.pending_monthly_allocation, c.monthly_allocation, 0), 0),
      coalesce(c.pool_debit, 0),
      c.filter_status, c.filter_expected_leads, c.filter_areas,
      c.filter_min_bedrooms, c.filter_max_bedrooms, c.filter_min_gross,
      c.release_hold_until
    from candidates c
    on conflict (customer_id, lead_type, cycle_end) do nothing
    returning id, customer_id, cycle_start, cycle_end
  )
  insert into public.lead_batch_review_items (
    review_id, assignment_id, lead_id, postcode_area, bedrooms,
    gross_annual_income, assigned_at, stage_at_capture, status_at_capture)
  select ins.id, la.id, l.id, l.postcode_area, l.bedrooms,
         l.gross_annual_income, la.assigned_at, la.pipeline_stage, la.status
    from ins
    join public.lead_assignments la on la.customer_id = ins.customer_id
    join public.leads l on l.id = la.lead_id
   where l.lead_type = 'management'
     and la.assigned_at >= ins.cycle_start::timestamptz
     and la.assigned_at <  ins.cycle_end::timestamptz
     and l.owner_customer_id is distinct from ins.customer_id;

  -- Guaranteed Rent (gr_ columns only — invariant 6)
  with candidates as (
    select c.*,
           extract(day from coalesce(c.gr_billing_cycle_anchor, c.created_at::date))::int as dom
      from public.customers c
     where c.is_active
       and c.gr_subscription_status in ('active', 'past_due')
       and c.gr_lapsed_at is null
       and (extract(day from coalesce(c.gr_billing_cycle_anchor, c.created_at::date)) = v_dom
            or (v_dom = v_last_dom
                and extract(day from coalesce(c.gr_billing_cycle_anchor, c.created_at::date)) > v_last_dom))
  ),
  ins as (
    insert into public.lead_batch_reviews (
      customer_id, lead_type, cycle_start, cycle_end,
      allocation, counter_at_reset, balance_at_reset, next_allocation, pool_debit,
      filter_status, filter_expected_leads, filter_areas,
      filter_min_bedrooms, filter_max_bedrooms, filter_min_gross, release_hold_until)
    select
      c.id, 'guaranteed_rent',
      least(p_on, greatest(
        public.batch_cycle_start(c.dom, p_on),
        coalesce((select max(r.cycle_end) from public.lead_batch_reviews r
                   where r.customer_id = c.id and r.lead_type = 'guaranteed_rent'
                     and r.cycle_end < p_on),
                 '-infinity'::date))),
      p_on,
      greatest(coalesce(c.gr_monthly_allocation, 0), 0),
      coalesce(c.gr_leads_received_this_month, 0),
      coalesce(c.gr_lead_balance, 0),
      greatest(coalesce(c.gr_pending_monthly_allocation, c.gr_monthly_allocation, 0), 0),
      coalesce(c.gr_pool_debit, 0),
      c.gr_filter_status, c.gr_filter_expected_leads, c.gr_filter_areas,
      c.gr_filter_min_bedrooms, c.gr_filter_max_bedrooms, null,
      c.gr_release_hold_until
    from candidates c
    on conflict (customer_id, lead_type, cycle_end) do nothing
    returning id, customer_id, cycle_start, cycle_end
  )
  insert into public.lead_batch_review_items (
    review_id, assignment_id, lead_id, postcode_area, bedrooms,
    gross_annual_income, assigned_at, stage_at_capture, status_at_capture)
  select ins.id, la.id, l.id, l.postcode_area, l.bedrooms,
         l.gross_annual_income, la.assigned_at, la.pipeline_stage, la.status
    from ins
    join public.lead_assignments la on la.customer_id = ins.customer_id
    join public.leads l on l.id = la.lead_id
   where l.lead_type = 'guaranteed_rent'
     and la.assigned_at >= ins.cycle_start::timestamptz
     and la.assigned_at <  ins.cycle_end::timestamptz
     and l.owner_customer_id is distinct from ins.customer_id;

  -- delivered = the item count, for today's captures only. Items are never
  -- deleted (their pointers go null instead), so a re-run finds the same count.
  update public.lead_batch_reviews r
     set delivered  = sub.n,
         updated_at = now()
    from (select r2.id, count(i.id)::int as n
            from public.lead_batch_reviews r2
            left join public.lead_batch_review_items i on i.review_id = r2.id
           where r2.cycle_end = p_on
           group by r2.id) sub
   where r.id = sub.id
     and r.delivered is distinct from sub.n;

  select count(*) into v_n from public.lead_batch_reviews where cycle_end = p_on;
  v_inserted := v_n;
  return v_inserted;
end;
$$;

revoke execute on function public.capture_lead_batch_reviews(date) from public, anon, authenticated;
grant execute on function public.capture_lead_batch_reviews(date) to service_role;

-- ---------------------------------------------------------------------------
-- 7 — reset_monthly_counts: 0153's body, with the capture first
-- ---------------------------------------------------------------------------
create or replace function public.reset_monthly_counts()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today     date := current_date;
  v_dom       int  := extract(day from v_today);
  v_last_dom  int  := extract(day from (date_trunc('month', v_today) + interval '1 month - 1 day'));
begin
  -- 0160 (§73): the batch snapshot, BEFORE anything is zeroed. It has its own
  -- sub-block, so a failure here is a warning and the reset still runs.
  begin
    perform public.capture_lead_batch_reviews(v_today);
  exception when others then
    raise warning 'capture_lead_batch_reviews failed: % (%)', sqlerrm, sqlstate;
  end;

  -- Management counter — unchanged from 0014.
  update public.customers
    set leads_received_this_month = 0,
        updated_at = now()
    where
      extract(day from coalesce(billing_cycle_anchor, created_at::date)) = v_dom
      or (v_dom = v_last_dom
          and extract(day from coalesce(billing_cycle_anchor, created_at::date)) > v_last_dom);

  -- GR counter — same anchor-day logic on the GR billing anchor.
  update public.customers
    set gr_leads_received_this_month = 0
    where
      extract(day from coalesce(gr_billing_cycle_anchor, created_at::date)) = v_dom
      or (v_dom = v_last_dom
          and extract(day from coalesce(gr_billing_cycle_anchor, created_at::date)) > v_last_dom);

  -- The one cross-product counter, on the one anchor. The coalesce order is the
  -- rule: management first where they hold it, GR where they do not, and the
  -- signup date only when neither has ever been billed.
  update public.customers
    set quality_claims_this_cycle = 0,
        updated_at = now()
    where
      extract(day from coalesce(billing_cycle_anchor, gr_billing_cycle_anchor, created_at::date)) = v_dom
      or (v_dom = v_last_dom
          and extract(day from coalesce(billing_cycle_anchor, gr_billing_cycle_anchor, created_at::date)) > v_last_dom);

  -- 0153 (§61): the monthly replacement grant lands in the balance. See 0153
  -- for why this is a fourth statement and why it is status-gated.
  update public.customers c
    set replacement_balance    = c.replacement_balance + public.replacement_monthly_grant(c),
        replacement_granted_on = public.replacement_cycle_start(c),
        updated_at             = now()
    where c.is_active
      and public.replacement_monthly_grant(c) > 0
      and (c.replacement_granted_on is null
           or c.replacement_granted_on < public.replacement_cycle_start(c));
end;
$$;

revoke execute on function public.reset_monthly_counts() from public, anon, authenticated;
grant execute on function public.reset_monthly_counts() to service_role;
