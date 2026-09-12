-- 0141 — Self-serve lead replacement (§53)
--
-- §51 gave an operator a way to report a lead that was already gone; §52 let an
-- ADMIN settle that report with a replacement. Production holds zero claims
-- against 93 eligible assignments across 13 customer books, which is the same
-- "nobody could find it" failure §51.10 already had to fix once. This puts the
-- replacement in the customer's own hands.
--
-- ⚠️ THIS REVERSES §52.1, WHICH SAYS IN A BOX THAT A SWAP IS ALWAYS MANUAL.
-- That section's argument is arithmetic, not caution: a swap costs TWO leads —
-- the replacement handed over, and the reported lead withdrawn by
-- admin_swap_lead_assignment clamping max_assignments down to assignment_count
-- — against roughly 70 management leads carrying a free slot. The arithmetic
-- has not changed and is not answered by measuring it afterwards, because
-- get_service_capacity is a dashboard and §16 says nothing gates on it.
--
-- So the reversal comes with a real floor, not just a meter:
--
--   1. A published per-customer entitlement that HARD-STOPS. Over it, the tab
--      refuses. This is the second reversal — §51.3 says the allowance is never
--      shown and no copy may name it. Publishing it is what makes a refusal
--      legible rather than mysterious, and it is a deliberate product decision.
--   2. replacement_stock_floor — a system_settings key. When matching unsold
--      stock for that customer falls below it, the swap is refused and the
--      claim goes to review. This is the back-pressure the capacity panel
--      structurally cannot apply.
--
-- Everything else about §51 is untouched: the credit path, decideDeadLeadClaim,
-- the indistinguishable wording of a review outcome, and the hidden budget as
-- it applies to CREDIT claims all behave exactly as they did.

-- ---------------------------------------------------------------------------
-- 1 — The stock floor
-- ---------------------------------------------------------------------------

insert into public.system_settings (key, value)
values ('replacement_stock_floor', '10')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2 — resolution gains 'self_swap'
--
-- ⚠️ NOT REUSING 'swap'. 0139 states that resolution = 'swap' credits nothing
-- and consumes no entitlement, and flag_lead_dead_if_unanimous filters on it.
-- A customer swap DOES consume one — the entitlement is the only thing bounding
-- how many they take, where an admin swap is bounded by a person. Reusing the
-- value would make 0139's documented invariant false for half its rows.
-- ---------------------------------------------------------------------------

alter table public.lead_quality_claims
  drop constraint if exists lead_quality_claims_resolution_check;

alter table public.lead_quality_claims
  add constraint lead_quality_claims_resolution_check
  check (resolution in ('none', 'credit', 'swap', 'self_swap'));

-- ---------------------------------------------------------------------------
-- 3 — flag_lead_dead_if_unanimous counts self_swap too
--
-- 0139's body verbatim, with the one filter widened. A self-swapped assignment
-- is deleted exactly as an admin-swapped one is, so it is missing from v_total
-- and invisible to the join for exactly the same reason.
-- ---------------------------------------------------------------------------

