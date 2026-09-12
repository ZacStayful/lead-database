-- ==========================================================================
-- 0145 — WHAT A SWAP DESTROYS, RECORDED AND REPORTED
-- ==========================================================================
--
-- §53's Deferred list carried this: "The withdrawal cost is not modelled. Each
-- swap also destroys the reported lead's remaining free slots, which lands in
-- `inventory_slots_now` rather than `slots_per_month`, so the ceiling still
-- understates the cost by the withdrawn half."
--
-- ⚠️ MEASURING IT FIRST CORRECTED BOTH HALVES OF THAT SENTENCE, and the
-- correction is what this migration is shaped by. See §53.11.
--
-- ---------------------------------------------------------------------------
-- §1 — WHERE THE COST ACTUALLY LANDS, AND WHY THE CEILING IS NOT UNDERSTATING
-- ---------------------------------------------------------------------------
-- `slots_per_month` is `sum(l.max_assignments)` over leads created in the
-- 28-day window. `admin_swap_lead_assignment` CLAMPS that column down to
-- `assignment_count`, so a withdrawal inside the window lowers that sum the
-- instant it happens — retroactively, and correctly: the supply genuinely was
-- not there. Measured on the eight withdrawals production has ever had, SEVEN
-- were inside the window at the time (management averaged 18.6 days old).
--
-- So the ceiling does not under-state the cost in steady state. It LAGS: it
-- reflects the withdrawals of the last 28 days rather than the entitlement
-- every customer holds and has not yet spent. With zero claims to date and 26
-- replacements a month available across the book, that lag is the whole
-- exposure, and it is invisible.
--
-- ⚠️ IT FOLLOWS THAT THE FIGURE THIS ADDS MUST NEVER BE ADDED TO THE CEILING
-- OR FOLDED INTO `avg_allocation_with_swaps`. Once swaps are actually
-- happening, `slots_per_month` already carries the cost; charging it a second
-- time in the divisor would double-count it. §18.1's rule in its original
-- form — reported beside the headline, never inside it.
--
-- ---------------------------------------------------------------------------
-- §2 — ⚠️ THE SWAP DESTROYS THE EVIDENCE OF WHAT IT DESTROYED
-- ---------------------------------------------------------------------------
-- The clamp overwrites `max_assignments` in place, so after a swap nothing
-- anywhere records what the lead's cap had been. The cost is therefore not
-- merely unmodelled, it is UNMEASURABLE after the fact — which is why the
-- Deferred note had to reason about where it lands instead of looking.
--
-- `leads.withdrawn_slots` is written in the same statement that stamps
-- `withdrawn_at`, from the row already locked and read before either update.
-- Same denormalise-to-survive-the-write move 0138 makes for `postcode_area`
-- (discard deletes the assignment), 0139 for `origin_assignment_id` (the swap
-- nulls the pointer) and 0116 for `lead_messages`.
--
-- ⚠️ IT IS DEFINED AS THE DROP IN `slots_per_month`, not as "free slots lost",
-- and the two differ. Before: the lead contributes `max_assignments`. After the
-- decrement and the clamp: `assignment_count - 1`. So the drop is
-- `max_assignments - greatest(assignment_count - 1, 0)`, which counts the
-- reporting operator's own slot as well as the free ones — correctly, because
-- that slot leaves circulation too.
--
--   M=3 C=1 (one holder)    → 3   the whole lead
--   M=3 C=3 (all three)     → 1   the other two keep theirs
--   M=3 C=4 (a pool claim)  → 0   invariant 3 lets the count exceed the cap
--
-- The outer `greatest(…, 0)` is for that last shape and is not decoration.
--
-- ---------------------------------------------------------------------------
-- §3 — NO BACKFILL, BECAUSE IT CANNOT BE DONE
-- ---------------------------------------------------------------------------
-- The eight existing withdrawn leads keep a NULL. Their original caps are
-- gone; inventing a 3 would be a fabricated measurement in the one column whose
-- entire purpose is to be measured. The observed figure counts only rows this
-- migration's own writer produced, so it reads `estimated` until the first real
-- swap and self-clears within 28 days of one. Accrues forward, as §40.15 does
-- for `whatsapp_click` and §53.8 for `clean_leads_streak`.
-- ==========================================================================


