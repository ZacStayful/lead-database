-- ============================================================================
-- Customer goals (MANAGEMENT ONLY).
--
-- A subscriber states how many signed management clients they want out of this
-- marketplace. The dashboard then shows two separate things:
--
--   * the DIRECT completion check — how many they have actually won, against
--     the goal. This is the only thing that decides whether the goal is met.
--   * a supporting PIPELINE ESTIMATE — how many leads a goal of that size
--     implies at the long-run 1-in-20 conversion rate, and roughly how long
--     that takes at their current plan size.
--
-- The two must not be conflated. Won count is fact; the pipeline figure is a
-- model. A customer who signs five clients from forty leads has met a goal of
-- five even though the model said they would need a hundred.
--
-- ---------------------------------------------------------------------------
-- WHY A THIRD COUNTER
-- ---------------------------------------------------------------------------
-- The pipeline estimate needs "leads received, ever". Neither existing number
-- can answer that:
--
--   * leads_received_this_month is a PACING counter. It resets on the
--     customer's billing anchor day (0014, 0018), so it forgets everything
--     older than the current cycle.
--   * lead_balance is the ALLOCATION GATE — a credit balance that is spent
--     down on assignment and topped up on invoice. It measures what is owed,
--     not what has been delivered.
--
-- management_lifetime_leads_received is therefore a third, independent thing:
-- monotonic, never reset, never decremented. It is a delivery odometer. It has
-- no effect on allocation, pacing, billing or eligibility, and nothing reads it
-- except the goals page. CLAUDE.md §9 invariants 1 and 2 are untouched.
--
-- It is deliberately NOT decremented by reject or discard:
--   * reject leaves the lead delivered and chargeable (0019), so the odometer
--     must not wind back.
--   * discard deletes the assignment, but 0010 already establishes that a
--     discarded lead still counts against the monthly allocation. The same
--     reasoning applies with more force to a lifetime total.
-- Neither function touches customer counters today and neither is modified
-- here, so this holds by construction rather than by convention.
--
-- ---------------------------------------------------------------------------
-- MANAGEMENT ONLY
-- ---------------------------------------------------------------------------
-- No gr_ mirror is added. Per CLAUDE.md §9 invariant 6 the two products stay
-- parallel, and a GR equivalent is a separate decision (the conversion model,
-- the price and the sales cycle are all different). Nothing here reads or
-- writes a GR column, and the GR branch of assign_lead_to_customer is
-- byte-for-byte unchanged.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 — Columns.
--
-- All three are additive. The goal itself is nullable: NULL means "no goal
-- set", which is a real and distinct state from a goal of zero (the UI renders
-- the goal-setting prompt for NULL). The odometer is NOT NULL DEFAULT 0 so
-- every existing row starts at a defined value.
--
-- NOTE ON BACKFILL: existing customers start at 0, not at their historical
-- delivery count. Reconstructing it would mean counting lead_assignments,
-- which cannot distinguish leads received from leads discarded (discard
-- deletes the row), and would silently include reclaimed and admin-placed
-- leads under a number the customer has never seen before. Starting everyone
-- at 0 is honest — the odometer measures from today forward — and the goals
-- page only ever shows it alongside the goal a customer sets from now on.
-- ---------------------------------------------------------------------------
alter table public.customers
  add column if not exists management_customer_goal integer,
  add column if not exists management_customer_goal_updated_at timestamptz,
  add column if not exists management_lifetime_leads_received integer not null default 0;

-- A goal is a count of clients somebody wants to sign. Zero and negative are
-- not meaningful; "no goal" is expressed by NULL, not by 0. Enforced at the
-- column so no write path — RPC, admin, or a future one — can bypass it.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'customers_management_customer_goal_positive'
  ) then
    alter table public.customers
      add constraint customers_management_customer_goal_positive
      check (management_customer_goal is null or management_customer_goal >= 1);
  end if;
end
$$;

comment on column public.customers.management_customer_goal is
  'Management only. Target number of signed management clients from this '
  'marketplace. NULL = no goal set. Customer-settable via '
  'set_management_customer_goal() only.';

comment on column public.customers.management_lifetime_leads_received is
  'Management only. Monotonic count of management leads ever delivered to this '
  'customer. Never reset, never decremented. Not an allocation gate and not a '
  'pacing counter — see leads_received_this_month and lead_balance for those.';

