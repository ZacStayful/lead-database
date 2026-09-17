-- ============================================================================
-- 0153 — Replacements carry over (CLAUDE.md §61)
--
-- The replacement entitlement (§51.3, §53) was a per-cycle share of the plan —
-- round(committed allocation × quality_allowance_pct) plus an earned bonus —
-- spent through quality_claims_this_cycle and zeroed on the anchor day. Anything
-- unused was lost at the reset.
--
-- It is now a ROLLING BALANCE, on lead_balance's own shape (invariant 2: credits
-- carry forward): customers.replacement_balance is credited on a schedule and
-- spent one at a time. A 10-lead plan banks 1 a month; unused, next month they
-- have 2; a long-standing customer can swap out more than a one-month one.
-- Decisions taken with the owner and recorded in §61: no cap, seeded from
-- tenure, the earned streak bonus retired (rollover replaces it), one balance
-- shared by the credit path and the swap, a pause still accrues, a written-off
-- customer does not, and a top-up banks its share the moment it is paid.
--
-- What this file does, in order:
--
--   1. Two columns: replacement_balance (CHECK >= 0) and replacement_granted_on,
--      the cycle start the balance was last granted for.
--   2. replacement_monthly_grant(customers) — the ONE SQL home of the monthly
--      grant; replacement_cycle_start(customers) — the inverse of the app's
--      nextGrantDate(); seed_replacement_balances() — the one-off tenure seed,
--      idempotent, called once below and callable by the suite.
--   3. uphold_dead_lead_claim — 0137's body plus the decrement in both
--      branches, clamped at zero so an admin uphold can never fail.
--   4. record_lead_topup_success — 0042's body (the latest; 0074 only mentions
--      it) plus the top-up grant in both branches, inside the replay guard.
--   5. customer_swap_dead_lead — a new EIGHT-argument form with the
--      compare-and-swap replaced by `replacement_balance > 0`, and the
--      ELEVEN-argument form kept as a shim that ignores its three seen-values,
--      so the deployed route keeps working between apply and deploy (§1.1).
--      ⚠️ No defaults on any argument (§34/§35), and the shim body must not
--      contain the swap function's name even in a comment — 0143's suite counts
--      overloads whose prosrc names it and asserts exactly one.
--   6. reset_monthly_counts — 0141's body plus a FOURTH statement that grants.
--   7. get_service_capacity — 0147's body with the entitlement CTE reading the
--      balance. RETURNS TABLE is unchanged, so create or replace; grants
--      re-asserted, never anon (0140).
--   8. The seed, then revoke/grant on every signature touched.
--
-- ⚠️ NOT INERT. The seed writes a balance for every active holder the moment it
-- applies, and swaps_available_now (§53.13) steps that day. Every pre-existing
-- capacity figure is unchanged, which is asserted at apply rather than assumed.
--
-- Applied with comments stripped OUTSIDE function bodies only (§48.9, §51.10),
-- so every prosrc matches this file byte for byte.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 — Columns
-- ---------------------------------------------------------------------------
alter table public.customers
  add column if not exists replacement_balance integer not null default 0;

alter table public.customers
  add column if not exists replacement_granted_on date;

alter table public.customers
  drop constraint if exists customers_replacement_balance_check;
alter table public.customers
  add constraint customers_replacement_balance_check
  check (replacement_balance >= 0);

comment on column public.customers.replacement_balance is
  'Replacements banked and not yet spent (0153, §61). Credited by reset_monthly_counts on each cycle start and by record_lead_topup_success on each top-up; spent by customer_swap_dead_lead and by uphold_dead_lead_claim when a credit claim consumes the allowance. Carries over indefinitely; never zeroed on cancellation (invariant 2). Published to the customer on /dashboard/replacements.';

comment on column public.customers.replacement_granted_on is
  'The cycle start (replacement_cycle_start) the balance was last granted for. reset_monthly_counts grants when this is null or before the current cycle start, so a same-day re-run adds nothing and a missed day catches up.';

-- ---------------------------------------------------------------------------
-- 2 — The grant, the cycle, and the seed
--
-- ⚠️ replacement_monthly_grant is the ONE SQL home of the monthly grant. The
-- reset and the seed both call it; src/lib/quality/deadLeadPolicy.ts carries
-- the TypeScript transcription for the "N more are added on …" copy, and a
-- file-text guard pins the two together.
--
-- Who accrues: holders of a product, on holdsProduct()'s expressions (0147's
-- transcription) — management on account_status OR subscription_status,
-- guaranteed rent on gr_subscription_status — EXCLUDING a customer written off
-- under §59 (lapsed_at / gr_lapsed_at). A PAUSED customer still accrues, by the
-- owner's decision: a pause is not a departure, and the balance is there when
-- they return. Both products summed, then × the allowance, then rounded ONCE —
-- round(10 × 0.10) + round(10 × 0.10) is 2 where round(20 × 0.10) is 2 as well,
-- but round(1.0) + round(1.0) on two 10-lead plans at 0.05 would be 2 against a
-- true 1 (§53.4's trap).
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
            then coalesce(c.monthly_allocation, 0) else 0 end)
    + (case when c.gr_subscription_status in ('active', 'past_due')
                and c.gr_lapsed_at is null
            then coalesce(c.gr_monthly_allocation, 0) else 0 end)
  ) * coalesce(c.quality_allowance_pct, 0.10))::integer, 0);
$$;