-- ---------------------------------------------------------------------------
-- 1 — The column
-- ---------------------------------------------------------------------------
alter table public.leads
  add column if not exists withdrawn_slots integer;

alter table public.leads drop constraint if exists leads_withdrawn_slots_check;
alter table public.leads add constraint leads_withdrawn_slots_check
  check (withdrawn_slots is null or withdrawn_slots >= 0);

comment on column public.leads.withdrawn_slots is
  'Slots this lead stopped contributing to get_service_capacity.slots_per_month '
  'when a swap withdrew it: max_assignments - greatest(assignment_count - 1, 0), '
  'read before the decrement and the clamp. NULL means withdrawn before 0145 '
  'recorded it, which cannot be recovered — the clamp overwrote the cap.';

create index if not exists idx_leads_withdrawn_slots
  on public.leads (withdrawn_at desc)
  where withdrawn_slots is not null;


-- ---------------------------------------------------------------------------
-- 2 — The swap records what it costs
--
-- 0143's body verbatim with ONE column added to the existing withdraw UPDATE.
-- Nothing else moves: the retirement guard, the filter guard, the owner checks,
-- the lock order and the clamp are untouched.
-- ---------------------------------------------------------------------------
create or replace function public.admin_swap_lead_assignment(
  p_assignment_id           uuid,
  p_new_lead_id             uuid,
  p_allow_filter_mismatch   boolean
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old        public.lead_assignments%rowtype;
  v_old_lead   public.leads%rowtype;
  v_new_lead   public.leads%rowtype;
  v_customer   public.customers%rowtype;
  v_new_id     uuid;
begin
  select * into v_old from public.lead_assignments
    where id = p_assignment_id for update;
  if not found then
    raise exception 'Assignment % not found', p_assignment_id;
  end if;

  -- A won lead is a conversion record. Swapping it out would delete the only
  -- evidence the customer signed anybody, and every win figure counts
  -- status='won' (CLAUDE.md §6A).
  if v_old.status = 'won' then
    raise exception 'This lead is marked won and cannot be swapped out';
  end if;

  if v_old.lead_id = p_new_lead_id then
    raise exception 'The replacement is the same lead';
  end if;

  select * into v_old_lead from public.leads
    where id = v_old.lead_id for update;
  if not found then
    raise exception 'Lead % not found', v_old.lead_id;
  end if;

  select * into v_new_lead from public.leads
    where id = p_new_lead_id for update;
  if not found then
    raise exception 'Replacement lead % not found', p_new_lead_id;
  end if;

  -- Neither side of a swap may be a customer's own lead, and the two directions
  -- are refused for different reasons.
  --
  -- Swapping one OUT rewrites max_assignments to assignment_count further down,
  -- which would silently un-qualify a lead already sold to its one buyer and
  -- reopen the slot. Swapping one IN hands somebody else's private lead to a
  -- customer, which is the thing §32's cap exists to bound.
  if v_old_lead.owner_customer_id is not null then
    raise exception 'Lead % was added by a customer and cannot be swapped out',
      v_old.lead_id;
  end if;

  if v_new_lead.owner_customer_id is not null then
    raise exception 'Lead % was added by a customer and cannot be swapped in',
      p_new_lead_id;
  end if;

  -- 0143. Invariant 11's single expression of "may this lead be handed out",
  -- asserted here under the row lock exactly as assign_lead_to_customer
  -- asserts it.
  --
  -- ⚠️ IT HAS TO SIT BELOW THE `for update` ON v_new_lead. The predicate reads
  -- that lead's pool and quality columns, and holding its row lock is what
  -- stops the verdict changing between this test and the insert below — the
  -- same reason invariant 11 names assign_lead_to_customer's locked section as
  -- where it is asserted rather than anywhere earlier.
  --
  -- Below the OWNER check is a weaker claim and only about the MESSAGE: an
  -- unqualified owned lead satisfies both tests, and the owner one says
  -- something specific where this one says only "retired". A qualified owned
  -- lead is refused by the owner check either way, since 0108 took those out
  -- of this predicate — so the order is not what keeps §32.6 true.
  --
  -- coalesce for the same reason 0109 gives below: a null reads as retired,
  -- never as permission. Defensive rather than reachable — the helper is a
  -- `language sql` function returning `exists(...) or exists(...)`, which is
  -- never null.
  if coalesce(public.lead_retired_from_allocation(p_new_lead_id), true) then
    raise exception
      'Replacement lead % is retired from allocation and cannot be swapped in',
      p_new_lead_id;
  end if;

  select * into v_customer from public.customers
    where id = v_old.customer_id for update;
  if not found then
    raise exception 'Customer % not found', v_old.customer_id;
  end if;

  -- Clearer than letting the (lead_id, customer_id) unique index fire, for the
  -- same reason 0053 gave the assign functions an explicit guard.
  if exists (
    select 1 from public.lead_assignments
    where lead_id = p_new_lead_id and customer_id = v_old.customer_id
  ) then
    raise exception 'Customer already has the replacement lead';
  end if;

  -- The replacement must have room, the same as any other placement.
  if v_new_lead.assignment_count >= v_new_lead.max_assignments then
    raise exception 'Replacement lead is at max assignments (%/%)',
      v_new_lead.assignment_count, v_new_lead.max_assignments;
  end if;

  -- Pause is management-only and airtight: no path may place a management lead
  -- with a paused customer (mirrors 0039 and 0040).
  if v_new_lead.lead_type <> 'guaranteed_rent' and v_customer.paused_at is not null then
    raise exception 'Customer is paused and cannot receive management leads';
  end if;

  -- Products must match. Swapping a management lead for a guaranteed rent one
  -- would move a delivery between two independent balances and pipelines.
  if v_new_lead.lead_type is distinct from v_old_lead.lead_type then
    raise exception 'Replacement must be the same product as the lead being removed';
  end if;

  -- 0109. The customer chose which leads they want, and a replacement reaches
  -- them exactly as an allocated lead does. lead_matches_customer_filter is the
  -- same predicate the pool uses and returns true for an unfiltered customer,
  -- so this costs nothing for anyone who has not set a filter.
  --
  -- coalesce, not a bare NOT: a null must read as "does not match", never as
  -- permission. Both rows are locked and proven to exist above so it cannot be
  -- null in practice, but failing open is not the direction to fail in here.
  if not p_allow_filter_mismatch
     and not coalesce(
       public.lead_matches_customer_filter(
         p_new_lead_id, v_old.customer_id, v_new_lead.lead_type
       ), false)
  then
    raise exception
      'Replacement lead does not match this customer''s lead filter';
  end if;

  -- Remove. lead_notes and lead_files cascade with the assignment; the caller
  -- is responsible for warning about that before getting here.
  delete from public.lead_assignments where id = p_assignment_id;

  update public.leads
    set assignment_count = greatest(assignment_count - 1, 0),
        withdrawn_at     = now(),
        -- 0145. What this withdrawal costs supply, recorded HERE because the
        -- clamp two statements down overwrites max_assignments in place and
        -- the original cap is then gone for ever.
        --
        -- Read from v_old_lead, which is the row as it was BEFORE either
        -- update — captured by the `for update` above, so it is the locked
        -- pre-image and cannot have moved. Computing it after the decrement
        -- would read a count this statement had already changed.
        --
        -- It is the drop in slots_per_month: the lead contributed
        -- max_assignments and will contribute assignment_count - 1. The outer
        -- greatest() is for a pool-claimed lead, where invariant 3 lets the
        -- count exceed the cap and the true drop is zero.
        withdrawn_slots  = greatest(
          v_old_lead.max_assignments
            - greatest(v_old_lead.assignment_count - 1, 0), 0)
    where id = v_old_lead.id;

  -- The clamp. Read after the decrement so it lands on the true count.
  update public.leads
    set max_assignments = assignment_count
    where id = v_old_lead.id;

  -- Place the replacement at the SAME price. No credit is spent and no counter
  -- moves: this is the slot the customer already paid for.
  insert into public.lead_assignments (lead_id, customer_id, price_paid)
    values (p_new_lead_id, v_old.customer_id, v_old.price_paid)
    returning id into v_new_id;

  update public.leads
    set assignment_count = assignment_count + 1
    where id = p_new_lead_id;

  return v_new_id;
end;
$$;

revoke execute on function public.admin_swap_lead_assignment(uuid, uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.admin_swap_lead_assignment(uuid, uuid, boolean)
  to service_role;


-- ---------------------------------------------------------------------------
-- 3 — The capacity model reports it
--
-- ⚠️ DROP AND CREATE, because the return type gains columns and Postgres
-- refuses a `create or replace` that changes RETURNS TABLE. THE DROP DISCARDS
-- THE ACL (§11: 0028 revoked schema-wide, then 0038 dropped a function and
-- handed it back to anon), so the revoke and the grant below are load-bearing
-- — and ⚠️ THE `anon` GRANT MUST NOT COME BACK: 0140 dropped an entire
-- function for exposing exactly these figures to anon.
-- ---------------------------------------------------------------------------
drop function if exists public.get_service_capacity();

create or replace function public.get_service_capacity()
returns table (lead_type lead_type, leads_per_month numeric, slots_per_month numeric, recycled_slots_per_month numeric, serviceable_slots_per_month numeric, recycling_basis text, recycled_slots_now integer, unworked_rate numeric, recycling_sample integer, inventory_slots_now integer, unsold_leads_now integer, demand_per_month integer, delivered_per_month numeric, active_customers integer, fully_served integer, avg_allocation numeric, sustainable_customers integer, sustainable_customers_new_only integer, room_for_customers integer, paused_customers integer, paused_demand integer, quality_claim_demand_per_month integer, avg_allocation_with_swaps numeric, sustainable_customers_before_swaps integer, withdrawn_slots_per_month numeric, avg_withdrawal_cost numeric, withdrawal_basis text)
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
      wd.slots_lost, wd.n as withdrawn_n, wc.avg_cost as withdrawal_cost
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
    case when s.withdrawn_n > 0 then 'observed' else 'estimated' end
  from scored s;
$function$;

revoke execute on function public.get_service_capacity() from public, anon, authenticated;
grant execute on function public.get_service_capacity() to service_role;


-- ---------------------------------------------------------------------------
-- 4 — The daily series carries it too
--
-- Nullable and NOT backfilled (0084's rule, restated by §53.4): a zero on an
-- older row would read as "swaps destroyed nothing that day" rather than "we
-- were not measuring". §18.2 adds that these rows cannot be recomputed —
-- get_service_capacity reads live state, so a missed day is gone. The series
-- has a definition change at this date; a step there is not a business event.
-- ---------------------------------------------------------------------------
alter table public.service_capacity_snapshots
  add column if not exists withdrawn_slots_per_month integer,
  add column if not exists avg_withdrawal_cost       numeric,
  add column if not exists withdrawal_basis          text;

-- 0141's body carried forward with the three names added to ALL THREE lists.
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
    sustainable_customers_before_swaps,
    withdrawn_slots_per_month, avg_withdrawal_cost, withdrawal_basis
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
    c.sustainable_customers_before_swaps,
    -- ⚠️ The column is integer and the function returns numeric, so this
    -- rounds rather than truncating. A silent floor would make every daily
    -- snapshot read low against the live panel beside it.
    round(c.withdrawn_slots_per_month)::integer,
    c.avg_withdrawal_cost, c.withdrawal_basis
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
    sustainable_customers_before_swaps = excluded.sustainable_customers_before_swaps,
    withdrawn_slots_per_month = excluded.withdrawn_slots_per_month,
    avg_withdrawal_cost       = excluded.avg_withdrawal_cost,
    withdrawal_basis          = excluded.withdrawal_basis;
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

revoke execute on function public.capture_service_capacity()
  from public, anon, authenticated;
grant execute on function public.capture_service_capacity() to service_role;
