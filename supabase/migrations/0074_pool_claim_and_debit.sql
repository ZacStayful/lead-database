-- ============================================================================
-- 0074 — Claiming from the expired leads pool, and the debit that pays for it.
--
-- Three things, all of them the money path:
--   * claim_pool_lead() — first-claim-wins, atomic, mirrors
--     assign_lead_to_customer but bypasses the assignment cap and can spend a
--     credit the customer does not have
--   * credit_invoice() — the next renewal settles that debt before crediting
--   * pacing — expected leads are measured against allocation MINUS debit, in
--     the SQL and (in the same commit) in src/lib/pacing.ts
--
-- ---------------------------------------------------------------------------
-- §1 — WHY A DEBIT AND NOT A NEGATIVE BALANCE
-- ---------------------------------------------------------------------------
-- Invariant 1: lead_balance is the allocation gate and must never go negative.
-- Every routing query tests `lead_balance > 0`, so a negative balance would not
-- merely be untidy — it would read as "no credit" for as long as it took to
-- clear, which is the same state as a lapsed customer, and the customer would
-- silently drop out of ordinary allocation as a side effect of using a feature
-- we invited them to use.
--
-- The debit is a separate, additive column. Balance stays at zero, the customer
-- keeps their place in routing, and the debt is settled against the next grant.
--
-- ---------------------------------------------------------------------------
-- §2 — WHY THE DEBIT IS SETTLED INSIDE credit_invoice()
-- ---------------------------------------------------------------------------
-- The obvious implementation is to compute `allocation - debit` in the webhook
-- and pass the reduced figure in. That is wrong, and quietly so.
--
-- credit_invoice() is idempotent by INSERT: it claims the invoice with a
-- payments row and returns false on unique_violation, so a redelivered Stripe
-- event credits nothing. But a debit decrement written in TypeScript alongside
-- it has no such guard. On the second delivery the credit is correctly skipped
-- and the debit is decremented AGAIN — wiping a debt the customer never paid,
-- silently, with the only evidence being a number that looks plausible.
--
-- Stripe redelivers. So the settlement lives inside the same function, behind
-- the same claim, in the same transaction. The webhook keeps passing the PLAN
-- allocation and stays ignorant of the debit entirely.
--
-- ---------------------------------------------------------------------------
-- §3 — TOP-UPS ARE DELIBERATELY EXEMPT
-- ---------------------------------------------------------------------------
-- Top-ups credit through record_lead_topup_success (0041), not this function,
-- so they are untouched by the debit and that is the intended behaviour. A
-- top-up is leads the customer has separately chosen to buy on top of their
-- plan; taking them to pay off a pool claim would mean charging for leads and
-- delivering none, which is the one thing a top-up must never do.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1 — Does this lead match the customer's filter for this product?
--
-- Mirrors get_filtered_candidates_for_lead (0073) exactly, because the decision
-- is that a customer's pool shows what their allocation would show. Two
-- consequences carried over deliberately rather than softened:
--
--   * 'pending_lift' still counts as filtered. A customer mid-lift is filtered
--     until the lift executes at their next renewal.
--   * A lead whose postcode area or bedroom count could not be parsed matches
--     NO filtered customer, exactly as in allocation. It is still visible to
--     every unfiltered customer, so it is not stranded.
--
-- filter_status = 'off' returns true: no filter is not an empty filter.
-- ---------------------------------------------------------------------------
create or replace function public.lead_matches_customer_filter(
  p_lead_id     uuid,
  p_customer_id uuid,
  p_lead_type   public.lead_type
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with l as (
    select
      postcode_area as area,
      nullif(substring(coalesce(bedrooms, '') from '\d+'), '')::int as bed
    from public.leads where id = p_lead_id
  )
  select case
    when p_lead_type = 'guaranteed_rent' then
      case
        when c.gr_filter_status not in ('active', 'pending_lift') then true
        else l.area is not null
         and l.bed is not null
         and (
           c.gr_filter_areas is null
           or array_length(c.gr_filter_areas, 1) is null
           or l.area = any (c.gr_filter_areas)
         )
         and (c.gr_filter_min_bedrooms is null or l.bed >= c.gr_filter_min_bedrooms)
         and (c.gr_filter_max_bedrooms is null or l.bed <= c.gr_filter_max_bedrooms)
      end
    else
      case
        when c.filter_status not in ('active', 'pending_lift') then true
        else l.area is not null
         and l.bed is not null
         and (
           c.filter_areas is null
           or array_length(c.filter_areas, 1) is null
           or l.area = any (c.filter_areas)
         )
         and (c.filter_min_bedrooms is null or l.bed >= c.filter_min_bedrooms)
         and (c.filter_max_bedrooms is null or l.bed <= c.filter_max_bedrooms)
      end
  end
  from public.customers c, l
  where c.id = p_customer_id;
$$;


-- ---------------------------------------------------------------------------
-- 2 — Can this customer see this lead in their pool?
--
-- One definition, used by the claim (below) and by the pool listing in phase 3,
-- so the list and the claim can never disagree about what is on offer — the
-- arrangement §5E describes for reject.
--
-- Four rules, per the brief:
--   * the lead is currently in the pool and has not expired
--   * the customer holds an active subscription FOR THAT PRODUCT. Management
--     reads subscription_status, GR reads gr_subscription_status. A GR-only
--     subscriber has account_status = 'waitlisted' (§18A) so reading that
--     column here would hide the pool from every GR customer there is.
--   * the customer was never assigned this lead. They have already had their
--     look at it; the pool is not a second bite for the operator who ignored it.
--   * it matches their filter.
--
-- Paused management customers are excluded. Delivery is stopped at their own
-- request, and a pool they can browse but whose leads they should not be taking
-- is a worse experience than an honest empty one.
-- ---------------------------------------------------------------------------
create or replace function public.customer_can_see_pool_lead(
  p_lead_id     uuid,
  p_customer_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.leads l, public.customers c
    where l.id = p_lead_id
      and c.id = p_customer_id
      and l.pool_entered_at is not null
      and l.pool_expired_at is null
      and c.is_active = true
      and (
        (l.lead_type = 'management'
          and c.subscription_status = 'active'
          and c.paused_at is null)
        or
        (l.lead_type = 'guaranteed_rent'
          and c.gr_subscription_status = 'active')
      )
      and not exists (
        select 1 from public.lead_assignments la
        where la.lead_id = p_lead_id and la.customer_id = p_customer_id
      )
      and public.lead_matches_customer_filter(p_lead_id, p_customer_id, l.lead_type)
  );
$$;


-- ---------------------------------------------------------------------------
-- 3 — Claim a lead out of the pool.
--
-- Mirrors assign_lead_to_customer's shape — lock lead, lock customer, validate,
-- insert, bump counters — and differs in exactly three ways, each deliberate:
--
--   (a) NO CAPACITY CHECK. Claiming bypasses max_assignments entirely, so
--       assignment_count may exceed it on a claimed lead. Nothing enforces the
--       cap as a constraint (verified: no CHECK, no trigger), and the two
--       reporting queries that subtract the two clamp with greatest(...,0), so
--       an over-cap lead is safe. Admin will render "4 / 3 assigned", which is
--       odd-looking and truthful — the same wart reclaim already produces.
--
--   (b) BALANCE OR DEBIT. A claim at zero balance succeeds and increments the
--       debit instead (§1). This is the only path in the schema that delivers a
--       lead without a credit behind it.
--
--   (c) IT RETURNS A STATUS INSTEAD OF RAISING. Losing a race is an ordinary
--       outcome, not an error: two operators calling the same landlord and one
--       of them claiming first is the mechanism working. The loser gets
--       'already_claimed' and a UI that can say so calmly. Genuine faults —
--       a missing lead, a lead of the wrong product — still raise.
--
-- FIRST CLAIM WINS, and the lock is what makes it true. Both callers take
-- `for update` on the lead row. The winner clears pool_entered_at and commits;
-- the loser's lock then returns the UPDATED row, sees the pool tenancy gone and
-- a claimed assignment present, and reports already_claimed. There is no window
-- in which both succeed, because there is no point at which the check and the
-- clear are separated.
--
-- Lead is locked BEFORE customer, matching assign_lead_to_customer's order, so
-- a claim and an ordinary assignment racing on the same pair cannot deadlock.
-- ---------------------------------------------------------------------------
create or replace function public.claim_pool_lead(
  p_lead_id     uuid,
  p_customer_id uuid,
  p_price       numeric,
  p_lead_type   public.lead_type default 'management'::lead_type
)
returns table (
  status        text,
  assignment_id uuid,
  spent_credit  boolean,
  debit_after   integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead       public.leads%rowtype;
  v_customer   public.customers%rowtype;
  v_new_id     uuid;
  v_spent      boolean := false;
  v_debit      integer := 0;
begin
  select * into v_lead from public.leads where id = p_lead_id for update;
  if not found then
    raise exception 'Lead % not found', p_lead_id;
  end if;

  if v_lead.lead_type <> p_lead_type then
    raise exception 'Lead % is a % lead, not %',
      p_lead_id, v_lead.lead_type, p_lead_type;
  end if;

  -- Somebody got there first. Checked before the pool state because it is the
  -- more specific and more useful answer: "already claimed" tells the operator
  -- what happened, where "no longer available" leaves them wondering.
  if exists (
    select 1 from public.lead_assignments la
    where la.lead_id = p_lead_id and la.claimed_from_pool_at is not null
  ) then
    return query select 'already_claimed'::text, null::uuid, false, 0;
    return;
  end if;

  -- Left the pool for some other reason between the page render and the click:
  -- the original holder engaged with it, it was allocated, or it expired.
  if v_lead.pool_entered_at is null or v_lead.pool_expired_at is not null then
    return query select 'not_available'::text, null::uuid, false, 0;
    return;
  end if;

  select * into v_customer from public.customers where id = p_customer_id for update;
  if not found then
    raise exception 'Customer % not found', p_customer_id;
  end if;

  -- Product, subscription, filter and not-previously-assigned, in one place
  -- shared with the listing. A customer reaching here having failed this has
  -- either lost their subscription mid-session or is calling the endpoint by
  -- hand; both get the same flat refusal.
  if not public.customer_can_see_pool_lead(p_lead_id, p_customer_id) then
    return query select 'not_visible'::text, null::uuid, false, 0;
    return;
  end if;

  insert into public.lead_assignments (lead_id, customer_id, price_paid, claimed_from_pool_at)
    values (p_lead_id, p_customer_id, p_price, now())
    returning id into v_new_id;

  -- No capacity check (a). Clearing the pool columns is what removes the lead
  -- from every OTHER subscriber's pool; retirement from ordinary allocation is
  -- carried from here on by claimed_from_pool_at, which
  -- lead_retired_from_allocation reads (0073).
  update public.leads
    set assignment_count  = assignment_count + 1,
        pool_entered_at   = null,
        pool_entry_basis  = null
    where id = p_lead_id;

  if p_lead_type = 'guaranteed_rent' then
    if v_customer.gr_lead_balance > 0 then
      v_spent := true;
      update public.customers
        set gr_lead_balance              = gr_lead_balance - 1,
            gr_leads_received_this_month = gr_leads_received_this_month + 1,
            gr_last_assignment_at        = now(),
            updated_at                   = now()
        where id = p_customer_id
        returning gr_pool_debit into v_debit;
    else
      update public.customers
        set gr_pool_debit                = gr_pool_debit + 1,
            gr_leads_received_this_month = gr_leads_received_this_month + 1,
            gr_last_assignment_at        = now(),
            updated_at                   = now()
        where id = p_customer_id
        returning gr_pool_debit into v_debit;
    end if;
  else
    if v_customer.lead_balance > 0 then
      v_spent := true;
      update public.customers
        set lead_balance                       = lead_balance - 1,
            leads_received_this_month          = leads_received_this_month + 1,
            management_lifetime_leads_received = management_lifetime_leads_received + 1,
            last_assignment_at                 = now(),
            updated_at                         = now()
        where id = p_customer_id
        returning pool_debit into v_debit;
    else
      update public.customers
        set pool_debit                         = pool_debit + 1,
            leads_received_this_month          = leads_received_this_month + 1,
            management_lifetime_leads_received = management_lifetime_leads_received + 1,
            last_assignment_at                 = now(),
            updated_at                         = now()
        where id = p_customer_id
        returning pool_debit into v_debit;
    end if;
  end if;

  return query select 'claimed'::text, v_new_id, v_spent, v_debit;
end;
$$;


-- ---------------------------------------------------------------------------
-- 4 — The renewal settles the debt before it credits.
--
-- SIGNATURE UNCHANGED, deliberately. p_amount is still "the leads this plan
-- buys"; the webhook keeps passing planForAllocation(...).leads and needs no
-- knowledge of the debit. Everything new happens behind the existing
-- idempotency claim (§2).
--
-- Worked example, 10-lead plan and 12 claims at zero balance:
--   renewal 1 — debit 12, grant 10 -> credits 0,  debit becomes 2
--   renewal 2 — debit 2,  grant 10 -> credits 8,  debit becomes 0
--   renewal 3 — debit 0,  grant 10 -> credits 10, debit unchanged
--
-- credits_added on the payments row records what was ACTUALLY credited, not
-- what the plan nominally buys. A £150 invoice with credits_added = 0 looks
-- strange in isolation and is the truth: those ten leads were delivered last
-- cycle. The alternative — recording 10 — would make the payments table
-- disagree with lead_balance, which is the one thing it exists to explain.
--
-- The customer row is locked before it is read, so a claim landing between the
-- read and the write cannot be swallowed. That lock is also why the settlement
-- has to be here and not in the webhook: there is no way to hold it across a
-- round trip to Node.
-- ---------------------------------------------------------------------------
create or replace function public.credit_invoice(
  p_customer_id uuid,
  p_amount integer,
  p_invoice_id text,
  p_payment_intent_id text,
  p_amount_pence integer,
  p_payment_type text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_gr    boolean := p_payment_type = 'gr_subscription';
  v_debit    integer := 0;
  v_granted  integer;
  v_remaining integer;
begin
  -- Lock first: the debit read below must not race a concurrent claim.
  if v_is_gr then
    select gr_pool_debit into v_debit from public.customers
      where id = p_customer_id for update;
  else
    select pool_debit into v_debit from public.customers
      where id = p_customer_id for update;
  end if;

  if not found then
    raise exception 'Customer % not found', p_customer_id;
  end if;

  v_debit     := coalesce(v_debit, 0);
  v_granted   := greatest(p_amount - v_debit, 0);
  v_remaining := greatest(v_debit - p_amount, 0);

  -- Claim the invoice by inserting its 'paid' payment row. A duplicate means we
  -- already credited it on an earlier delivery of this event — bail without
  -- touching the balance OR the debit.
  begin
    insert into public.payments (
      customer_id, stripe_invoice_id, stripe_payment_intent_id,
      amount_pence, credits_added, payment_type, status
    ) values (
      p_customer_id, p_invoice_id, p_payment_intent_id,
      p_amount_pence, v_granted, p_payment_type, 'paid'
    );
  exception when unique_violation then
    return false;
  end;

  if v_is_gr then
    update public.customers
      set gr_lead_balance = gr_lead_balance + v_granted,
          gr_pool_debit   = v_remaining,
          updated_at      = now()
      where id = p_customer_id;
  else
    update public.customers
      set lead_balance = lead_balance + v_granted,
          pool_debit   = v_remaining,
          updated_at   = now()
      where id = p_customer_id;
  end if;

  return true;
end;
$$;


-- ---------------------------------------------------------------------------
-- 5 — Pacing counts what the customer is actually owed this cycle.
--
-- A customer on 20 a month who claimed 3 from the pool last cycle is owed 17
-- this cycle, and has already had the other 3. Without this they show a deficit
-- of 3 for the whole month: the dashboard tells them they are behind, the admin
-- supply-problem banner names them as a shortfall, and — worst — deficit-first
-- routing pushes leads at them ahead of customers who genuinely are short.
--
-- Floored at zero. A debit larger than the allocation means the customer has
-- already drawn more than this cycle owes them; expected is 0, not negative,
-- because a negative expectation would rank them BELOW customers who are
-- exactly level, which is a punishment nobody designed.
--
-- src/lib/pacing.ts changes in the same commit. The two duplicate each other by
-- design (CLAUDE.md) and a change to one without the other puts the customer's
-- dashboard and the routing order into disagreement.
-- ---------------------------------------------------------------------------
create or replace function public.effective_allocation(
  p_allocation integer,
  p_debit      integer
)
returns integer
language sql
immutable
as $$
  select greatest(coalesce(p_allocation, 0) - coalesce(p_debit, 0), 0);
$$;

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
  where not public.lead_retired_from_allocation(p_lead_id)
    and c.is_active = true
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
          * public.effective_allocation(c.gr_monthly_allocation, c.gr_pool_debit)
        ) - c.gr_leads_received_this_month
      else
        round(
          (least(greatest(
            extract(day from now() - coalesce(c.billing_cycle_anchor, c.created_at::date)),
            0), 30) / 30.0)
          * public.effective_allocation(c.monthly_allocation, c.pool_debit)
        ) - c.leads_received_this_month
    end desc,
    case
      when p_lead_type = 'guaranteed_rent' then c.gr_last_assignment_at
      else c.last_assignment_at
    end asc nulls first,
    c.created_at asc
  limit p_max;
$$;

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


-- ---------------------------------------------------------------------------
-- 6 — Discarding a claimed lead must not reopen a slot.
--
-- Discard deletes the assignment row and decrements assignment_count, which is
-- right for an ordinary assignment: the lead goes back to the pool of stock and
-- routing re-places it.
--
-- A claimed lead is not stock. Decrementing would put the lead back under its
-- cap while the claim marker died with the deleted row, so ordinary routing
-- would re-sell a lead the pool had already retired — invariant 7 breached by
-- the one path that removes the evidence of the breach.
--
-- The claim is also not refunded (invariant 4, and the brief). Discard has
-- never touched a balance, so there is nothing to suppress: the credit stays
-- spent and the debit stays owed. The customer simply no longer has the row.
--
-- Definition otherwise verbatim from 0010.
-- ---------------------------------------------------------------------------
create or replace function public.discard_lead_assignment(
  p_lead_assignment_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead_id uuid;
  v_status  text;
  v_notes   integer;
  v_claimed timestamptz;
begin
  select lead_id, status, claimed_from_pool_at
    into v_lead_id, v_status, v_claimed
    from public.lead_assignments
    where id = p_lead_assignment_id
    for update;

  if not found then
    raise exception 'Assignment % not found', p_lead_assignment_id;
  end if;

  if v_status <> 'new' then
    raise exception 'Assignment % is not discardable (status = %)',
      p_lead_assignment_id, v_status;
  end if;

  select count(*) into v_notes
    from public.lead_notes
    where lead_assignment_id = p_lead_assignment_id;

  if v_notes > 0 then
    raise exception 'Assignment % has notes and cannot be discarded',
      p_lead_assignment_id;
  end if;

  delete from public.lead_assignments where id = p_lead_assignment_id;

  -- Only an ordinary assignment returns its slot.
  if v_claimed is null then
    update public.leads
      set assignment_count = greatest(assignment_count - 1, 0)
      where id = v_lead_id;
  else
    -- The lead stays retired. pool_expired_at is what carries that now the
    -- claim marker has gone with the row: it bars re-entry to the pool
    -- (lead_pool_barred) and retires it from allocation
    -- (lead_retired_from_allocation) in one column.
    update public.leads
      set pool_expired_at = coalesce(pool_expired_at, now())
      where id = v_lead_id;
  end if;
end;
$$;


-- ---------------------------------------------------------------------------
-- 7 — Grants. A create-or-replace discards the ACL (0028/0049), so every
-- function re-created above re-asserts its own.
-- ---------------------------------------------------------------------------
revoke execute on function public.lead_matches_customer_filter(uuid, uuid, public.lead_type)
  from public, anon, authenticated;
grant execute on function public.lead_matches_customer_filter(uuid, uuid, public.lead_type)
  to service_role;

revoke execute on function public.customer_can_see_pool_lead(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.customer_can_see_pool_lead(uuid, uuid)
  to service_role;

revoke execute on function public.claim_pool_lead(uuid, uuid, numeric, public.lead_type)
  from public, anon, authenticated;
grant execute on function public.claim_pool_lead(uuid, uuid, numeric, public.lead_type)
  to service_role;

revoke execute on function public.credit_invoice(uuid, integer, text, text, integer, text)
  from public, anon, authenticated;
grant execute on function public.credit_invoice(uuid, integer, text, text, integer, text)
  to service_role;

revoke execute on function public.get_next_customers_for_lead(uuid, integer, uuid[], public.lead_type)
  from public, anon, authenticated;
grant execute on function public.get_next_customers_for_lead(uuid, integer, uuid[], public.lead_type)
  to service_role;

revoke execute on function public.get_unfiltered_candidates_for_lead(uuid, integer, public.lead_type)
  from public, anon, authenticated;
grant execute on function public.get_unfiltered_candidates_for_lead(uuid, integer, public.lead_type)
  to service_role;

revoke execute on function public.get_filtered_candidates_for_lead(uuid, integer, public.lead_type)
  from public, anon, authenticated;
grant execute on function public.get_filtered_candidates_for_lead(uuid, integer, public.lead_type)
  to service_role;

revoke execute on function public.discard_lead_assignment(uuid)
  from public, anon, authenticated;
grant execute on function public.discard_lead_assignment(uuid) to service_role;

revoke execute on function public.effective_allocation(integer, integer)
  from public, anon;