-- The most recent anchor day on or before today, on the SAME coalesce order
-- as reset_monthly_counts' third statement (billing_cycle_anchor, then the GR
-- anchor, then the signup date) and with the same month-end clamp: an anchor on
-- the 31st falls on the last day of a short month. It is the inverse of
-- nextGrantDate() in src/lib/quality/replacementEntitlement.ts, which prints
-- the NEXT occurrence; the two must move together.
create or replace function public.replacement_cycle_start(c public.customers)
returns date
language sql
stable
set search_path = public
as $$
  with a as (
    select
      extract(day from coalesce(c.billing_cycle_anchor::date,
                                c.gr_billing_cycle_anchor::date,
                                c.created_at::date))::integer as dom,
      current_date as today,
      date_trunc('month', current_date)::date as month_start
  ),
  d as (
    select
      a.dom,
      a.today,
      a.month_start,
      extract(day from (a.month_start + interval '1 month - 1 day'))::integer as last_dom_this,
      (a.month_start - interval '1 month')::date as prev_month_start,
      extract(day from (a.month_start - interval '1 day'))::integer as last_dom_prev
    from a
  )
  select case
    when least(d.dom, d.last_dom_this) <= extract(day from d.today)::integer
      then d.month_start + (least(d.dom, d.last_dom_this) - 1)
    else d.prev_month_start + (least(d.dom, d.last_dom_prev) - 1)
  end
  from d;
$$;

-- The one-off seed, as a function so the suite can drive the formula against
-- seeded rows rather than restating it. Re-running it is a no-op: it touches
-- only rows never granted for any cycle.
--
-- start   = the customer's earliest PAID subscription invoice, else signup.
--           ⚠️ Never billing_cycle_anchor — invoice.paid re-anchors that to the
--           LAST invoice, so it says nothing about tenure.
-- balance = (completed months since start + 1) × today's monthly grant
--           + the share of every top-up they have ever bought
--           − every claim that already consumed the allowance, floored at 0.
--           The "+ 1" is this cycle's grant, so nobody who reads "3 of 3" today
--           reads 0 tomorrow.
-- granted_on = the current cycle start, so the fourth statement of
--           reset_monthly_counts next grants on the next anchor day, not
--           tomorrow.
create or replace function public.seed_replacement_balances()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer;
begin
  with paid_start as (
    select p.customer_id, min(p.created_at)::date as first_paid
      from public.payments p
      where p.status = 'paid'
        and p.payment_type in ('subscription', 'gr_subscription')
      group by p.customer_id
  ),
  topups as (
    select p.customer_id,
           sum(greatest(round(coalesce(p.credits_added, 0)
                              * coalesce(cu.quality_allowance_pct, 0.10))::integer, 0))::integer
             as topup_grants
      from public.payments p
      join public.customers cu on cu.id = p.customer_id
      where p.status = 'paid' and p.payment_type = 'topup'
      group by p.customer_id
  ),
  consumed as (
    select q.customer_id, count(*)::integer as n
      from public.lead_quality_claims q
      where q.allowance_consumed
      group by q.customer_id
  ),
  seed as (
    select
      c.id,
      public.replacement_monthly_grant(c) as grant_now,
      (extract(year  from age(current_date, coalesce(ps.first_paid, c.created_at::date))) * 12
       + extract(month from age(current_date, coalesce(ps.first_paid, c.created_at::date))))::integer
        as months_completed,
      coalesce(t.topup_grants, 0) as topup_grants,
      coalesce(cs.n, 0)           as consumed_n
    from public.customers c
    left join paid_start ps on ps.customer_id = c.id
    left join topups     t  on t.customer_id  = c.id
    left join consumed   cs on cs.customer_id = c.id
    where c.is_active
      and c.replacement_balance = 0
      and c.replacement_granted_on is null
      and public.replacement_monthly_grant(c) > 0
  ),
  written as (
    update public.customers c
      set replacement_balance    = greatest(
            (s.months_completed + 1) * s.grant_now + s.topup_grants - s.consumed_n, 0),
          replacement_granted_on = public.replacement_cycle_start(c),
          updated_at             = now()
      from seed s
      where c.id = s.id
      returning c.id
  )
  select count(*)::integer into v_n from written;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3 — uphold_dead_lead_claim: 0137's body, plus the decrement in both branches
