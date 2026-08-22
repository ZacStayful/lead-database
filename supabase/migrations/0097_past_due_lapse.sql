-- ============================================================================
-- Lapse a persistently-declined customer into a cancelled one.
--
-- THE GAP THIS CLOSES
-- -------------------
-- Nothing in this system ever converted a persistently-declined customer into a
-- cancelled one. Two facts combined to make that a permanent state rather than a
-- transient one:
--
--   * mapStatus() collapsed Stripe's `unpaid` — the TERMINAL dunning state, all
--     retries exhausted — into our `past_due`, so end-of-dunning was
--     indistinguishable from the first failed charge; and
--   * account_status only ever became 'cancelled' when Stripe reported `canceled`.
--     A payment failure never demoted it, by design, because a failure is usually
--     temporary.
--
-- So a customer who cancels the card authority behind their subscription — the
-- most common way a small operator actually leaves — sat at
-- subscription_status = 'past_due' with account_status = 'active' INDEFINITELY:
-- labelled "Wants to pay card declined" on the sales board for ever, still
-- consuming a management capacity slot (capacity.ts keys on account_status),
-- still carrying a green `active` badge in admin, and still able to buy a £75
-- top-up for leads candidate selection would never deliver.
--
-- The rule now: past_due for more than `past_due_lapse_days` (3) is treated as a
-- cancellation. Three days is short deliberately — Stripe's own retry schedule
-- runs for weeks, and the point of this is that the BOARD and the ACTIVE-CUSTOMER
-- COUNT stop describing someone as a paying customer long before Stripe gives up
-- on them.
--
-- WHAT THIS DOES NOT DO: it never calls Stripe. The subscription is left alone to
-- keep retrying, so nothing irreversible happens on a timer, and a late successful
-- payment restores the customer with no manual step — invoice.paid already
-- promotes account_status out of 'cancelled' (§23.9) and this migration's columns
-- are cleared on the same event.
--
-- FOUR COLUMNS, TWO JOBS, ONE WRITER EACH
-- ---------------------------------------
--   past_due_since / gr_past_due_since — when the CURRENT past-due episode began.
--     Written by the Stripe webhook, coalesce semantics: the first failure of an
--     episode wins and a retry never re-stamps it, or the three-day clock would
--     reset every time Stripe tried the card again and the lapse could never fire.
--     Mirrors first_contacted_at (§6) and cancelled_at.
--
--   lapsed_at / gr_lapsed_at — we have written this customer off. Written ONLY by
--     /api/cron/lapse-past-due, cleared only by recovery.
--
-- WHY lapsed_at EXISTS RATHER THAN REUSING account_status = 'cancelled'
-- ---------------------------------------------------------------------
-- mondayStatusLabelFor() must stay a PURE FUNCTION OF THE ROW — the property 0087
-- was written to establish, after a version that took the pending-cancellation
-- flag as a parameter let four of the six hooks silently write `Management
-- Customer` over `Cancelled`. So the lapse has to be visible in the row.
--
-- account_status alone cannot carry it. That rule's cancellation test deliberately
-- EXCLUDES past_due (`account_status = 'cancelled' and subscription_status not in
-- ('active','past_due')`) so that a stale 'cancelled' can never outvote a customer
-- who is demonstrably paying, and the rule must not depend on the §23.9 promotion
-- fix having run. Widening that test to admit past_due would re-open exactly the
-- hole it was written to close. An explicit stamp, with one writer, cannot be
-- confused with a stale status.
--
-- The lapse also deliberately does NOT write subscription_status. Leaving it
-- 'past_due' keeps the row honest about what Stripe actually reports, and means a
-- later customer.subscription.updated carrying past_due is a no-op rather than two
-- writers fighting over one column.
--
-- BOTH PRODUCTS (invariant 6), with the asymmetry stated rather than hidden:
-- gr_subscription_status = 'past_due' ALREADY excludes a GR customer from GR
-- routing and GR capacity, so for GR this is the board label and the date. The
-- management side is where the real defect was, because account_status is what
-- keeps a management customer in the capacity count.
--
-- Neither pair gates allocation. Routing continues to key on account_status /
-- subscription_status and their GR equivalents; the lapse changes a customer's
-- state through account_status, not by adding a new predicate to the candidate
-- functions.
-- ============================================================================

