-- ============================================================================
-- 0167 — Batch 04 Phase 1: data for brief customers' pauses and area changes
--
-- docs/build/04-area-changes-pause-topups.md (Phase 1) and the approved Phase 0
-- report, docs/build/04-phase0-report.md (decisions C1–C4, the phase plan).
-- Lead Brief customers only; nothing here changes what an existing customer
-- gets.
--
-- What it adds:
--
--   1. customers.pause_holds_area — LIVE state, the §21 split: whether the
--      current pause keeps the brief customer's area (28 days or fewer, locked
--      decision 2) or releases it (longer, locked decision 3). Null for every
--      pause that is not a brief customer's, and for everyone not paused.
--   2. subscription_pauses — the episode record (history):
--        hold_area         the same fact, kept with the episode;
--        recalibrated_at   when the area was recalculated, 7 days before a
--                          long pause ends (Phase 2);
--        pending_brief_id  the pending_confirmation version that wrote;
--      and months may be null, for a brief customer's date-based pause (C6:
--      "Pause for 4 weeks" and "Choose a longer pause" ask for a return date,
--      and a calendar month can run past 28 days).
--   3. customer_lead_briefs:
--        effective_at      when a pending_confirmation version is meant to take
--                          effect: the return date after a long pause, or the
--                          renewal a monthly widening applies from (A10);
--        auto_accepted_at  set when the 72-hour auto-accept confirmed it
--                          (Phase 3) rather than the customer.
--      confirmed_at already exists (0162).
--   4. replacement_monthly_grant — C2: a PAUSED BRIEF customer banks no
--      replacements on the management side (batch 04 locked decision 1, "owed
--      nothing for the paused period", over §61's "a pause still accrues", for
--      brief customers only). Existing customers keep §61's rule.
--
-- ⚠️ pause_holds_area MEANS SOMETHING ONLY WHILE paused_at IS SET. There is no
-- CHECK tying the two: the Stripe webhook's resume detection clears paused_at
-- (§21's third case), and a CHECK it did not know about would make that update
-- fail, delete the stripe_events claim and have Stripe redeliver (§23.6).
-- Every reader tests `paused_at is not null` first; Phase 2 nulls the column at
-- each place a pause clears.
--
-- ⚠️ "28 DAYS OR FEWER" IS COUNTED IN LONDON DATES, not in hours. A return on
-- the 28th day is a short pause whatever time the pause was taken at; counted
-- in hours, a pause taken at 07:00 with a return on day 28 at 08:00 would be
-- 28 days and an hour, and long. The CHECK below is that rule, so the stored
-- flag can never disagree with the stored dates (0162's travel_mode CHECK is
-- the same idea).
--
-- ⚠️ replacement_monthly_grant KEEPS ITS SIGNATURE, so this is a plain create
-- or replace; reset_monthly_counts (0160) calls it unchanged. Grants
-- re-asserted, service_role only (0153).
--
-- What this does NOT do:
--   - change any balance, counter, pacing or capacity column, or any existing
--     pause, brief or customer row. 0 brief customers are paused, 0 brief rows
--     exist, and every existing episode has months set;
--   - touch the pause route, the resume paths or the webhook (Phase 2);
--   - touch routing. Brief routing already refuses a paused customer
--     (0163, `and c.paused_at is null`).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Live state on customers
-- ---------------------------------------------------------------------------
alter table public.customers
  add column if not exists pause_holds_area boolean;

comment on column public.customers.pause_holds_area is
  'Batch 04 (0167). For a Lead Brief customer''s CURRENT pause: true when it is 28 days or fewer (the area is kept, and the customer still counts as committed demand), false when longer (capacity is released at once and the area is recalculated 7 days before return). Null for any pause that is not a brief customer''s, and meaningful only while paused_at is set: read it as `paused_at is not null and pause_holds_area is false` for a long brief pause.';

-- ---------------------------------------------------------------------------
-- 2. The episode record
-- ---------------------------------------------------------------------------
alter table public.subscription_pauses
  add column if not exists hold_area boolean;

alter table public.subscription_pauses
  add column if not exists recalibrated_at timestamptz;

alter table public.subscription_pauses
  add column if not exists pending_brief_id uuid
    references public.customer_lead_briefs(id) on delete set null;

-- C6: a brief customer's pause is date-based. The existing CHECK
-- (months in (1, 2, 3)) still holds for every month count that is stored: a
-- CHECK passes on null.
alter table public.subscription_pauses
  alter column months drop not null;

-- A pause with no month count must be a brief customer's. Every other pause
-- (the existing 1/2/3-month choice) still records its months.
alter table public.subscription_pauses
  drop constraint if exists subscription_pauses_months_or_brief;
alter table public.subscription_pauses
  add constraint subscription_pauses_months_or_brief
  check (months is not null or hold_area is not null);

-- Locked decision 2: the area is held for a pause of 28 days or fewer, counted
-- in London dates (see the header).
alter table public.subscription_pauses
  drop constraint if exists subscription_pauses_hold_area_length;
alter table public.subscription_pauses
  add constraint subscription_pauses_hold_area_length check (
    hold_area is null
    or hold_area = (
      (resumes_at at time zone 'Europe/London')::date
        - (paused_at at time zone 'Europe/London')::date <= 28
    )
  );

-- Locked decision 3: a longer pause goes "up to the existing maximum, 3
-- months". The 1/2/3 CHECK bounds a month-based pause; this bounds a
-- date-based one, on London dates, with Postgres's month-end clamp
-- (30 Nov + 3 months = 28 Feb).
alter table public.subscription_pauses
  drop constraint if exists subscription_pauses_brief_max;
alter table public.subscription_pauses
  add constraint subscription_pauses_brief_max check (
    hold_area is null
    or (resumes_at at time zone 'Europe/London')::date
       <= ((paused_at at time zone 'Europe/London')::date + interval '3 months')::date
  );

-- Only a long pause is recalculated, and a pending version is only ever
-- written by that recalculation. `is false`, not `= false`: hold_area = false
-- is NULL when hold_area is null, and a CHECK passes on NULL.
alter table public.subscription_pauses
  drop constraint if exists subscription_pauses_recalibrated_long_only;
alter table public.subscription_pauses
  add constraint subscription_pauses_recalibrated_long_only
  check (recalibrated_at is null or hold_area is false);

alter table public.subscription_pauses
  drop constraint if exists subscription_pauses_pending_brief_recalibrated;
alter table public.subscription_pauses
  add constraint subscription_pauses_pending_brief_recalibrated
  check (pending_brief_id is null or recalibrated_at is not null);

comment on column public.subscription_pauses.months is
  'The 1, 2 or 3 months chosen on the existing pause card. Null only for a Lead Brief customer''s date-based pause (0167, batch 04 C6), which carries hold_area instead.';

comment on column public.subscription_pauses.hold_area is
  'Batch 04 (0167). Set for a Lead Brief customer''s pause only: true when it is 28 days or fewer by London dates (the area is kept), false when longer. Null for every other pause. Mirrors customers.pause_holds_area at the moment of pausing.';

comment on column public.subscription_pauses.recalibrated_at is
  'Batch 04 (0167). When the brief area was recalculated for this long pause, 7 days before it ends. Null until then, and always null for a short pause.';

comment on column public.subscription_pauses.pending_brief_id is
  'Batch 04 (0167). The pending_confirmation brief version the recalculation wrote. Set null if that version is ever deleted.';

-- ---------------------------------------------------------------------------
-- 3. Brief versions: when a pending one takes effect, and how it was accepted
-- ---------------------------------------------------------------------------
alter table public.customer_lead_briefs
  add column if not exists effective_at timestamptz;

alter table public.customer_lead_briefs
  add column if not exists auto_accepted_at timestamptz;

-- A pending version must say when it takes effect: the 72-hour auto-accept is
-- measured from it (locked decision 4). Nothing writes one today (0 rows), and
-- Lead Brief Phase 6's monthly recalculation must set it when it does.
alter table public.customer_lead_briefs
  drop constraint if exists customer_lead_briefs_pending_effective;
alter table public.customer_lead_briefs
  add constraint customer_lead_briefs_pending_effective
  check (status <> 'pending_confirmation' or effective_at is not null);

-- An auto-accept is a confirmation of a pending version.
alter table public.customer_lead_briefs
  drop constraint if exists customer_lead_briefs_auto_accept_confirmed;
alter table public.customer_lead_briefs
  add constraint customer_lead_briefs_auto_accept_confirmed
  check (auto_accepted_at is null or (confirmed_at is not null and effective_at is not null));

-- What the auto-accept cron (Phase 3) scans.
create index if not exists customer_lead_briefs_pending_effective_idx
  on public.customer_lead_briefs (effective_at)
  where status = 'pending_confirmation';

comment on column public.customer_lead_briefs.effective_at is
  'Batch 04 (0167). When a pending_confirmation version is meant to take effect: the return date after a long pause, or the renewal a monthly widening applies from. Required on a pending row; the 72-hour auto-accept counts from it.';

comment on column public.customer_lead_briefs.auto_accepted_at is
  'Batch 04 (0167). Set when the 72-hour auto-accept confirmed this version rather than the customer. confirmed_at is set with it.';

-- ---------------------------------------------------------------------------
-- 4. C2: a paused brief customer banks no replacements
--
-- 0153's body with one line added to the management term. Everything else is
-- unchanged, including §61's rule for every customer who is not a brief
-- customer: a pause still accrues for them.
--
-- ⚠️ Management only. A pause is a management state (§21, invariant 6): GR
-- keeps flowing to a paused management customer, and their GR share still
-- accrues.
--
-- How it lands: reset_monthly_counts grants only when this is above zero, so a
-- paused brief customer's replacement_granted_on is not stamped. Resuming
-- re-anchors the billing cycle to that day (§21), and the next 00:05 run grants
-- for the new cycle. Nothing for the paused months; the usual grant from the
-- day they return.
--
-- src/lib/quality/deadLeadPolicy.ts carries the TypeScript twin
-- (committedAllocation, monthlyReplacementGrant), pinned to this body by a
-- file-text guard.
-- ---------------------------------------------------------------------------
create or replace function public.replacement_monthly_grant(c public.customers)
returns integer
language sql
stable
set search_path = public
as $$
  select greatest(round((
      (case when (c.account_status = 'active'
                 or c.subscription_status in ('active', 'past_due'))
                and c.lapsed_at is null
                and not (coalesce(c.lead_brief_required, false) and c.paused_at is not null)
            then coalesce(c.monthly_allocation, 0) else 0 end)
    + (case when c.gr_subscription_status in ('active', 'past_due')
                and c.gr_lapsed_at is null
            then coalesce(c.gr_monthly_allocation, 0) else 0 end)
  ) * coalesce(c.quality_allowance_pct, 0.10))::integer, 0);
$$;

revoke execute on function public.replacement_monthly_grant(public.customers)
  from public, anon, authenticated;
grant execute on function public.replacement_monthly_grant(public.customers) to service_role;