-- ---------------------------------------------------------------------------
create or replace function public.uphold_dead_lead_claim(p_claim_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim     public.lead_quality_claims%rowtype;
  v_lead_type public.lead_type;
begin
  select * into v_claim
    from public.lead_quality_claims
    where id = p_claim_id
    for update;
  if not found then
    raise exception 'Quality claim % not found', p_claim_id;
  end if;

  select lead_type into v_lead_type from public.leads where id = v_claim.lead_id;

  -- Invariant 6: both products, never a management-only column to gate GR.
  if v_lead_type = 'guaranteed_rent' then
    update public.customers
      set gr_lead_balance = gr_lead_balance + 1,
          gr_leads_received_this_month = greatest(gr_leads_received_this_month - 1, 0),
          quality_claims_this_cycle = quality_claims_this_cycle
            + case when v_claim.allowance_consumed then 1 else 0 end,
          clean_leads_streak = 0,
          -- 0153 (§61): the credit spends one banked replacement. Clamped
          -- HERE and only here — an admin uphold must never fail on the
          -- CHECK when a reviewed claim lands after the balance is spent.
          replacement_balance = greatest(
            replacement_balance
              - case when v_claim.allowance_consumed then 1 else 0 end, 0),
          updated_at = now()
      where id = v_claim.customer_id;
  else
    update public.customers
      set lead_balance = lead_balance + 1,
          leads_received_this_month = greatest(leads_received_this_month - 1, 0),
          quality_claims_this_cycle = quality_claims_this_cycle
            + case when v_claim.allowance_consumed then 1 else 0 end,
          clean_leads_streak = 0,
          -- 0153 (§61): the credit spends one banked replacement. Clamped
          -- HERE and only here — an admin uphold must never fail on the
          -- CHECK when a reviewed claim lands after the balance is spent.
          replacement_balance = greatest(
            replacement_balance
              - case when v_claim.allowance_consumed then 1 else 0 end, 0),
          updated_at = now()
      where id = v_claim.customer_id;
  end if;

  update public.lead_quality_claims
    set resolution = 'credit'
    where id = p_claim_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4 — record_lead_topup_success: 0042's body, plus the top-up grant
--
-- ⚠️ 0042 is the LATEST definition. 0074 mentions this function in a comment
-- ("top-ups credit through record_lead_topup_success, not this function") and
-- does not redefine it. Both webhook call sites — checkout.session.completed
-- and the payment_intent.succeeded recovery — go through this one RPC, so there
-- is no second top-up path to cover. The grant sits inside the existing replay
-- guard (`charge_status = 'paid' → return false`), so a redelivered Stripe
-- event adds nothing. round(5 × 0.10) is 1: each 5-lead top-up banks one.
-- ---------------------------------------------------------------------------
create or replace function public.record_lead_topup_success(
  p_token_id uuid,
  p_payment_intent_id text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tok public.lead_topup_tokens%rowtype;
  v_payment_id uuid;
begin
  select * into v_tok
    from public.lead_topup_tokens
    where id = p_token_id
    for update;

  if not found then return false; end if;
  -- Only an already-PAID token is a replay. A 'failed' token is promoted, so a
  -- charge that actually succeeded can still be credited after the fact.
  if v_tok.charge_status = 'paid' then return false; end if;

  insert into public.payments (
    customer_id, stripe_payment_intent_id, amount_pence, credits_added,
    payment_type, status, lead_type
  ) values (
    v_tok.customer_id, p_payment_intent_id, v_tok.amount_pence, v_tok.credits,
    'topup', 'paid', v_tok.lead_type
  )
  returning id into v_payment_id;

  if v_tok.lead_type = 'guaranteed_rent' then
    update public.customers
      set gr_lead_balance = gr_lead_balance + v_tok.credits,
          -- 0153 (§61): a top-up banks its share of replacements at once.
          replacement_balance = replacement_balance
            + greatest(round(v_tok.credits * coalesce(quality_allowance_pct, 0.10))::integer, 0),
          updated_at = now()
      where id = v_tok.customer_id;
  else
    update public.customers
      set lead_balance = lead_balance + v_tok.credits,
          -- 0153 (§61): a top-up banks its share of replacements at once.
          replacement_balance = replacement_balance
            + greatest(round(v_tok.credits * coalesce(quality_allowance_pct, 0.10))::integer, 0),
          updated_at = now()
      where id = v_tok.customer_id;
  end if;

  update public.lead_topup_tokens
    set charge_status = 'paid',
        payment_id = v_payment_id,
        used_at = coalesce(used_at, now())
    where id = v_tok.id;

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5 — customer_swap_dead_lead: the eight-argument form, and the shim
-- ---------------------------------------------------------------------------
create or replace function public.customer_swap_dead_lead(
  p_assignment_id         uuid,
  p_customer_id           uuid,
  p_new_lead_id           uuid,
  p_reason                text,
  p_detail                text,
  p_contacted_on          date,
  p_allow_filter_mismatch boolean,
  p_window_days           integer
)
returns table (
  claim_id                 uuid,
  replacement_assignment_id uuid,
  original_lead_id         uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead_id   uuid;
  v_lead_type public.lead_type;
  v_claim_id  uuid;
  v_new_id    uuid;
  v_stock     integer;
  v_floor     integer;
begin
  if length(btrim(coalesce(p_detail, ''))) < 20 then
    raise exception 'Tell us what the landlord actually said, in at least 20 characters';
  end if;

  -- Eligibility is NOT decided here (§51.7). claimable_dead_lead_assignments is
  -- the one predicate, and re-asserting it inside the transaction is what stops
  -- two submits both passing on a stale page.
  select c.lead_id into v_lead_id
    from public.claimable_dead_lead_assignments(p_customer_id, p_window_days) c
    where c.assignment_id = p_assignment_id;

  if v_lead_id is null then
    raise exception 'This lead can no longer be reported';
  end if;

  select l.lead_type into v_lead_type from public.leads l where l.id = v_lead_id;

  -- ⚠️ THE STOCK FLOOR — the back-pressure the capacity panel structurally
  -- cannot apply (§16: nothing gates on it). Measured on the PRODUCT's whole
  -- unsold pool rather than this customer's filtered subset, because the risk
  -- being managed is the pool emptying: one filtered customer with a single
  -- matching lead costs the pool one lead, which is fine while there are
  -- seventy. Below the floor nobody swaps and the claim goes to review.
  select coalesce(nullif(s.value, '')::integer, 10) into v_floor
    from public.system_settings s where s.key = 'replacement_stock_floor';
  v_floor := coalesce(v_floor, 10);

  select count(*) into v_stock
    from public.leads l
    where l.lead_type = v_lead_type
      and l.owner_customer_id is null
      and l.withdrawn_at is null
      and l.assignment_count < l.max_assignments
      and not public.lead_retired_from_allocation(l.id);

  if v_stock < v_floor then
    raise exception 'stock_floor';
  end if;

  -- The claim is written BEFORE the swap. Reorder these and the
  -- quality_claim_id UPDATE below silently touches ZERO rows, because the swap
  -- has already deleted the assignment — no error, and a claim whose pointer
  -- never existed. Harmless today, since that row is being deleted either way
  -- and a rollback takes both with it; written this way so it stays true if
  -- anything later reads the pointer before the swap.
  insert into public.lead_quality_claims (
    lead_assignment_id, lead_id, customer_id, reason, detail, contacted_on,
    status, resolution, allowance_consumed, replacement_lead_id
  )
  values (
    p_assignment_id, v_lead_id, p_customer_id, p_reason, btrim(p_detail),
    p_contacted_on, 'auto_upheld', 'self_swap', true, p_new_lead_id
  )
  returning id into v_claim_id;

  update public.lead_assignments
    set quality_claim_id = v_claim_id
    where id = p_assignment_id;

  -- The THREE-argument form with an explicit boolean (§34). The two-argument
  -- shim delegates false, and a null here would silently place a lead outside
  -- the customer's own filter.
  v_new_id := public.admin_swap_lead_assignment(
    p_assignment_id,
    p_new_lead_id,
    coalesce(p_allow_filter_mismatch, false)
  );

  update public.lead_quality_claims
    set replacement_assignment_id = v_new_id
    where id = v_claim_id;

  -- Spend one banked replacement (0153, §61). Conditional on the balance,
  -- so two concurrent swaps cannot both pass, and a refusal rolls the whole
  -- swap back with it.
  --
  -- ⚠️ NO CUSTOMER ROW LOCK IS TAKEN HERE, and none is needed (§53.6).
  -- admin_swap_lead_assignment above already holds the customer row —
  -- assignment → old lead → new lead → customer — and holds it until
  -- commit. A second swap for the same customer blocks inside that call,
  -- and when it proceeds this UPDATE re-evaluates `replacement_balance > 0`
  -- against the committed row (READ COMMITTED re-check) and raises.
  --
  -- The three seen-values 0141/0142 compared are gone: the balance IS the
  -- entitlement, so there is no TypeScript arithmetic for the row to have
  -- drifted from. quality_claims_this_cycle and clean_leads_streak are
  -- still written, as the per-cycle statistics admin reads; neither gates
  -- anything any more.
  update public.customers
    set replacement_balance       = replacement_balance - 1,
        quality_claims_this_cycle = quality_claims_this_cycle + 1,
        clean_leads_streak        = 0,
        updated_at                = now()
    where id = p_customer_id
      and replacement_balance > 0;

  if not found then
    raise exception 'no_entitlement';
  end if;

  claim_id                  := v_claim_id;
  replacement_assignment_id := v_new_id;
  original_lead_id          := v_lead_id;
  return next;
end;
$$;

-- The ELEVEN-argument form, kept as a shim (§1.1: the route deployed at apply
-- time still sends p_entitlement, p_claims_seen and p_streak_seen). All three
-- are ignored — the balance is the entitlement now. Parameter names are the
-- originals exactly, because CREATE OR REPLACE refuses to rename them, and
-- PostgREST resolves the overload by the set of names the request carries, so
-- eight keys and eleven keys can never collide. Drop it in a later migration
-- once nothing deployed sends the three.
create or replace function public.customer_swap_dead_lead(
  p_assignment_id         uuid,
  p_customer_id           uuid,
  p_new_lead_id           uuid,
  p_reason                text,
  p_detail                text,
  p_contacted_on          date,
  p_entitlement           integer,
  p_claims_seen           integer,
  p_streak_seen           integer,
  p_allow_filter_mismatch boolean,
  p_window_days           integer
)
returns table (
  claim_id                 uuid,
  replacement_assignment_id uuid,
  original_lead_id         uuid
)
language sql
security definer
set search_path = public
as $$
  select s.claim_id, s.replacement_assignment_id, s.original_lead_id
    from public.customer_swap_dead_lead(
      p_assignment_id, p_customer_id, p_new_lead_id, p_reason, p_detail,
      p_contacted_on, p_allow_filter_mismatch, p_window_days) s;
$$;

-- ---------------------------------------------------------------------------
-- 6 — reset_monthly_counts: 0141's body, plus the fourth statement
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

  -- 0153 (§61): the monthly replacement grant lands in the balance.
  --
  -- ⚠️ A FOURTH STATEMENT, NEVER FOLDED INTO THE THIRD. The three above are
  -- `= 0` and therefore idempotent on a same-day re-run; this one is `+ grant`
  -- and is not, so it carries its own guard. 0141's suite runs this function
  -- three times on one day and expects the counter re-zeroed on the third.
  --
  -- ⚠️ "NOT YET GRANTED FOR THE CURRENT CYCLE", NOT "ANCHOR DAY = TODAY". A new
  -- customer whose first invoice lands at 10:00 sets their anchor to today,
  -- after the 00:05 run has passed — under a day-of-month match they would
  -- wait a month for a grant the tab already promises. Under this rule they
  -- are granted the next morning; a run that misses a day catches up; and a
  -- same-day re-run adds nothing. replacement_granted_on records the cycle
  -- start the balance was last granted for.
  --
  -- ⚠️ THIS ONE IS STATUS-GATED AND THE THREE ABOVE ARE NOT, on purpose. The
  -- pacing counters must reset for everyone (0018); a grant to a customer
  -- holding no product would bank replacements for somebody not paying.
  -- replacement_monthly_grant() is the one home of who accrues and how much.
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

-- ---------------------------------------------------------------------------
-- 7 — get_service_capacity: 0147's body, the entitlement CTE reading the balance
--
-- RETURNS TABLE is unchanged, so this is a create or replace and the ACL
-- survives; the grants are re-asserted below regardless, never anon (0140).
-- capture_service_capacity and the snapshot columns are untouched.
-- ---------------------------------------------------------------------------
create or replace function public.get_service_capacity()
returns table (lead_type lead_type, leads_per_month numeric, slots_per_month numeric, recycled_slots_per_month numeric, serviceable_slots_per_month numeric, recycling_basis text, recycled_slots_now integer, unworked_rate numeric, recycling_sample integer, inventory_slots_now integer, unsold_leads_now integer, demand_per_month integer, delivered_per_month numeric, active_customers integer, fully_served integer, avg_allocation numeric, sustainable_customers integer, sustainable_customers_new_only integer, room_for_customers integer, paused_customers integer, paused_demand integer, quality_claim_demand_per_month integer, avg_allocation_with_swaps numeric, sustainable_customers_before_swaps integer, withdrawn_slots_per_month numeric, avg_withdrawal_cost numeric, withdrawal_basis text, swaps_available_now integer, swap_slots_now numeric)
language sql
stable
security definer
set search_path = public
as $function$
  with w as (select 28 as days),
  rw as (select 90 as days),
  supply as (
    select
      lt.lead_type,
      count(l.id)                         as leads_in_window,
      coalesce(sum(l.max_assignments), 0) as slots_in_window,
      count(l.id) filter (where l.max_assignments < 5) as one_rung_headroom
    from (select unnest(enum_range(null::public.lead_type)) as lead_type) lt
    left join public.leads l
      on l.lead_type = lt.lead_type
     and l.created_at >= now() - make_interval(days => (select days from w))
    group by lt.lead_type
  ),
  delivered as (
    select lt.lead_type, count(la.id) as n
    from (select unnest(enum_range(null::public.lead_type)) as lead_type) lt
    left join public.leads l on l.lead_type = lt.lead_type
    left join public.lead_assignments la
      on la.lead_id = l.id
     and la.assigned_at >= now() - make_interval(days => (select days from w))
    group by lt.lead_type
  ),
  observed as (
    select
      lt.lead_type,
      (count(*) filter (where la.escalation_stage_1_at >= now() - make_interval(days => (select days from w)))
       + count(*) filter (where la.escalation_stage_2_at >= now() - make_interval(days => (select days from w))))::integer as n
    from (select unnest(enum_range(null::public.lead_type)) as lead_type) lt
    left join public.leads l on l.lead_type = lt.lead_type
    left join public.lead_assignments la on la.lead_id = l.id
    group by lt.lead_type
  ),
  recycling as (
    select
      lt.lead_type,
      count(la.id)::integer as sample_10,
      count(la.id) filter (where not la.active_by_10)::integer as escalates_at_10
    from (select unnest(enum_range(null::public.lead_type)) as lead_type) lt
    left join (
      select
        a.id, l.lead_type,
        (exists (select 1 from public.lead_events e
                  where e.assignment_id = a.id
                    and e.event_type in ('tel_click', 'mailto_click', 'whatsapp_click', 'stage_changed')
                    and e.created_at < a.assigned_at + interval '10 days')
         or exists (select 1 from public.lead_notes n
                     where n.lead_assignment_id = a.id
                       and n.created_at < a.assigned_at + interval '10 days')
         or (a.status <> 'new'
             and a.last_status_change_at < a.assigned_at + interval '10 days')
        ) as active_by_10
      from public.lead_assignments a
      join public.leads l on l.id = a.lead_id
      where a.assigned_at <= now() - interval '10 days'
        and a.assigned_at >= now() - make_interval(days => (select days from rw))
        and a.closed_at is null
        and a.status not in ('won', 'rejected')
    ) la on la.lead_type = lt.lead_type
    group by lt.lead_type
  ),
  passable as (
    select
      lt.lead_type,
      count(distinct a.lead_id)::integer as n
    from (select unnest(enum_range(null::public.lead_type)) as lead_type) lt
    left join public.leads l on l.lead_type = lt.lead_type
    left join public.lead_assignments a
      on a.lead_id = l.id
     and a.assigned_at <= now() - interval '10 days'
     and a.inactivity_escalation_stage < 2
     and a.status not in ('won', 'rejected')
     and a.closed_at is null
     and l.max_assignments < 5
     and not exists (
       select 1 from public.lead_assignments closed
       where closed.lead_id = a.lead_id and closed.closed_at is not null
     )
     and not (
       exists (select 1 from public.lead_events e
                where e.assignment_id = a.id
                  and e.event_type in ('tel_click', 'mailto_click', 'whatsapp_click', 'stage_changed')
                  and e.created_at >= now() - interval '10 days')
       or exists (select 1 from public.lead_notes n
                   where n.lead_assignment_id = a.id
                     and n.created_at >= now() - interval '10 days')
       or (a.status <> 'new'
           and a.last_status_change_at >= now() - interval '10 days')
     )
    group by lt.lead_type
  ),
  served as (
    select
      'management'::public.lead_type as lead_type,
      count(*)::integer as customers,
      count(*) filter (where got >= promised)::integer as fully_served,
      coalesce(round(avg(promised), 1), 0) as avg_alloc,
      coalesce(sum(promised), 0)::integer as demand,
      coalesce(round(avg(promised * (1 + coalesce(pct, 0.10))), 1), 0) as avg_alloc_with_swaps,
      coalesce(round(sum(promised * coalesce(pct, 0.10))), 0)::integer as swap_demand
    from (
      select c.id, c.monthly_allocation as promised,
        c.quality_allowance_pct as pct,
        (select count(*) from public.lead_assignments la
           join public.leads l on l.id = la.lead_id
          where la.customer_id = c.id and l.lead_type = 'management'
            and la.assigned_at >= coalesce(c.billing_cycle_anchor, c.created_at::date)
        ) as got
      from public.customers c
      where c.is_active and c.account_status = 'active'
        and c.subscription_status = 'active'
        and c.paused_at is null
    ) m
    union all
    select
      'guaranteed_rent'::public.lead_type,
      count(*)::integer,
      count(*) filter (where got >= promised)::integer,
      coalesce(round(avg(promised), 1), 0),
      coalesce(sum(promised), 0)::integer,
      coalesce(round(avg(promised * (1 + coalesce(pct, 0.10))), 1), 0),
      coalesce(round(sum(promised * coalesce(pct, 0.10))), 0)::integer
    from (
      select c.id, c.gr_monthly_allocation as promised,
        c.quality_allowance_pct as pct,
        (select count(*) from public.lead_assignments la
           join public.leads l on l.id = la.lead_id
          where la.customer_id = c.id and l.lead_type = 'guaranteed_rent'
            and la.assigned_at >= coalesce(c.gr_billing_cycle_anchor, c.created_at::date)
        ) as got
      from public.customers c
      where c.is_active and c.gr_subscription_status = 'active'
    ) g
  ),
  paused_side as (
    select
      'management'::public.lead_type as lead_type,
      count(*)::integer as n,
      coalesce(sum(c.monthly_allocation), 0)::integer as demand
    from public.customers c
    where c.is_active and c.account_status = 'active'
      and c.subscription_status = 'active'
      and c.paused_at is not null
    union all
    select 'guaranteed_rent'::public.lead_type, 0, 0
  ),
  -- 0147. THE STANDING EXPOSURE — replacements customers could take TODAY.
  --
  -- ⚠️ REPORTED, NEVER ADDED, on the same rule 0145 states one CTE below. The
  -- replacement half of a swap is already charged into avg_alloc_with_swaps and
  -- the withdrawn half lands inside slots_pm the instant it happens, so this
  -- figure is a LABEL ON TIMING and not a third supply term. What it answers is
  -- the one thing neither of those can: how much of that cost is queued up and
  -- has not been taken yet.
  --
  -- ⚠️ SINCE 0153 (§61) THE ENTITLEMENT IS A STORED BALANCE, and this reads it
  -- rather than deriving it. `swap_demand` in the served CTE still models the
  -- recurring monthly RATE over the population the ceiling is about (active,
  -- unpaused, per product, plan-based). This one is the standing STOCK over
  -- the population that can actually claim: the replacements each customer
  -- has banked and not spent, which is exactly what customer_swap_dead_lead
  -- decrements. The two are different figures on purpose and must not be
  -- "reconciled" by making one match the other.
  --
  -- ⚠️ NOT greatest(balance, 0). The column carries a CHECK (>= 0), so a
  -- clamp here is unobservable — the §50.9 shape 0147 removed a short-circuit
  -- to avoid.
  entitlement as (
    select
      c.id,
      c.paused_at,
      c.replacement_balance as remaining
    from public.customers c
    where c.is_active
      and (c.account_status = 'active'
        or c.subscription_status in ('active', 'past_due')
        or c.gr_subscription_status in ('active', 'past_due'))
  ),
  -- ⚠️ BOUNDED BY BOTH HALVES, and the second half is what makes the figure
  -- worth having. Entitlement alone reads 31 across the book; only 13 of it
  -- sits with a customer who also has something inside the claim window, and
  -- quoting 31 would be an alarm about leads that cannot be reported.
  --
  -- ⚠️ CALLS claimable_dead_lead_assignments RATHER THAN RESTATING IT, with its
  -- own default window, so the claim rule has no second copy here and the
  -- 14 is not written down twice (§34, §35). The window is the longest of the
  -- six reasons — `already_with_operator` is 7 — so this is an upper bound on
  -- the count, which is the safe direction for an exposure figure.
  --
  -- ⚠️ A PAUSED MANAGEMENT CUSTOMER IS EXCLUDED FROM THE MANAGEMENT ROW ONLY.
  -- admin_swap_lead_assignment raises on one, so their entitlement is not
  -- exposure — they cannot spend it. §21 excludes paused customers from every
  -- allocation metric on exactly this reasoning, management branch only
  -- (invariant 6): GR keeps flowing to a paused management customer, and GR has
  -- no pause of its own.
  --
  -- A dual-product customer's one budget is counted against BOTH rows, as
  -- swap_demand already does. There are none today; it overstates rather than
  -- understates, which is the safe direction here too.
  pending as (
    select
      lt.lead_type,
      coalesce(sum(least(x.remaining, x.n)), 0)::integer as swaps_now
    from (select unnest(enum_range(null::public.lead_type)) as lead_type) lt
    left join (
      select l.lead_type, e.id, e.remaining, count(*) as n
      from entitlement e
      cross join lateral public.claimable_dead_lead_assignments(e.id) cda
      join public.leads l on l.id = cda.lead_id
      -- ⚠️ NO `remaining > 0` SHORT-CIRCUIT HERE, deliberately. It would save a
      -- lateral call per spent customer and it would also make the zero clamp
      -- above unobservable — a guard no test could ever fail, which is §50.9's
      -- shape and what the mutation run on this migration actually found. The
      -- clamp is the rule (a reviewed uphold can push the counter past the
      -- entitlement, §53), so the clamp stays and the short-circuit goes.
      where (l.lead_type = 'guaranteed_rent' or e.paused_at is null)
      group by l.lead_type, e.id, e.remaining
    ) x on x.lead_type = lt.lead_type
    group by lt.lead_type
  ),
  -- 0145. What swaps have actually destroyed inside the supply window.
  --
  -- Measured on withdrawn_at, not created_at: this is a flow of destruction
  -- events, where every other CTE here is a flow of arrivals.
  --
  -- ⚠️ Rows withdrawn before 0145 carry a NULL and are INVISIBLE here rather
  -- than counted as zero. Their caps were overwritten by the clamp and cannot
  -- be recovered, and a zero would read as "that swap cost nothing" — the one
  -- reading this column exists to prevent. It self-clears 28 days after apply.
  withdrawn as (
    select
      lt.lead_type,
      coalesce(sum(l.withdrawn_slots), 0)::numeric as slots_lost,
      count(l.id)::integer                         as n
    from (select unnest(enum_range(null::public.lead_type)) as lead_type) lt
    left join public.leads l
      on l.lead_type = lt.lead_type
     and l.withdrawn_slots is not null
     and l.withdrawn_at >= now() - make_interval(days => (select days from w))
    group by lt.lead_type
  ),
  -- What withdrawing a lead somebody holds right now would cost, averaged per
  -- ASSIGNMENT because a report is made by an assignment: a lead held by three
  -- operators is three chances to incur a cost of one each, where a lead held
  -- by one is a single chance to incur three. Per lead would over-weight the
  -- expensive singly-held ones.
  --
  -- ⚠️ DELIBERATELY NOT A COPY OF claimable_dead_lead_assignments, and it must
  -- never become one. That predicate decides whether money moves; this feeds an
  -- estimate labelled `estimated`. §34 and §35 both record what a hand-written
  -- second copy of a live rule costs, so this population is defined by the
  -- WITHDRAWAL mechanics instead — an open assignment on a lead that can still
  -- be withdrawn — and shares no clause with the claim rule beyond what those
  -- mechanics require.
  --
  -- The known skew, stated rather than hidden: reports arrive within days of
  -- assignment and this averages over every held lead, including older ones
  -- that have since filled up and cost less to withdraw. So it reads LOW —
  -- 1.17 against 1.53 over the 14-day claim window for management at the time
  -- of writing.
  withdrawal_cost as (
    select
      lt.lead_type,
      coalesce(round(avg(h.cost), 2), 0) as avg_cost
    from (select unnest(enum_range(null::public.lead_type)) as lead_type) lt
    left join (
      select
        l.lead_type,
        greatest(l.max_assignments - greatest(l.assignment_count - 1, 0), 0) as cost
      from public.lead_assignments la
      join public.leads l on l.id = la.lead_id
      where la.status not in ('won', 'rejected')
        and la.closed_at is null
        and l.withdrawn_at is null
        and l.owner_customer_id is null
    ) h on h.lead_type = lt.lead_type
    group by lt.lead_type
  ),
  inventory as (
    select
      lt.lead_type,
      coalesce(sum(greatest(l.max_assignments - l.assignment_count, 0)), 0)::integer as open_slots,
      count(l.id) filter (where l.assignment_count = 0)::integer                     as unsold
    from (select unnest(enum_range(null::public.lead_type)) as lead_type) lt
    left join public.leads l on l.lead_type = lt.lead_type
    group by lt.lead_type
  ),
  calc as (
    select
      s.lead_type,
      round(s.leads_in_window * 30.0 / (select days from w), 1) as leads_pm,
      round(s.slots_in_window * 30.0 / (select days from w), 1) as slots_pm,
      round(d.n * 30.0 / (select days from w), 1)               as delivered_pm,
      round(o.n * 30.0 / (select days from w), 1)               as observed_pm,
      o.n                                                        as observed_raw,
      r.sample_10 as sample,
      case when r.sample_10 > 0
           then round(r.escalates_at_10::numeric / r.sample_10, 4) end as rate_10,
      round(s.one_rung_headroom * 30.0 / (select days from w), 1) as headroom_pm,
      sv.demand, sv.customers, sv.fully_served, sv.avg_alloc,
      sv.avg_alloc_with_swaps, sv.swap_demand,
      i.open_slots, i.unsold, p.n as passable_now,
      ps.n as paused_n, ps.demand as paused_demand,
      wd.slots_lost, wd.n as withdrawn_n, wc.avg_cost as withdrawal_cost,
      pg.swaps_now
    from supply s
    join delivered d  on d.lead_type = s.lead_type
    join served sv    on sv.lead_type = s.lead_type
    join paused_side ps on ps.lead_type = s.lead_type
    join inventory i  on i.lead_type = s.lead_type
    join recycling r  on r.lead_type = s.lead_type
    join observed o   on o.lead_type = s.lead_type
    join passable p   on p.lead_type = s.lead_type
    join withdrawn wd on wd.lead_type = s.lead_type
    join withdrawal_cost wc on wc.lead_type = s.lead_type
    join pending pg  on pg.lead_type = s.lead_type
  ),
  scored as (
    select
      c.*,
      case when c.observed_raw > 0 then 'observed' else 'estimated' end as basis,
      least(
        case
          when c.observed_raw > 0 then c.observed_pm
          else round(c.delivered_pm * coalesce(c.rate_10, 0), 1)
        end,
        c.headroom_pm
      ) as recycled_pm
    from calc c
  )
  select
    s.lead_type,
    s.leads_pm,
    s.slots_pm,
    s.recycled_pm,
    round(s.slots_pm + s.recycled_pm, 1),
    s.basis,
    s.passable_now,
    s.rate_10,
    s.sample,
    s.open_slots,
    s.unsold,
    s.demand,
    s.delivered_pm,
    s.customers,
    s.fully_served,
    s.avg_alloc,
    case when s.avg_alloc_with_swaps > 0
         then floor((s.slots_pm + s.recycled_pm) / s.avg_alloc_with_swaps)::integer
         else 0 end,
    case when s.avg_alloc_with_swaps > 0
         then floor(s.slots_pm / s.avg_alloc_with_swaps)::integer
         else 0 end,
    case when s.avg_alloc_with_swaps > 0
         then greatest(
           floor((s.slots_pm + s.recycled_pm) / s.avg_alloc_with_swaps)::integer - s.customers,
           0)
         else 0 end,
    s.paused_n,
    s.paused_demand,
    s.swap_demand,
    s.avg_alloc_with_swaps,
    case when s.avg_alloc > 0
         then floor((s.slots_pm + s.recycled_pm) / s.avg_alloc)::integer
         else 0 end,
    -- 0145. ⚠️ REPORTED, NEVER ADDED TO ANY CEILING ABOVE, and never folded
    -- into avg_alloc_with_swaps. slots_pm is sum(max_assignments) over the
    -- window and the swap's clamp lowers it the instant a withdrawal happens,
    -- so the cost is already inside serviceable_slots_per_month. Charging it a
    -- second time in the divisor would double-count it. What this figure is
    -- for is the LAG: the ceiling reflects the last 28 days of withdrawals, not
    -- the entitlement every customer is holding and has not yet spent.
    case when s.withdrawn_n > 0
         then round(s.slots_lost * 30.0 / (select days from w), 1)
         else round(s.swap_demand * s.withdrawal_cost, 1) end,
    s.withdrawal_cost,
    -- §18.2's rule: an estimate must never be read as a count.
    case when s.withdrawn_n > 0 then 'observed' else 'estimated' end,
    -- 0147. A live count, so no basis column: it is observed by construction,
    -- and a third basis that could only ever read 'observed' would be noise.
    s.swaps_now,
    -- What those would take out of supply if every one were taken today. It
    -- carries a decimal because avg_withdrawal_cost is a modelled average —
    -- which is the whole of §18.2's rule applied without a second label.
    --
    -- ⚠️ THE REPLACEMENT LEAD ITSELF IS NOT COUNTED HERE. Each swap also takes
    -- one lead out of stock, and that half is already charged into
    -- avg_alloc_with_swaps. Adding it would be the double-count §53.11 exists
    -- to stop.
    round(s.swaps_now * s.withdrawal_cost, 1)
  from scored s;
$function$;

-- ---------------------------------------------------------------------------
-- 8 — The seed, then the grants
-- ---------------------------------------------------------------------------
select public.seed_replacement_balances();

revoke execute on function public.replacement_monthly_grant(public.customers)
  from public, anon, authenticated;
grant execute on function public.replacement_monthly_grant(public.customers) to service_role;

revoke execute on function public.replacement_cycle_start(public.customers)
  from public, anon, authenticated;
grant execute on function public.replacement_cycle_start(public.customers) to service_role;

revoke execute on function public.seed_replacement_balances()
  from public, anon, authenticated;
grant execute on function public.seed_replacement_balances() to service_role;

revoke execute on function public.uphold_dead_lead_claim(uuid)
  from public, anon, authenticated;
grant execute on function public.uphold_dead_lead_claim(uuid) to service_role;

revoke execute on function public.record_lead_topup_success(uuid, text)
  from public, anon, authenticated;
grant execute on function public.record_lead_topup_success(uuid, text) to service_role;

revoke execute on function public.customer_swap_dead_lead(
  uuid, uuid, uuid, text, text, date, boolean, integer)
  from public, anon, authenticated;
grant execute on function public.customer_swap_dead_lead(
  uuid, uuid, uuid, text, text, date, boolean, integer) to service_role;

revoke execute on function public.customer_swap_dead_lead(
  uuid, uuid, uuid, text, text, date, integer, integer, integer, boolean, integer)
  from public, anon, authenticated;
grant execute on function public.customer_swap_dead_lead(
  uuid, uuid, uuid, text, text, date, integer, integer, integer, boolean, integer)
  to service_role;

revoke execute on function public.reset_monthly_counts() from public, anon, authenticated;
grant execute on function public.reset_monthly_counts() to service_role;

revoke execute on function public.get_service_capacity() from public, anon, authenticated;
grant execute on function public.get_service_capacity() to service_role;
