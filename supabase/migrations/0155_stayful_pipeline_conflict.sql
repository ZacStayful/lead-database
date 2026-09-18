-- ============================================================================
-- 0155 — A landlord Stayful is already working is never sold (CLAUDE.md §64)
--
-- Stayful runs its own landlord sales pipeline on Monday board 5891626711.
-- Nine of its groups mean "Stayful is actively working, or has signed, this
-- landlord". A lead in the database that matches one of them — same Monday
-- item, same email, or same phone — must never reach an operator: Stayful
-- and the operator would both be ringing the same person.
--
-- Measured on 2026-09-18: 11 marketplace leads matched, 9 of them held by
-- customers across 24 assignments, and 5 of the 11 are the SAME Monday item
-- that was sold via n8n and then moved INTO a pipeline group by Stayful's own
-- "Qualified lead" automation. The conflict arises after the sale as often
-- as before it, which is why there is a sweep as well as an ingest check.
--
-- What this migration adds:
--
--   1. Four columns on `leads` recording the conflict (when, which item,
--      which group, which rule matched).
--   2. A sixth arm of lead_retirement_reason(): 'stayful_conflict', FIRST,
--      because it is permanent and has no escape hatch. Every candidate
--      function, escalation, assign_lead_to_customer's locked check and the
--      swap picker inherit it through lead_retired_from_allocation, which is
--      untouched and still delegates (0144 §7).
--   3. The same clause in lead_pool_barred() — 0111's own trap: a flagged lead
--      that was never assigned is retired by nothing else there and would
--      pool on the `unassigned` basis at day 25, claimable free.
--   4. `owed_lead_replacements`: one row per assignment withdrawn, at the
--      price the customer paid, fulfilled later at that price. A swap moves
--      no money (§52.1) and neither does this.
--   5. flag_stayful_conflict(): stamps the lead, withdraws every LIVE
--      assignment (new / contacted / in_discussion; won, rejected, not
--      relevant and closed are settled and left alone), writes the owed rows,
--      force-outs the lead from the pool, and clamps max_assignments the way
--      the swap does — customer_can_see_pool_lead (0074) never consults
--      lead_pool_barred, and admin_assign_lead (0142) consults no retirement
--      predicate, so the arm alone is not enough for either.
--   6. fulfil_owed_replacement(), fulfil_owed_from_stock() and
--      open_owed_replacements_for_lead(): the swap's incoming half, with the
--      same guards and NO filter override — the customer never asked for
--      this — spending no credit, moving no counter and ignoring the daily
--      curve and cap. Called from the sweep (against stock, newest first)
--      and from autoAssignLead on every arriving lead, BEFORE ordinary
--      routing.
--
-- ⚠️ INERT ON APPLY. No lead carries stayful_conflict_at, so the new arm and
-- the new pool clause match nothing; the four functions have no caller until
-- the code ships; `stayful_conflict_enabled` ships 'false'. Both candidate
-- functions return exactly what they returned before, which the verification
-- fingerprints.
--
-- ⚠️ LOCK ORDER. flag: assignments (id order) → lead → customer per
-- withdrawal — the swap's order (assignment → old lead → new lead →
-- customer). fulfil: owed → lead → customer. assign_lead_to_customer: lead →
-- customer. The residual window is an admin swap holding assignment A and
-- waiting on lead L while the flag holds A's siblings and L and then wants
-- A: Postgres aborts one side; the flag is idempotent and the sweep re-runs
-- in fifteen minutes.
--
-- ⚠️ NO MONEY MOVES ANYWHERE IN THIS FILE. No lead_balance, no monthly
-- counter, no odometer, no replacement_balance, no clean_leads_streak, no
-- quality_claims_this_cycle. The suite fingerprints every holder's columns
-- before and after.
--
-- Applied to production with comments stripped OUTSIDE function bodies only,
-- so every prosrc matches this file (§48.9, §51.10).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Columns on leads. All nullable; a stamp with no evidence is unreadable
--    on the admin page, so the four move together.
-- ---------------------------------------------------------------------------
alter table public.leads
  add column if not exists stayful_conflict_at         timestamptz,
  add column if not exists stayful_conflict_item_id    text,
  add column if not exists stayful_conflict_group_id   text,
  add column if not exists stayful_conflict_matched_by text;