create or replace function public.flag_lead_dead_if_unanimous(p_lead_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total   integer;
  v_dead    integer;
  v_swapped integer;
  v_flag    text;
begin
  select count(*) into v_total
    from public.lead_assignments where lead_id = p_lead_id;

  select count(*) into v_dead
    from public.lead_assignments la
    join public.lead_quality_claims c on c.lead_assignment_id = la.id
    where la.lead_id = p_lead_id
      and c.status in ('auto_upheld', 'upheld');

  -- Operators whose assignment was swapped away. Their claim survives with a
  -- null pointer, so the join above cannot see it and the deleted assignment
  -- is missing from v_total too — hence both sides.
  select count(*) into v_swapped
    from public.lead_quality_claims c
    where c.lead_id = p_lead_id
      and c.resolution in ('swap', 'self_swap')
      and c.status in ('auto_upheld', 'upheld')
      and c.lead_assignment_id is null;

  v_total := v_total + v_swapped;
  v_dead  := v_dead + v_swapped;

  if v_total = 0 or v_dead = 0 then
    return null;
  end if;

  v_flag := case when v_dead >= v_total then 'dead' else 'suspect' end;
  update public.leads set quality_flag = v_flag where id = p_lead_id;
  return v_flag;
end;
$$;

-- §11: a create or replace DISCARDS the ACL, so it is re-asserted every time.
revoke execute on function public.flag_lead_dead_if_unanimous(uuid)
  from public, anon, authenticated;
grant execute on function public.flag_lead_dead_if_unanimous(uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- 4 — get_customer_replacement_candidates
--
-- The customer-facing twin of get_swap_candidates_for_assignment (0109), with
-- four deliberate differences.
--
-- ⚠️ REDACTED. No lead_name, no full postcode, no contact column. The admin
-- picker returns the landlord's name because an admin is entitled to it; a
-- customer browsing that list could harvest unsold stock and never swap. What
-- is left is what you need to choose between two properties.
--
-- ⚠️ p_limit IS CAPPED IN SQL and no total count is returned anywhere. Even
-- redacted, this is a readout of unsold stock by area, size, value and age —
-- 0140 dropped a whole function for exposing unsold_leads_now to anon, and a
-- signed-in operator is a nearer competitor than anon. The cap and the absent
-- count are what keep this to "what can I have instead of this one".
--
-- ⚠️ EXCLUSION IS not lead_retired_from_allocation(), NOT A HAND-WRITTEN
-- QUALITY CLAUSE. Invariant 11 names that function as the single expression of
-- what retires a lead, and writing one arm of it by hand is the fifth-copy trap
-- §34 and §35 exist to avoid. It also closes a latent hole 0109 has: the admin
-- picker will happily offer an expired-pool lead as a replacement today.
--
-- matches_filter is kept and ranked first rather than excluded. Measured on
-- production: of the five customers with an active filter and something
-- eligible to replace, three had ZERO matching replacements and one had one.
-- Excluding mismatches would show them an empty picker. §34 settled the same
-- argument for admins — a narrow filter may have nothing in stock, and a hard
-- refusal leaves no way to make them whole. The difference is whose filter it
-- is: the customer is the right person to consent to departing from their own.
-- ---------------------------------------------------------------------------

create or replace function public.get_customer_replacement_candidates(
  p_assignment_id uuid,
  p_customer_id   uuid,
  p_limit         integer default 20
)
returns table (
  id                  uuid,
  postcode_area       text,
  bedrooms            text,
  gross_annual_income numeric,
  created_at          timestamptz,
  matches_filter      boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with a as (
    select la.customer_id, la.lead_id, l.lead_type, l.gross_annual_income as gross
    from public.lead_assignments la
    join public.leads l on l.id = la.lead_id
    -- Scoped to the caller, so another customer's assignment id returns zero
    -- rows rather than their stock.
    where la.id = p_assignment_id
      and la.customer_id = p_customer_id
  )
  select
    l.id,
    l.postcode_area,
    l.bedrooms,
    l.gross_annual_income,
    l.created_at,
    coalesce(
      public.lead_matches_customer_filter(l.id, a.customer_id, l.lead_type),
      false
    ) as matches_filter
  from public.leads l, a
  where l.lead_type = a.lead_type
    and l.id <> a.lead_id
    and l.owner_customer_id is null
    and l.withdrawn_at is null
    and l.assignment_count < l.max_assignments
    and not public.lead_retired_from_allocation(l.id)
    and not exists (
      select 1 from public.lead_assignments la2
      where la2.lead_id = l.id and la2.customer_id = a.customer_id
    )
  -- Matching first, then closest in gross income.
  --
  -- ⚠️ A RELATIVE difference, not an absolute one, so a high-value area does
  -- not dominate the ordering. When the outgoing lead has no gross figure the
  -- expression is null for EVERY row, nulls last is a no-op and created_at
  -- takes over — which is the fallback wanted, and is the guaranteed-rent case:
  -- not one of 258 GR leads in stock carries a gross figure, because §25's
  -- analysis is management-only.
  order by
    matches_filter desc,
    (case when a.gross is null or a.gross = 0 then null
          else abs(l.gross_annual_income - a.gross) / a.gross end) nulls last,
    l.created_at desc
  limit least(coalesce(p_limit, 20), 20);
$$;

revoke execute on function public.get_customer_replacement_candidates(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.get_customer_replacement_candidates(uuid, uuid, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- 5 — customer_swap_dead_lead
--
-- Report a lead as already gone AND take a replacement, in one transaction,
-- with no person in the loop. The customer-initiated twin of
-- resolve_dead_lead_claim_with_swap (0139).
--
-- ⚠️ NO `select ... from customers for update` HERE, AND THAT IS THE WHOLE
-- POINT OF THE ORDERING. admin_swap_lead_assignment (0109) takes its row locks
-- in the order assignment -> old lead -> new lead -> CUSTOMER, customer LAST,
-- and that is what keeps every existing swap path deadlock-free among
-- themselves: nothing holds customers and then reaches for a lead. Pre-locking
-- the customer row here would make this the first function that does, and gives
-- a genuine ABBA cycle against a concurrent resolve_dead_lead_claim_with_swap
-- on the same customer — an admin working /admin/quality while the customer
-- clicks the tab. Instead the entitlement is spent as a COMPARE-AND-SWAP after
-- the swap returns, by which point admin_swap_lead_assignment is already
-- holding the customer row and will hold it until commit.
--
-- ⚠️ THE COMPARE-AND-SWAP TESTS THE STREAK AS WELL AS THE COUNTER.
-- claimBudget() derives the entitlement from clean_leads_streak, which this
-- function zeroes. Testing the counter alone would admit a second concurrent
-- swap on an entitlement the first had just destroyed. Moot while the streak is
-- never incremented (see §53's note) and wrong the day that is fixed.
--
-- ⚠️ A SWAP MOVES NO MONEY. No balance, no monthly counter rollback, no
-- odometer. The customer keeps the slot they already paid for at the same
-- price_paid and a different lead goes into it. Only the entitlement is spent.
-- ---------------------------------------------------------------------------

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

  -- Spend the entitlement. Conditional, so two concurrent swaps cannot both
  -- pass, and a refusal rolls the whole swap back with it.
  update public.customers
    set quality_claims_this_cycle = quality_claims_this_cycle + 1,
        clean_leads_streak        = 0,
        updated_at                = now()
    where id = p_customer_id
      and quality_claims_this_cycle = p_claims_seen
      and clean_leads_streak        = p_streak_seen
      and quality_claims_this_cycle < p_entitlement;

  if not found then
    raise exception 'no_entitlement';
  end if;

  claim_id                  := v_claim_id;
  replacement_assignment_id := v_new_id;
  original_lead_id          := v_lead_id;
  return next;
end;
$$;

revoke execute on function public.customer_swap_dead_lead(
  uuid, uuid, uuid, text, text, date, integer, integer, integer, boolean, integer)
  from public, anon, authenticated;
grant execute on function public.customer_swap_dead_lead(
  uuid, uuid, uuid, text, text, date, integer, integer, integer, boolean, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- 6 — reset_monthly_counts: the claim counter gets its own anchor
--
-- 0137's body carried forward verbatim, with quality_claims_this_cycle MOVED
-- out of the management branch into a third statement of its own.
--
-- ⚠️ A GR-ONLY CUSTOMER'S COUNTER WAS NEVER STUCK — the management branch
-- coalesces a missing billing_cycle_anchor to created_at, so it did reset, on
-- their signup day of the month. The defect is precision: their budget window
-- was anchored to when they signed up while their money bills on
-- gr_billing_cycle_anchor. Publishing the number (§53) makes that visible, so
-- it is worth being right.
--
-- ⚠️ ADDING quality_claims_this_cycle TO THE GR BRANCH INSTEAD WOULD DOUBLE A
-- DUAL-PRODUCT CUSTOMER'S BUDGET — two resets a month, one per anchor. One
-- budget spans both products (§51.3), so it needs ONE anchor: the management
-- one where they hold management, the GR one otherwise. Hence a third
-- statement rather than an edit to either existing one, which also leaves the
-- two per-product counters resetting exactly as they always have.
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
end;
$$;

revoke execute on function public.reset_monthly_counts() from public, anon, authenticated;
grant execute on function public.reset_monthly_counts() to service_role;

-- ---------------------------------------------------------------------------
-- 7 — get_service_capacity: replacement demand enters the ceiling
--
-- ⚠️ A DROP AND CREATE, NOT A create-or-replace. The signature gains columns
-- and Postgres refuses a replace that changes RETURNS TABLE. 0071, 0072 and
-- 0084 all drop first for the same reason; 0124 got away with a replace because
-- it changed only the body. capture_service_capacity is plpgsql and records no
-- dependency, so the drop succeeds.
--
-- ⚠️ THE DROP DISCARDS THE ACL (§11). Both statements below are mandatory, and
-- the anon grant must NOT come back — 0140 dropped a whole function for
-- exposing exactly these figures to anon.
--
-- Body is 0124's, verified byte-for-byte against production's live prosrc
-- (md5 4bdfe7b81c0b763c20ee10c756826006) before being carried forward, with
-- four mechanical changes:
--
--   * each branch of the `served` CTE gains quality_allowance_pct, and two
--     aggregates beside the existing ones. ⚠️ BOTH BRANCHES OR THE FIGURE IS
--     HALF RIGHT — that CTE is two hand-written `union all` selects rather than
--     a group by, and the GR branch carries no column aliases, so a column
--     added to one must go in the SAME POSITION in the other.
--   * ⚠️ ROUNDED ONCE, AT THE END. Per-branch rounding turns
--     round(10 x 0.1) = 1 into round(5 x 0.1) + round(5 x 0.1) = 2 for a
--     customer holding both products.
--   * the three ceiling expressions move onto the swap-inflated divisor.
--     ⚠️ ALL THREE, INCLUDING sustainable_customers_new_only. §18.1 says the
--     gap between the headline and the new-leads-only figure "is exactly how
--     much headroom depends on customers continuing to ignore leads". That is
--     only true while the NUMERATOR is the sole difference between them.
--     Inflating one divisor and not the other would make that sentence false by
--     conflating a supply change with a demand change.
--   * sustainable_customers_before_swaps keeps the OLD divisor, so the pair
--     before_swaps -> sustainable isolates the replacement drain exactly as
--     sustainable -> new_only isolates the recycling dependency.
--
-- ⚠️ IT IS NAMED quality_claim_demand_per_month, NOT swap_demand, and the name
-- is the honest one. It counts CLAIMS, of which only some become swaps — the
-- rest auto-uphold as credits and spend no stock — and it ignores the SECOND
-- lead every swap destroys through 0109's max_assignments = assignment_count
-- clamp. It is an upper bound on claims and a lower bound on slot cost. Do not
-- present it as a measured swap rate.
--
-- One known disagreement, recorded rather than reconciled: these branches gate
-- on account_status / paused_at where claimBudget() gates on holdsProduct, so
-- the SQL figure and the TypeScript entitlement differ for some customers. That
-- is tolerable in a reporting figure. Do not "fix" one to match the other — the
-- gates here are allocation gates and moving them changes who gets leads.
-- ---------------------------------------------------------------------------

drop function if exists public.get_service_capacity();

create or replace function public.get_service_capacity()
returns table (lead_type lead_type, leads_per_month numeric, slots_per_month numeric, recycled_slots_per_month numeric, serviceable_slots_per_month numeric, recycling_basis text, recycled_slots_now integer, unworked_rate numeric, recycling_sample integer, inventory_slots_now integer, unsold_leads_now integer, demand_per_month integer, delivered_per_month numeric, active_customers integer, fully_served integer, avg_allocation numeric, sustainable_customers integer, sustainable_customers_new_only integer, room_for_customers integer, paused_customers integer, paused_demand integer, quality_claim_demand_per_month integer, avg_allocation_with_swaps numeric, sustainable_customers_before_swaps integer)
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
      ps.n as paused_n, ps.demand as paused_demand
    from supply s
    join delivered d  on d.lead_type = s.lead_type
    join served sv    on sv.lead_type = s.lead_type
    join paused_side ps on ps.lead_type = s.lead_type
    join inventory i  on i.lead_type = s.lead_type
    join recycling r  on r.lead_type = s.lead_type
    join observed o   on o.lead_type = s.lead_type
    join passable p   on p.lead_type = s.lead_type
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
         else 0 end
  from scored s;
$function$;

revoke execute on function public.get_service_capacity() from public, anon, authenticated;
grant execute on function public.get_service_capacity() to service_role;

-- ---------------------------------------------------------------------------
-- 8 — The snapshot series follows the function
--
-- ⚠️ NULLABLE AND NOT BACKFILLED, which is 0084's rule for paused_customers and
-- its reason: every earlier row was computed on the old definition, and a zero
-- would read as "nobody was claiming" rather than "we were not measuring".
-- §18.2 adds that these rows CANNOT be recomputed — get_service_capacity reads
-- live state, so a missed day is gone. The series has a definition change at
-- this date; a step there is not a business event.
-- ---------------------------------------------------------------------------

alter table public.service_capacity_snapshots
  add column if not exists quality_claim_demand_per_month     integer,
  add column if not exists avg_allocation_with_swaps          numeric,
  add column if not exists sustainable_customers_before_swaps integer;

-- 0084's body carried forward with the three names added to ALL THREE lists.
--
-- ⚠️ THE `on conflict ... do update` LIST IS THE ONE THAT GETS FORGOTTEN, and
-- forgetting it fails silently: the day's FIRST capture writes the new columns
-- and every same-day re-run leaves them stale, with no error. The escalation
-- cron does re-run.

create or replace function public.capture_service_capacity()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
begin
  insert into public.service_capacity_snapshots (
    captured_on, lead_type, leads_per_month, slots_per_month,
    recycled_slots_per_month, serviceable_slots_per_month, recycling_basis,
    recycled_slots_now, unworked_rate, recycling_sample,
    inventory_slots_now, unsold_leads_now, demand_per_month, delivered_per_month,
    active_customers, fully_served, avg_allocation,
    sustainable_customers, sustainable_customers_new_only, room_for_customers,
    paused_customers, paused_demand,
    quality_claim_demand_per_month, avg_allocation_with_swaps,
    sustainable_customers_before_swaps
  )
  select
    current_date, c.lead_type, c.leads_per_month, c.slots_per_month,
    c.recycled_slots_per_month, c.serviceable_slots_per_month, c.recycling_basis,
    c.recycled_slots_now, c.unworked_rate, c.recycling_sample,
    c.inventory_slots_now, c.unsold_leads_now, c.demand_per_month,
    c.delivered_per_month, c.active_customers, c.fully_served, c.avg_allocation,
    c.sustainable_customers, c.sustainable_customers_new_only, c.room_for_customers,
    c.paused_customers, c.paused_demand,
    c.quality_claim_demand_per_month, c.avg_allocation_with_swaps,
    c.sustainable_customers_before_swaps
  from public.get_service_capacity() c
  on conflict (lead_type, captured_on) do update set
    leads_per_month       = excluded.leads_per_month,
    slots_per_month       = excluded.slots_per_month,
    recycled_slots_per_month = excluded.recycled_slots_per_month,
    serviceable_slots_per_month = excluded.serviceable_slots_per_month,
    recycling_basis       = excluded.recycling_basis,
    recycled_slots_now    = excluded.recycled_slots_now,
    unworked_rate         = excluded.unworked_rate,
    recycling_sample      = excluded.recycling_sample,
    inventory_slots_now   = excluded.inventory_slots_now,
    unsold_leads_now      = excluded.unsold_leads_now,
    demand_per_month      = excluded.demand_per_month,
    delivered_per_month   = excluded.delivered_per_month,
    active_customers      = excluded.active_customers,
    fully_served          = excluded.fully_served,
    avg_allocation        = excluded.avg_allocation,
    sustainable_customers = excluded.sustainable_customers,
    sustainable_customers_new_only = excluded.sustainable_customers_new_only,
    room_for_customers    = excluded.room_for_customers,
    paused_customers      = excluded.paused_customers,
    paused_demand         = excluded.paused_demand,
    quality_claim_demand_per_month = excluded.quality_claim_demand_per_month,
    avg_allocation_with_swaps      = excluded.avg_allocation_with_swaps,
    sustainable_customers_before_swaps = excluded.sustainable_customers_before_swaps;
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

revoke execute on function public.capture_service_capacity()
  from public, anon, authenticated;
grant execute on function public.capture_service_capacity() to service_role;
