-- 0142 — Make clean_leads_streak actually count (§53.2)
--
-- 0137 added the column, documented it in §51.3's table as "one more claim per
-- unbroken run of 10 leads taken without claiming", and reset it to 0 on every
-- uphold. ⚠️ NOTHING HAS EVER INCREMENTED IT. Grepping the whole repository,
-- the only writes are `= 0` in 0137 and 0141 — so `earnedBonus()` has returned
-- zero for every customer since the day it shipped, and the earned half of the
-- entitlement has never once fired.
--
-- Harmless while the number was hidden. Not harmless since §53 PUBLISHED it:
-- the tab now states an entitlement out loud, and half the rule behind it was
-- dead. §53's own Deferred list says to fix the increment or drop the column.
-- This fixes the increment.
--
-- ---------------------------------------------------------------------------
-- ⚠️ WHERE IT INCREMENTS, AND WHY NOT IN THE THIRD DELIVERY PATH
-- ---------------------------------------------------------------------------
--
-- The streak means "leads this customer COULD have reported and did not". That
-- is the only reading under which it measures restraint, and it decides the
-- boundary exactly:
--
--   * assign_lead_to_customer — the single money path. Increments. ✓
--   * admin_assign_lead — an override still delivers a workable, reportable
--     lead, and §18C records that a force-assign paces identically to an
--     automatic one. Increments. ✓
--   * claim_pool_lead — ⚠️ DOES NOT INCREMENT. A pool-claimed lead can NEVER be
--     reported: claimable_dead_lead_assignments bars it on
--     `claimed_from_pool_at is null`, and §19 is explicit that the operator
--     chose it knowing its age. Restraint was never available, so it is neither
--     evidence of restraint nor a broken run. Counting it would also open a
--     farming route — buy pool leads, earn claim headroom — which is precisely
--     what the hidden budget existed to prevent.
--
-- Two paths need no guard at all because they never call either function: a
-- customer's own uploaded leads go through create_customer_leads, and a swap
-- replacement is inserted directly by admin_swap_lead_assignment. Neither is a
-- new chargeable delivery, and both are excluded by construction rather than by
-- a clause somebody has to remember.
--
-- One column, incremented once per delivery whichever product it was, because
-- ONE budget spans both (§51.3). So it goes in BOTH branches of both functions.
--
-- ---------------------------------------------------------------------------
-- ⚠️ NO BACKFILL, AND THE NUMBERS ARE WHY
-- ---------------------------------------------------------------------------
--
-- The obvious move is to seed the streak from delivery history. Measured on
-- production first: of the 25 active customers with any delivery, **23 would
-- earn at least one bonus immediately and 12 would hit the cap of two**, on an
-- average of 18.9 deliveries each — because nobody has ever claimed, so every
-- customer's lifetime history is one unbroken run.
--
-- That would turn the earned half into a flat +2 for most of the book on the
-- day it starts working, which is the opposite of what it is for. And §53
-- publishes the number, so it would show as everyone's entitlement jumping for
-- no reason they did anything to cause.
--
-- So every customer starts at 0 and accrues forward — the same position §40.15
-- takes for whatsapp_click ("counts from deployment forward only") and §53 for
-- the snapshot columns. The first bonus is earned ten real deliveries from now.
--
-- ---------------------------------------------------------------------------
-- Both bodies are 0110's, verified byte-for-byte against production's live
-- prosrc before being carried forward — assign_lead_to_customer
-- 57ed9867…, admin_assign_lead 2c569033… — with one line added to each of the
-- four customer-counter branches and nothing else touched. The 4-argument shims
-- are NOT re-issued: they delegate to these, so they inherit the change and
-- re-stating them would be two more chances to drift (§34's no-default trap is
-- about the same pair of signatures).
-- ---------------------------------------------------------------------------