comment on column public.leads.stayful_conflict_at is
  'Set when the lead matched Stayful''s own pipeline (board 5891626711, one of nine groups). Permanent: retires the lead from every allocation path and the pool. Never cleared (§64).';
comment on column public.leads.stayful_conflict_item_id is
  'The Monday item on board 5891626711 that matched.';
comment on column public.leads.stayful_conflict_group_id is
  'Which of the nine pipeline groups the item sat in when it matched.';
comment on column public.leads.stayful_conflict_matched_by is
  'Which rule matched: item (same Monday item), email, or phone (last 9 digits).';

alter table public.leads drop constraint if exists leads_stayful_conflict_matched_by_check;
alter table public.leads add constraint leads_stayful_conflict_matched_by_check
  check (stayful_conflict_matched_by is null
         or stayful_conflict_matched_by in ('item', 'email', 'phone'));

alter table public.leads drop constraint if exists leads_stayful_conflict_shape_check;
alter table public.leads add constraint leads_stayful_conflict_shape_check
  check (stayful_conflict_at is null
         or (stayful_conflict_item_id is not null
             and stayful_conflict_group_id is not null
             and stayful_conflict_matched_by is not null));

create index if not exists idx_leads_stayful_conflict
  on public.leads (stayful_conflict_at desc)
  where stayful_conflict_at is not null;

-- ---------------------------------------------------------------------------
-- 2. The switch. Ships OFF. Read by TypeScript only (ingest and the sweep);
--    the functions below are unconditional.
-- ---------------------------------------------------------------------------
insert into public.system_settings (key, value)
values ('stayful_conflict_enabled', 'false')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 3. Replacements owed. One row per withdrawn assignment.
--
--    ⚠️ NO FOREIGN KEY on either origin id. The assignment is deleted by the
--    same function that creates this row (0139's origin_assignment_id
--    argument), and the lead must keep its provenance even if it is later
--    deleted by hand.
--
--    `origin_notes` snapshots the notes the assignment cascade destroys
--    (0009): the admin panel can show what the operator lost.
-- ---------------------------------------------------------------------------
create table if not exists public.owed_lead_replacements (
  id                      uuid primary key default gen_random_uuid(),
  customer_id             uuid not null references public.customers(id) on delete cascade,
  lead_type               public.lead_type not null,
  origin_lead_id          uuid not null,
  origin_assignment_id    uuid not null,
  origin_status           text not null,
  origin_notes            jsonb,
  price_paid              numeric not null,
  replacement_depth       integer not null default 0 check (replacement_depth >= 0),
  status                  text not null default 'open'
                            check (status in ('open', 'fulfilled', 'cancelled')),
  created_at              timestamptz not null default now(),
  fulfilled_at            timestamptz,
  fulfilled_lead_id       uuid references public.leads(id) on delete set null,
  fulfilled_assignment_id uuid references public.lead_assignments(id) on delete set null,
  cancelled_at            timestamptz,
  cancelled_note          text,
  constraint owed_lead_replacements_fulfilled_shape
    check ((status = 'fulfilled') = (fulfilled_at is not null)),
  constraint owed_lead_replacements_cancelled_shape
    check ((status = 'cancelled') = (cancelled_at is not null))
);

comment on table public.owed_lead_replacements is
  'A replacement we owe a customer after withdrawing a lead that was ours (§64). Fulfilled at the original price_paid; no credit moves. RLS on, no policies.';

create unique index if not exists owed_lead_replacements_origin_assignment_key
  on public.owed_lead_replacements (origin_assignment_id);
create index if not exists idx_owed_lead_replacements_open
  on public.owed_lead_replacements (created_at)
  where status = 'open';
create index if not exists idx_owed_lead_replacements_customer
  on public.owed_lead_replacements (customer_id);
create index if not exists idx_owed_lead_replacements_origin_lead
  on public.owed_lead_replacements (origin_lead_id);

alter table public.owed_lead_replacements enable row level security;