-- ---------------------------------------------------------------------------
-- 2 — assign_lead_to_customer bumps the odometer on the management branch.
--
-- Definition verbatim from 0046 EXCEPT one added assignment inside the
-- management UPDATE. Signature, return type, volatility, security context,
-- row locking, the capacity check, the reclaim-slot allowance, the pause
-- check, the balance gate, the credit spend and the GR branch are all
-- unchanged, so this remains the single atomic money path described in
-- CLAUDE.md §4.
--
-- The increment shares the existing UPDATE statement rather than adding a
-- second one: same row, same lock, same transaction. There is no window in
-- which the odometer and leads_received_this_month can disagree about a lead.
--
-- Reclaimed leads DO count. reclaim_lead_assignment (0046) delivers through
-- this same function, so a £10 second-hand management lead increments the
-- odometer. That is correct for what the number means: it is a lead the
-- customer received and can work, and the pipeline estimate is about how many
-- leads it takes to sign a client, not about what was paid for them.
-- ---------------------------------------------------------------------------
create or replace function public.assign_lead_to_customer(
  p_lead_id uuid,
  p_customer_id uuid,
  p_price numeric,
  p_lead_type public.lead_type default 'management'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead     public.leads%rowtype;
  v_customer public.customers%rowtype;
  v_assignment_id uuid;
  v_capacity integer;
begin
  select * into v_lead from public.leads
    where id = p_lead_id for update;
  if not found then
    raise exception 'Lead % not found', p_lead_id;
  end if;

  select * into v_customer from public.customers
    where id = p_customer_id for update;
  if not found then
    raise exception 'Customer % not found', p_customer_id;
  end if;

  -- Capacity = ordinary cap + any reclaim slot granted and not yet consumed.
  v_capacity := v_lead.max_assignments
                + public.lead_open_reclaim_slots(p_lead_id);

  if v_lead.assignment_count >= v_capacity then
    raise exception 'Lead % is at max assignments (%/%)',
      p_lead_id, v_lead.assignment_count, v_capacity;
  end if;

  if p_lead_type = 'guaranteed_rent' then
    if v_customer.gr_lead_balance <= 0 then
      raise exception 'Customer % has no remaining GR lead balance', p_customer_id;
    end if;
  else
    if v_customer.paused_at is not null then
      raise exception 'Customer % is paused and cannot receive management leads', p_customer_id;
    end if;
    if v_customer.lead_balance <= 0 then
      raise exception 'Customer % has no remaining lead balance', p_customer_id;
    end if;
  end if;

  insert into public.lead_assignments (lead_id, customer_id, price_paid)
    values (p_lead_id, p_customer_id, p_price)
    returning id into v_assignment_id;

  update public.leads
    set assignment_count = assignment_count + 1
    where id = p_lead_id;

  if p_lead_type = 'guaranteed_rent' then
    -- GR branch: unchanged. No lifetime odometer exists for this product.
    update public.customers
      set gr_lead_balance = gr_lead_balance - 1,
          gr_leads_received_this_month = gr_leads_received_this_month + 1,
          gr_last_assignment_at = now(),
          updated_at = now()
      where id = p_customer_id;
  else
    update public.customers
      set leads_received_this_month = leads_received_this_month + 1,
          management_lifetime_leads_received =
            management_lifetime_leads_received + 1,
          lead_balance = lead_balance - 1,
          last_assignment_at = now(),
          updated_at = now()
      where id = p_customer_id;
  end if;

  return v_assignment_id;
end;
$$;

revoke execute on function public.assign_lead_to_customer(uuid, uuid, numeric, public.lead_type)
  from public, anon, authenticated;
grant execute on function public.assign_lead_to_customer(uuid, uuid, numeric, public.lead_type)
  to service_role;

-- ---------------------------------------------------------------------------
-- 3 — admin_assign_lead bumps the odometer too.
--
-- Definition verbatim from 0040 EXCEPT the same one-line addition. This is a
-- second, independent delivery path: it writes its own customer UPDATE rather
-- than calling assign_lead_to_customer, so without this change a lead placed
-- by an admin override would arrive in the customer's feed without moving the
-- odometer. The customer would then see "leads received so far" disagree with
-- the leads actually in front of them.
--
-- A delivered lead is a delivered lead, regardless of which path placed it or
-- whether a credit was available to spend on it. Everything else about the
-- override — the skipped balance gate, greatest(balance-1, 0), the pause
-- block, the max_assignments check — is untouched.
-- ---------------------------------------------------------------------------
create or replace function public.admin_assign_lead(
  p_lead_id uuid,
  p_customer_id uuid,
  p_price numeric,
  p_lead_type public.lead_type default 'management'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead     public.leads%rowtype;
  v_customer public.customers%rowtype;
  v_assignment_id uuid;
begin
  select * into v_lead from public.leads
    where id = p_lead_id for update;
  if not found then
    raise exception 'Lead % not found', p_lead_id;
  end if;

  select * into v_customer from public.customers
    where id = p_customer_id for update;
  if not found then
    raise exception 'Customer % not found', p_customer_id;
  end if;

  -- Capacity still applies. Raise max_assignments to add more recipients.
  if v_lead.assignment_count >= v_lead.max_assignments then
    raise exception 'Lead % is at max assignments (%/%)',
      p_lead_id, v_lead.assignment_count, v_lead.max_assignments;
  end if;

  -- Pause is management-only and airtight: even an override must not place a
  -- management lead with a paused customer (mirrors 0039).
  if p_lead_type <> 'guaranteed_rent' and v_customer.paused_at is not null then
    raise exception 'Customer % is paused and cannot receive management leads', p_customer_id;
  end if;

  -- NB: no balance / subscription gate here — this is the admin override path.

  insert into public.lead_assignments (lead_id, customer_id, price_paid)
    values (p_lead_id, p_customer_id, p_price)
    returning id into v_assignment_id;

  update public.leads
    set assignment_count = assignment_count + 1
    where id = p_lead_id;

  -- Spend a credit only if one is available, so an override never goes negative.
  if p_lead_type = 'guaranteed_rent' then
    update public.customers
      set gr_lead_balance = greatest(gr_lead_balance - 1, 0),
          gr_leads_received_this_month = gr_leads_received_this_month + 1,
          gr_last_assignment_at = now(),
          updated_at = now()
      where id = p_customer_id;
  else
    update public.customers
      set lead_balance = greatest(lead_balance - 1, 0),
          leads_received_this_month = leads_received_this_month + 1,
          management_lifetime_leads_received =
            management_lifetime_leads_received + 1,
          last_assignment_at = now(),
          updated_at = now()
      where id = p_customer_id;
  end if;

  return v_assignment_id;
end;
$$;

revoke execute on function public.admin_assign_lead(uuid, uuid, numeric, public.lead_type)
  from public, anon, authenticated;
grant execute on function public.admin_assign_lead(uuid, uuid, numeric, public.lead_type)
  to service_role;

-- ---------------------------------------------------------------------------
-- 4 — The one customer-settable field in the schema.
--
-- ###################  SECURITY DESIGN  ###################
--
-- customers has exactly one RLS policy — customers_select_own (0001) — and no
-- INSERT, UPDATE or DELETE policy at all. That is deliberate: allocation,
-- balance and billing flags must never be browser-writable (CLAUDE.md §9
-- invariant 7). A goal is the first thing a customer legitimately owns, and it
-- is exposed WITHOUT weakening that, by adding a narrow SECURITY DEFINER
-- function rather than a column-level UPDATE grant:
--
--   * NO customer id parameter. Identity comes from auth.uid() resolved INSIDE
--     the function, exactly as get_engagement_benchmarks (0047) does. There is
--     no argument a caller could point at somebody else's row.
--
--   * It writes TWO columns by name. Even holding EXECUTE, a caller cannot
--     reach lead_balance, monthly_allocation, subscription_status or anything
--     else through it. A column-level UPDATE grant, by contrast, would have to
--     be trusted not to be combined with a crafted PostgREST payload.
--
--   * A missing customer row or a customer without an active management
--     subscription RAISES. A silent no-op would leave the UI showing a saved
--     goal that does not exist.
--
-- WHY subscription_status AND NOT monthly_allocation:
-- monthly_allocation is nullable but never actually null — it carries a DB
-- default of 20 (0001) and every creation path sets it explicitly. Gating on
-- "monthly_allocation is not null" would therefore admit every customer,
-- including GR-only ones, which is precisely the group the gate exists to
-- exclude. subscription_status = 'active' is the test the rest of the codebase
-- already uses for "holds management" (documents, filtering, pause, the
-- inactivity nudge and the admin console all agree on it).
-- ---------------------------------------------------------------------------
-- The OUT columns are named goal / goal_updated_at rather than after the
-- columns themselves. Naming them identically would put a PL/pgSQL variable
-- and a table column in scope under one identifier inside the UPDATE, which
-- the default variable_conflict = error setting rejects.
create or replace function public.set_management_customer_goal(p_goal integer)
returns table (
  goal            integer,
  goal_updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer_id uuid;
  v_status      text;
begin
  -- NULL clears the goal; anything else must be a real target.
  if p_goal is not null and p_goal < 1 then
    raise exception 'Goal must be at least 1, or null to clear it';
  end if;

  -- Identity comes from the session, never from an argument.
  select c.id, c.subscription_status
    into v_customer_id, v_status
    from public.customers c
   where c.user_id = auth.uid();

  if v_customer_id is null then
    raise exception 'No customer record for the current user';
  end if;

  if coalesce(v_status, '') <> 'active' then
    raise exception
      'Goals are available with an active management subscription';
  end if;

  update public.customers
     set management_customer_goal = p_goal,
         management_customer_goal_updated_at = now(),
         updated_at = now()
   where id = v_customer_id
  returning management_customer_goal, management_customer_goal_updated_at
      into goal, goal_updated_at;

  -- Unreachable in practice (the row was just read), but a zero-row UPDATE
  -- would otherwise return a row of NULLs, which the caller cannot tell apart
  -- from a successfully cleared goal.
  if not found then
    raise exception 'Failed to update goal for customer %', v_customer_id;
  end if;

  return next;
end;
$$;

revoke execute on function public.set_management_customer_goal(integer)
  from public, anon;
grant execute on function public.set_management_customer_goal(integer)
  to authenticated, service_role;