create or replace function public.assign_lead_to_customer(
  p_lead_id uuid,
  p_customer_id uuid,
  p_price numeric,
  p_lead_type lead_type,
  p_allow_filter_mismatch boolean
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
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

  -- Before capacity: an already-held lead must not be reported as a cap breach.
  if exists (
    select 1 from public.lead_assignments
    where lead_id = p_lead_id and customer_id = p_customer_id
  ) then
    raise exception 'Customer already has this lead'
      using detail = format('customer=%s lead=%s', p_customer_id, p_lead_id);
  end if;

  -- The uploader is never sold their own lead. The duplicate check above
  -- catches this only while they still hold their assignment row, and
  -- delete-own-copy (0107) is exactly the case where they do not.
  if v_lead.owner_customer_id is not null
     and v_lead.owner_customer_id = p_customer_id then
    raise exception 'Lead % was added by customer % and cannot be sold back to them',
      p_lead_id, p_customer_id;
  end if;

  -- Invariant 7, asserted at the money path as well as in the ranking queries.
  -- The candidate functions already exclude these leads, but this is the only
  -- place that is under a row lock, and admin_assign_lead is not the only other
  -- caller — anything that acquires a lead id from elsewhere arrives here.
  if public.lead_retired_from_allocation(p_lead_id) then
    raise exception 'Lead % has passed to the expired leads pool and cannot be allocated',
      p_lead_id;
  end if;

  -- Capacity = ordinary cap + any reclaim slot granted and not yet consumed.
  v_capacity := v_lead.max_assignments
                + public.lead_open_reclaim_slots(p_lead_id);

  -- A customer's own lead reaches the uploader plus AT MOST ONE other operator,
  -- and that ceiling is absolute (§32). Two things are asserted here rather
  -- than trusted:
  --
  --   * `least(..., 2)` — max_assignments is writable from admin and from the
  --     contention branch in ingest.ts, neither of which is under this lock.
  --   * reclaim slots are ignored entirely. They are added to capacity above,
  --     so a lead carrying one would otherwise reach three.
  if v_lead.owner_customer_id is not null then
    v_capacity := least(v_lead.max_assignments, 2);
  end if;

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

  -- 0110. The customer chose which leads they want. lead_matches_customer_filter
  -- is the same predicate allocation, the pool and the swap use, and it returns
  -- true for an unfiltered customer -- so this is inert for anyone who has not
  -- set a filter, and inert for automatic routing, whose candidates have already
  -- passed it.
  --
  -- coalesce, not a bare NOT: a null must read as "does not match", never as
  -- permission. Both rows are locked and proven to exist above, so it cannot be
  -- null in practice; failing open is simply not the direction to fail in here.
  if not p_allow_filter_mismatch
     and not coalesce(
       public.lead_matches_customer_filter(p_lead_id, p_customer_id, p_lead_type),
       false)
  then
    raise exception 'Lead % does not match customer %''s lead filter',
      p_lead_id, p_customer_id;
  end if;

  insert into public.lead_assignments (lead_id, customer_id, price_paid)
    values (p_lead_id, p_customer_id, p_price)
    returning id into v_assignment_id;

  update public.leads
    set assignment_count = assignment_count + 1,
        -- Placed, so it is no longer open stock. Only ever true of the
        -- 'unassigned' basis: the 'ignored' basis is terminal and the guard
        -- above has already refused it.
        pool_entered_at  = case when pool_entry_basis = 'unassigned'
                                then null else pool_entered_at end,
        pool_entry_basis = case when pool_entry_basis = 'unassigned'
                                then null else pool_entry_basis end
    where id = p_lead_id;

  if p_lead_type = 'guaranteed_rent' then
    -- GR branch: unchanged. No lifetime odometer exists for this product.
    update public.customers
      set gr_lead_balance = gr_lead_balance - 1,
          gr_leads_received_this_month = gr_leads_received_this_month + 1,
          clean_leads_streak = clean_leads_streak + 1,
          gr_last_assignment_at = now(),
          updated_at = now()
      where id = p_customer_id;
  else
    update public.customers
      set leads_received_this_month = leads_received_this_month + 1,
          clean_leads_streak = clean_leads_streak + 1,
          management_lifetime_leads_received =
            management_lifetime_leads_received + 1,
          lead_balance = lead_balance - 1,
          last_assignment_at = now(),
          updated_at = now()
      where id = p_customer_id;
  end if;

  return v_assignment_id;
end;
$function$;

create or replace function public.admin_assign_lead(
  p_lead_id uuid,
  p_customer_id uuid,
  p_price numeric,
  p_lead_type lead_type,
  p_allow_filter_mismatch boolean
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
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

  -- Same guard, same reason. An override may bypass the credit gate but it must
  -- not be able to give one customer the same lead twice.
  if exists (
    select 1 from public.lead_assignments
    where lead_id = p_lead_id and customer_id = p_customer_id
  ) then
    raise exception 'Customer already has this lead'
      using detail = format('customer=%s lead=%s', p_customer_id, p_lead_id);
  end if;

  -- A customer's own lead belongs to them. There is no override for this: it
  -- was never ours to sell, and handing it to a competitor is the one outcome
  -- the whole feature must make impossible.
  -- Named separately from the refusal below so the error says what is actually
  -- wrong. An admin trying to hand a customer their OWN lead has made a
  -- different mistake from one trying to hand it to somebody else.
  if v_lead.owner_customer_id is not null
     and v_lead.owner_customer_id = p_customer_id then
    raise exception 'Customer % already owns lead %', p_customer_id, p_lead_id;
  end if;

  if v_lead.owner_customer_id is not null then
    raise exception 'Lead % was added by a customer and cannot be assigned to anyone else',
      p_lead_id
      using detail = format('owner=%s source=%s', v_lead.owner_customer_id, v_lead.owner_source);
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

  -- 0110. The customer chose which leads they want. lead_matches_customer_filter
  -- is the same predicate allocation, the pool and the swap use, and it returns
  -- true for an unfiltered customer -- so this is inert for anyone who has not
  -- set a filter, and inert for automatic routing, whose candidates have already
  -- passed it.
  --
  -- coalesce, not a bare NOT: a null must read as "does not match", never as
  -- permission. Both rows are locked and proven to exist above, so it cannot be
  -- null in practice; failing open is simply not the direction to fail in here.
  if not p_allow_filter_mismatch
     and not coalesce(
       public.lead_matches_customer_filter(p_lead_id, p_customer_id, p_lead_type),
       false)
  then
    raise exception 'Lead % does not match customer %''s lead filter',
      p_lead_id, p_customer_id;
  end if;

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
          clean_leads_streak = clean_leads_streak + 1,
          gr_last_assignment_at = now(),
          updated_at = now()
      where id = p_customer_id;
  else
    update public.customers
      set lead_balance = greatest(lead_balance - 1, 0),
          leads_received_this_month = leads_received_this_month + 1,
          clean_leads_streak = clean_leads_streak + 1,
          management_lifetime_leads_received =
            management_lifetime_leads_received + 1,
          last_assignment_at = now(),
          updated_at = now()
      where id = p_customer_id;
  end if;

  return v_assignment_id;
end;
$function$;

-- §11: a create or replace DISCARDS the ACL, so it is re-asserted every time.
revoke execute on function public.assign_lead_to_customer(uuid, uuid, numeric, public.lead_type, boolean)
  from public, anon, authenticated;
grant execute on function public.assign_lead_to_customer(uuid, uuid, numeric, public.lead_type, boolean)
  to service_role;

revoke execute on function public.admin_assign_lead(uuid, uuid, numeric, public.lead_type, boolean)
  from public, anon, authenticated;
grant execute on function public.admin_assign_lead(uuid, uuid, numeric, public.lead_type, boolean)
  to service_role;

-- ---------------------------------------------------------------------------
-- 2 — customer_swap_dead_lead: the streak comparison relaxes to >=
--
-- ⚠️ THIS IS A CONSEQUENCE OF SECTION 1, NOT AN UNRELATED TIDY-UP. 0141's
-- compare-and-swap tests `clean_leads_streak = p_streak_seen`, which was
-- harmless only because nothing ever moved the column. Section 1 makes it count
-- every delivery — so under `=` a swap would be refused whenever an ordinary
-- lead landed between the page loading and the operator pressing the button,
-- with a message about the lead having gone that would be simply untrue.
--
-- `>=` closes exactly the same hole. See the comment in the body.
--
-- 0141's body verbatim, with that one operator changed and the reasoning
-- written down beside it.
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
  --
  -- ⚠️ THE STREAK IS COMPARED WITH >=, NOT =, AND THE ASYMMETRY IS THE POINT.
  -- p_entitlement was computed by claimBudget() as base + earnedBonus(streak),
  -- and earnedBonus is monotonic non-decreasing in the streak. So a streak that
  -- has only GROWN since the route read it means the figure we were handed is a
  -- valid lower bound on what they are really entitled to — admitting it is
  -- safe. A streak that has SHRUNK means a claim landed and zeroed it, so the
  -- figure may be an overestimate: that is the race this guard exists for, and
  -- it is still refused.
  --
  -- With = it was harmless only because 0137 never incremented the column.
  -- 0142 makes it count every delivery, so = would refuse a swap whenever an
  -- ordinary lead happened to land between the page loading and the operator
  -- pressing the button — a refusal they caused nothing and could not act on.
  update public.customers
    set quality_claims_this_cycle = quality_claims_this_cycle + 1,
        clean_leads_streak        = 0,
        updated_at                = now()
    where id = p_customer_id
      and quality_claims_this_cycle = p_claims_seen
      and clean_leads_streak        >= p_streak_seen
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