alter table public.customers
  add column if not exists past_due_since    timestamptz,
  add column if not exists gr_past_due_since timestamptz,
  add column if not exists lapsed_at         timestamptz,
  add column if not exists gr_lapsed_at      timestamptz;

comment on column public.customers.past_due_since is
  'When the CURRENT management past-due episode began. Stamped by the Stripe webhook on the first failure of an episode (never re-stamped by a retry), cleared on recovery. The clock /api/cron/lapse-past-due measures against.';
comment on column public.customers.gr_past_due_since is
  'Guaranteed Rent equivalent of past_due_since. Same writer, same coalesce and clearing rules.';
comment on column public.customers.lapsed_at is
  'Management subscription written off after past_due_lapse_days of failed collection. Written ONLY by /api/cron/lapse-past-due, cleared by invoice.paid / an active subscription event. Read by the Monday label rule (§23); gates nothing directly — account_status = ''cancelled'', written alongside it, is what removes the customer from active counts and capacity.';
comment on column public.customers.gr_lapsed_at is
  'Guaranteed Rent equivalent of lapsed_at. Never accompanied by an account_status write — that column is management-only (invariant 6).';

-- ---------------------------------------------------------------------------
-- Tunables, in system_settings beside pool_entry_days and the escalation
-- thresholds, so the threshold can be changed without a deploy and the job can be
-- switched off without one either.
--
-- past_due_lapse_enabled is a kill switch of the same shape as escalation_enabled
-- and pool_enabled: the route checks it first and LOGS a skipped run rather than
-- silently doing nothing, so "switched off" and "broken" are distinguishable.
-- ---------------------------------------------------------------------------
insert into public.system_settings (key, value)
  values ('past_due_lapse_enabled', 'true')
  on conflict (key) do nothing;

insert into public.system_settings (key, value)
  values ('past_due_lapse_days', '3')
  on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Backfill past_due_since for anyone ALREADY past_due at apply time.
--
-- Without it, a customer who has been declined for a fortnight would be handed a
-- null episode start and never lapse — the clock would only begin at their next
-- failed charge, which for a dead card may never come.
--
-- The source is the payments table, which has recorded every failure since the
-- webhook was written: the oldest consecutive 'failed' row for that product with
-- no successful payment after it. That is exactly "when did the current episode
-- begin". Falls back to updated_at where a customer is past_due with no failure
-- recorded at all (a status arriving through customer.subscription.updated rather
-- than an invoice event), which errs LATE — it lapses them no sooner than three
-- days from now, never retroactively.
--
-- Idempotent by the `is null` guard rather than by a conflict clause: re-running
-- can never move a stamp that already exists, and can never overwrite one the
-- webhook has since written.
--
-- ON LIVE DATA TODAY THIS MATCHES NOBODY — zero customers are past_due on either
-- product and exactly one failed payment has ever been recorded (recovered two
-- days later). It exists for the rebuild case and for a failure landing between
-- this migration and the code deploy.
-- ---------------------------------------------------------------------------
update public.customers c
   set past_due_since = coalesce(
         (select min(p.created_at)
            from public.payments p
           where p.customer_id = c.id
             and p.status = 'failed'
             and p.payment_type = 'subscription'
             and p.created_at > coalesce(
                   (select max(p2.created_at)
                      from public.payments p2
                     where p2.customer_id = c.id
                       and p2.status = 'paid'
                       and p2.payment_type = 'subscription'),
                   '-infinity'::timestamptz)),
         c.updated_at)
 where c.subscription_status = 'past_due'
   and c.past_due_since is null;

update public.customers c
   set gr_past_due_since = coalesce(
         (select min(p.created_at)
            from public.payments p
           where p.customer_id = c.id
             and p.status = 'failed'
             and p.payment_type = 'gr_subscription'
             and p.created_at > coalesce(
                   (select max(p2.created_at)
                      from public.payments p2
                     where p2.customer_id = c.id
                       and p2.status = 'paid'
                       and p2.payment_type = 'gr_subscription'),
                   '-infinity'::timestamptz)),
         c.updated_at)
 where c.gr_subscription_status = 'past_due'
   and c.gr_past_due_since is null;