-- ---------------------------------------------------------------------------
-- 4. The reason. 0144's body verbatim plus ONE arm, FIRST — permanent, no
--    hatch, and the party the admin must not override. lead_retired_from_
--    allocation is not re-issued: it delegates (0144 §7).
-- ---------------------------------------------------------------------------
create or replace function public.lead_retirement_reason(p_lead_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    -- 0155. Stayful's own pipeline holds this landlord. Permanent, and the
    -- one basis with no admin escape hatch at all (§64, decision 7).
    when l.stayful_conflict_at is not null then 'stayful_conflict'
    -- A pool claim. No admin control undoes this and none should: the lead
    -- belongs to whoever claimed it, and §19.6 is explicit the slot never
    -- reopens.
    when exists (
      select 1 from public.lead_assignments la
      where la.lead_id = p_lead_id
        and la.claimed_from_pool_at is not null
    ) then 'claimed_from_pool'
    when l.pool_expired_at is not null then 'pool_expired'
    when l.pool_entered_at is not null and l.pool_entry_basis = 'ignored'
      then 'pooled_ignored'
    -- Since 0108 a resale-QUALIFIED owned lead is deliberately absent from
    -- this list. It is still refused by the swap, by its own owner rule
    -- (§32.6), which is a different question from allocation.
    when l.owner_customer_id is not null
     and l.owner_resale_qualified_at is null then 'owner_unqualified'
    when l.lead_quality_status = 'failed'
     and l.lead_quality_override_at is null then 'quality_failed'
    else null
  end
  from public.leads l
  where l.id = p_lead_id;
$$;

revoke execute on function public.lead_retirement_reason(uuid)
  from public, anon, authenticated;
grant execute on function public.lead_retirement_reason(uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- 5. The pool predicate. 0111's body verbatim plus one clause.
-- ---------------------------------------------------------------------------
create or replace function public.lead_pool_barred(p_lead_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    exists (
      select 1 from public.lead_notes n
      join public.lead_assignments la on la.id = n.lead_assignment_id
      where la.lead_id = p_lead_id
    )
    or exists (
      select 1 from public.lead_assignments la
      where la.lead_id = p_lead_id and la.status in ('in_discussion', 'won')
    )
    or exists (
      select 1 from public.lead_assignments la
      where la.lead_id = p_lead_id and la.closed_at is not null
    )
    or exists (
      select 1 from public.lead_assignments la
      where la.lead_id = p_lead_id
        and (
          (la.due_to_call_date is not null and la.due_to_call_date_set_at is null)
          or (la.income_estimate is not null and la.income_estimate_set_at is null)
        )
    )
    or exists (
      select 1 from public.leads l
      where l.id = p_lead_id
        and (
          l.withdrawn_at is not null
          or l.pool_expired_at is not null
          or l.pool_excluded_at is not null
          or l.owner_customer_id is not null
          -- 0111. Same clause, and it must be here as well as in
          -- lead_retired_from_allocation: a lead that was never assigned is not
          -- retired by anything above, so without this it pools on the
          -- `unassigned` basis and every subscriber can claim it.
          or (
            l.lead_quality_status = 'failed'
            and l.lead_quality_override_at is null
          )
          -- 0155. Same reasoning, one basis over: a never-assigned lead in
          -- Stayful's pipeline is retired by nothing else here.
          or l.stayful_conflict_at is not null
        )
    );
$$;

revoke execute on function public.lead_pool_barred(uuid)
  from public, anon, authenticated;
grant execute on function public.lead_pool_barred(uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- 6. Flag a lead, withdraw its live assignments, record what is owed.
--
--    Returns one row per withdrawn assignment. Idempotent: a second call on a
--    flagged lead returns nothing and writes nothing. Settled assignments
--    (won, rejected, not_relevant, closed) are never touched.
-- ---------------------------------------------------------------------------
create or replace function public.flag_stayful_conflict(
  p_lead_id    uuid,
  p_item_id    text,
  p_group_id   text,
  p_matched_by text
)
returns table (owed_id uuid, customer_id uuid, withdrawn_assignment_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead      public.leads%rowtype;
  r           record;
  v_owed_id   uuid;
  v_withdrawn integer := 0;
  v_notes     jsonb;
begin
  if p_matched_by is null or p_matched_by not in ('item', 'email', 'phone') then
    raise exception 'Unknown match basis %', p_matched_by;
  end if;

  -- Assignments first, in id order — the swap's lock order.
  perform 1 from public.lead_assignments la
    where la.lead_id = p_lead_id
      and la.status in ('new', 'contacted', 'in_discussion')
      and la.closed_at is null
    order by la.id
    for update;

  select * into v_lead from public.leads where id = p_lead_id for update;
  if not found then
    raise exception 'Lead % not found', p_lead_id;
  end if;

  if v_lead.lead_type <> 'management' then
    raise exception 'Lead % is not a management lead; Stayful''s pipeline is checked for management only', p_lead_id;
  end if;

  -- A customer's own upload stays on their own dashboard. Withdrawing it is a
  -- different product decision and is not this one.
  if v_lead.owner_customer_id is not null then
    raise exception 'Lead % was added by a customer and is not subject to the Stayful pipeline check', p_lead_id;
  end if;

  -- Idempotent. The sweep and ingest can both call this.
  if v_lead.stayful_conflict_at is not null then
    return;
  end if;

  -- Re-selected now the lead is held: a row assign_lead_to_customer inserted
  -- between the two locks above is caught here.
  for r in
    select la.id, la.customer_id as cust_id, la.status, la.price_paid, la.replacement_depth
    from public.lead_assignments la
    where la.lead_id = p_lead_id
      and la.status in ('new', 'contacted', 'in_discussion')
      and la.closed_at is null
    order by la.id
    for update
  loop
    perform 1 from public.customers c where c.id = r.cust_id for update;

    -- The notes go with the assignment (0009 cascade); keep what was written.
    select jsonb_agg(jsonb_build_object('body', n.body, 'created_at', n.created_at)
                     order by n.created_at)
      into v_notes
      from public.lead_notes n
      where n.lead_assignment_id = r.id;

    insert into public.owed_lead_replacements
      (customer_id, lead_type, origin_lead_id, origin_assignment_id,
       origin_status, origin_notes, price_paid, replacement_depth)
    values
      (r.cust_id, v_lead.lead_type, p_lead_id, r.id,
       r.status, v_notes, r.price_paid, coalesce(r.replacement_depth, 0))
    on conflict (origin_assignment_id) do nothing
    returning id into v_owed_id;

    delete from public.lead_assignments where id = r.id;

    v_withdrawn := v_withdrawn + 1;
    owed_id := v_owed_id;
    customer_id := r.cust_id;
    withdrawn_assignment_id := r.id;
    return next;
  end loop;

  -- One UPDATE from the locked pre-image (v_lead). withdrawn_slots is 0145's
  -- formula generalised from one withdrawal to n, ADDED rather than
  -- overwritten so a lead a swap already withdrew keeps that figure. Stamped
  -- even at n = 0: a never-sold lead leaving supply is a real drop, and
  -- withdrawn_at is what the stock queries and the pickers read.
  --
  -- The pool force-out is the admin_pool_force_out (0076) write. It has to be
  -- here: customer_can_see_pool_lead tests pool_entered_at, never
  -- lead_pool_barred, so without it a flagged lead already in the pool stays
  -- claimable until the 10:30 sweep.
  update public.leads
    set stayful_conflict_at         = now(),
        stayful_conflict_item_id    = p_item_id,
        stayful_conflict_group_id   = p_group_id,
        stayful_conflict_matched_by = p_matched_by,
        assignment_count            = greatest(v_lead.assignment_count - v_withdrawn, 0),
        withdrawn_at                = now(),
        withdrawn_slots             = coalesce(withdrawn_slots, 0)
                                      + greatest(v_lead.max_assignments
                                                 - greatest(v_lead.assignment_count - v_withdrawn, 0), 0),
        pool_entered_at             = null,
        pool_entry_basis            = null,
        pool_excluded_at            = now()
    where id = p_lead_id;

  -- The clamp (0059/0146), read after the decrement. Load-bearing for
  -- admin_assign_lead, which checks capacity but no retirement predicate.
  update public.leads
    set max_assignments = assignment_count
    where id = p_lead_id;

  return;
end;
$$;

revoke execute on function public.flag_stayful_conflict(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.flag_stayful_conflict(uuid, text, text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 7. Fulfil one owed replacement with one specific lead.
--
--    The swap's incoming half (0146:178–263) with the same guards and NO
--    filter override. No credit is spent, no counter moves, the daily curve
--    and cap are not consulted, and lead_balance is not required — this is
--    the slot the customer already paid for.
-- ---------------------------------------------------------------------------
create or replace function public.fulfil_owed_replacement(
  p_owed_id uuid,
  p_lead_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owed     public.owed_lead_replacements%rowtype;
  v_lead     public.leads%rowtype;
  v_customer public.customers%rowtype;
  v_new_id   uuid;
begin
  select * into v_owed from public.owed_lead_replacements
    where id = p_owed_id for update;
  if not found then
    raise exception 'Owed replacement % not found', p_owed_id;
  end if;
  if v_owed.status <> 'open' then
    raise exception 'Owed replacement % is already settled (%)', p_owed_id, v_owed.status;
  end if;

  select * into v_lead from public.leads where id = p_lead_id for update;
  if not found then
    raise exception 'Lead % not found', p_lead_id;
  end if;

  if v_lead.lead_type is distinct from v_owed.lead_type then
    raise exception 'Replacement must be the same product as the lead that was withdrawn';
  end if;

  if v_lead.owner_customer_id is not null then
    raise exception 'Lead % was added by a customer and cannot be handed out', p_lead_id;
  end if;

  -- A withdrawn lead is not stock — the pickers' rule (0141, 0144).
  if v_lead.withdrawn_at is not null then
    raise exception 'Lead % has been withdrawn from circulation', p_lead_id;
  end if;

  -- Invariant 11, under the row lock, exactly as 0143 asserts it in the swap.
  -- coalesce: a null reads as retired, never as permission.
  if coalesce(public.lead_retired_from_allocation(p_lead_id), true) then
    raise exception 'Lead % is retired from allocation', p_lead_id;
  end if;

  if v_lead.assignment_count >= v_lead.max_assignments then
    raise exception 'Lead % is at max assignments (%/%)',
      p_lead_id, v_lead.assignment_count, v_lead.max_assignments;
  end if;

  select * into v_customer from public.customers
    where id = v_owed.customer_id for update;
  if not found then
    raise exception 'Customer % not found', v_owed.customer_id;
  end if;
  if not v_customer.is_active then
    raise exception 'Customer % is archived', v_owed.customer_id;
  end if;

  -- Product gate, invariant 6: never a management column for GR.
  if v_owed.lead_type = 'guaranteed_rent' then
    if v_customer.gr_subscription_status <> 'active' then
      raise exception 'Customer % does not hold an active guaranteed rent subscription', v_owed.customer_id;
    end if;
  else
    if v_customer.account_status <> 'active'
       or v_customer.subscription_status <> 'active' then
      raise exception 'Customer % does not hold an active management subscription', v_owed.customer_id;
    end if;
    if v_customer.paused_at is not null then
      raise exception 'Customer % is paused and cannot receive management leads', v_owed.customer_id;
    end if;
  end if;

  if exists (
    select 1 from public.lead_assignments la
    where la.lead_id = p_lead_id and la.customer_id = v_owed.customer_id
  ) then
    raise exception 'Customer already has lead %', p_lead_id;
  end if;

  -- The customer chose which leads they want (0109). There is no override on
  -- this function: nobody asked for this replacement, so it has to be one
  -- they would have been sent anyway. An unfiltered customer passes (0074).
  if not coalesce(
    public.lead_matches_customer_filter(p_lead_id, v_owed.customer_id, v_lead.lead_type),
    false)
  then
    raise exception 'Lead % does not match customer %''s lead filter',
      p_lead_id, v_owed.customer_id;
  end if;

  -- The swap's incoming insert (0146): same price, one replacement deeper.
  insert into public.lead_assignments
    (lead_id, customer_id, price_paid, replacement_depth)
    values (p_lead_id, v_owed.customer_id, v_owed.price_paid,
            coalesce(v_owed.replacement_depth, 0) + 1)
    returning id into v_new_id;

  update public.leads
    set assignment_count = assignment_count + 1,
        -- Placed, so no longer open stock (0142's two expressions).
        pool_entered_at  = case when pool_entry_basis = 'unassigned'
                                then null else pool_entered_at end,
        pool_entry_basis = case when pool_entry_basis = 'unassigned'
                                then null else pool_entry_basis end
    where id = p_lead_id;

  update public.owed_lead_replacements
    set status                  = 'fulfilled',
        fulfilled_at            = now(),
        fulfilled_lead_id       = p_lead_id,
        fulfilled_assignment_id = v_new_id
    where id = p_owed_id;

  return v_new_id;
end;
$$;

revoke execute on function public.fulfil_owed_replacement(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.fulfil_owed_replacement(uuid, uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- 8. Fulfil one owed replacement from whatever is in stock.
--
--    Returns the new assignment id, or NULL when nothing in stock matches or
--    the customer cannot receive right now (paused, lapsed) — waiting is the
--    ordinary case, not an error. Newest matching lead first, the ordering
--    0141's replacement picker uses: the lead they lost was on average fresh.
--    releaseLeads.ts goes oldest-first for a different question (draining a
--    bank), so do not "fix" one to match the other.
--
--    No replacement_stock_floor: that bounds customer-initiated swaps
--    (§53.3). A replacement we owe is not rationed.
-- ---------------------------------------------------------------------------
create or replace function public.fulfil_owed_from_stock(p_owed_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owed     public.owed_lead_replacements%rowtype;
  v_customer public.customers%rowtype;
  v_lead_id  uuid;
begin
  select * into v_owed from public.owed_lead_replacements
    where id = p_owed_id for update;
  if not found then
    raise exception 'Owed replacement % not found', p_owed_id;
  end if;
  if v_owed.status <> 'open' then
    raise exception 'Owed replacement % is already settled (%)', p_owed_id, v_owed.status;
  end if;

  select * into v_customer from public.customers where id = v_owed.customer_id;
  if not found or not v_customer.is_active then
    return null;
  end if;
  if v_owed.lead_type = 'guaranteed_rent' then
    if v_customer.gr_subscription_status <> 'active' then return null; end if;
  else
    if v_customer.account_status <> 'active'
       or v_customer.subscription_status <> 'active'
       or v_customer.paused_at is not null then
      return null;
    end if;
  end if;

  select l.id into v_lead_id
  from public.leads l
  where l.lead_type = v_owed.lead_type
    and l.owner_customer_id is null
    and l.withdrawn_at is null
    and l.assignment_count < l.max_assignments
    and not public.lead_retired_from_allocation(l.id)
    and not exists (
      select 1 from public.lead_assignments la
      where la.lead_id = l.id and la.customer_id = v_owed.customer_id
    )
    and coalesce(
      public.lead_matches_customer_filter(l.id, v_owed.customer_id, l.lead_type),
      false)
  order by l.created_at desc
  limit 1
  for update of l skip locked;

  if v_lead_id is null then
    return null;
  end if;

  return public.fulfil_owed_replacement(p_owed_id, v_lead_id);
end;
$$;

revoke execute on function public.fulfil_owed_from_stock(uuid)
  from public, anon, authenticated;
grant execute on function public.fulfil_owed_from_stock(uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- 9. Who is owed a replacement that THIS lead would satisfy.
--
--    One row per customer (a customer owed two gets one lead per arriving
--    lead). Ordered oldest-owed first within a customer; the caller sorts the
--    result by owed_since so the longest-owed customer goes first.
-- ---------------------------------------------------------------------------
create or replace function public.open_owed_replacements_for_lead(p_lead_id uuid)
returns table (owed_id uuid, customer_id uuid, owed_since timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select distinct on (o.customer_id)
    o.id,
    o.customer_id,
    o.created_at
  from public.owed_lead_replacements o
  join public.leads l on l.id = p_lead_id
  join public.customers c on c.id = o.customer_id
  where o.status = 'open'
    and o.lead_type = l.lead_type
    and l.owner_customer_id is null
    and l.withdrawn_at is null
    and l.assignment_count < l.max_assignments
    and not public.lead_retired_from_allocation(l.id)
    and c.is_active = true
    and (
      (l.lead_type = 'management'
        and c.account_status = 'active'
        and c.subscription_status = 'active'
        and c.paused_at is null)
      or
      (l.lead_type = 'guaranteed_rent'
        and c.gr_subscription_status = 'active')
    )
    and not exists (
      select 1 from public.lead_assignments la
      where la.lead_id = l.id and la.customer_id = c.id
    )
    and coalesce(public.lead_matches_customer_filter(l.id, c.id, l.lead_type), false)
  order by o.customer_id, o.created_at asc;
$$;

revoke execute on function public.open_owed_replacements_for_lead(uuid)
  from public, anon, authenticated;
grant execute on function public.open_owed_replacements_for_lead(uuid)
  to service_role;
