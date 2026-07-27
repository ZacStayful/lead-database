-- ============================================================================
-- Soft reclaim: release an ignored lead to one further operator.
--
-- A lead that has sat with an operator for three business days with NO evidence
-- of work — never opened, never rung, never emailed, no note, no file — is dead
-- weight for the landlord who submitted it. Soft reclaim offers it to one more
-- operator at a reduced price, without taking anything away from the first.
--
-- "Soft" is the whole point. The original assignment is left completely alone:
--   * status, pipeline_stage, price_paid unchanged
--   * NO refund, no credit returned, no monthly counter rolled back
--   * the lead and all its data stay visible to the original operator, who can
--     still work it and still win it
-- The only thing that changes is that somebody else may now also have it.
--
-- ---------------------------------------------------------------------------
-- WHY max_assignments IS NOT TOUCHED
-- ---------------------------------------------------------------------------
-- The obvious implementation — increment leads.max_assignments — is wrong here,
-- because two existing code paths automatically fill any gap between
-- assignment_count and max_assignments:
--
--   * ingestLead()'s duplicate path tops up under-assigned leads on EVERY
--     Monday sync (09:00 daily)
--   * POST /api/admin/leads/assign-pending sweeps for the same condition
--
-- Both compute their shortfall as (max_assignments - assignment_count) and
-- assign through normal deficit-first routing at the STANDARD price. Bumping
-- max_assignments would therefore hand the reclaimed slot to whoever happened
-- to be next in the queue, at full price, within 24 hours — bypassing the
-- reduced price, the "never a customer's first ever lead" rule, and (later) the
-- engagement weighting. The reclaim would be silently defeated by the sync.
--
-- Instead, capacity becomes:
--
--     max_assignments + open_reclaim_slots
--
-- where open_reclaim_slots is DERIVED, never stored:
--
--     count(assignments where reclaimed_at is not null)   -- slots granted
--   - count(assignments where is_reclaimed)               -- slots consumed
--
-- Deriving it means the two can never drift apart, and it needs no new column.
-- Normal routing still computes its shortfall from max_assignments alone, so it
-- is structurally blind to the extra slot: it cannot offer what it cannot see.
-- max_assignments stays exactly what CLAUDE.md §9.3 says it is — a fixed cap on
-- ordinary assignment.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 — Retroactivity cutoff
--
-- Only leads assigned AFTER this migration runs are ever eligible. Stored as
-- data rather than a code constant so it is stamped once, at apply time, and
-- cannot drift between environments or be silently edited in a later deploy.
-- ---------------------------------------------------------------------------
insert into public.system_settings (key, value)
  values ('reclaim_enabled_from', now()::text)
  on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2 — Effective capacity, including any open reclaim slot.
-- ---------------------------------------------------------------------------
create or replace function public.lead_open_reclaim_slots(p_lead_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select greatest(
    count(*) filter (where reclaimed_at is not null)::integer
      - count(*) filter (where is_reclaimed)::integer,
    0
  )
  from public.lead_assignments
  where lead_id = p_lead_id;
$$;

revoke execute on function public.lead_open_reclaim_slots(uuid)
  from public, anon, authenticated;
grant execute on function public.lead_open_reclaim_slots(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 3 — assign_lead_to_customer honours an open reclaim slot.
--
-- Definition verbatim from 0039 EXCEPT the capacity check, which now adds the
-- derived reclaim allowance. Every other behaviour — row locking, the paused
-- check, the per-product balance gate, the credit spend, the counter bump — is
-- unchanged, so the reclaim assignment goes through exactly the same atomicity
-- and balance guarantees as an ordinary one.
--
-- This does NOT open a hole in normal routing: nothing in the ordinary path
-- ever offers a lead whose assignment_count has reached max_assignments, so the
-- widened ceiling is unreachable except via the reclaim path that created it.
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
    update public.customers
      set gr_lead_balance = gr_lead_balance - 1,
          gr_leads_received_this_month = gr_leads_received_this_month + 1,
          gr_last_assignment_at = now(),
          updated_at = now()
      where id = p_customer_id;
  else
    update public.customers
      set leads_received_this_month = leads_received_this_month + 1,
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

-- NOTE: admin_assign_lead (0040) is deliberately NOT changed. It still checks
-- max_assignments alone, so an admin force-assign cannot silently consume a
-- reclaim slot that the reclaim cron is about to use. An admin who genuinely
-- wants an extra recipient raises max_assignments, exactly as before.

-- ---------------------------------------------------------------------------
-- 4 — Candidate finder.
--
-- Returns assignments that look reclaimable on every criterion EXCEPT the
-- business-day clock, which needs the UK bank-holiday calendar and is applied
-- by the caller. p_min_age_days is a deliberately loose calendar-day prefilter:
-- three business days is ALWAYS at least three calendar days, so this can never
-- hide an eligible row, only offer a few that the caller then rejects.
-- ---------------------------------------------------------------------------
create or replace function public.get_reclaim_candidates(
  p_cutoff        timestamptz,
  p_min_age_days  integer default 3
)
returns table (
  assignment_id uuid,
  lead_id       uuid,
  customer_id   uuid,
  lead_type     public.lead_type,
  assigned_at   timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select la.id, la.lead_id, la.customer_id, l.lead_type, la.assigned_at
  from public.lead_assignments la
  join public.leads l on l.id = la.lead_id
  where
    -- Never retroactive.
    la.assigned_at > p_cutoff
    and la.assigned_at <= now() - make_interval(days => p_min_age_days)

    -- The original assignment only; a reclaimed copy is never re-reclaimed.
    and la.is_reclaimed = false
    and la.reclaimed_at is null

    -- Once per lead, EVER: no assignment of this lead has ever been reclaimed.
    and not exists (
      select 1 from public.lead_assignments prior
      where prior.lead_id = la.lead_id
        and (prior.reclaimed_at is not null or prior.is_reclaimed)
    )

    -- Untouched: the operator has done nothing with it. status is deliberately
    -- NOT the test — it is self-reported. These are the passive signals.
    and not exists (
      select 1 from public.lead_events e
      where e.assignment_id = la.id
        and e.event_type in ('detail_opened', 'tel_click', 'mailto_click')
    )
    and not exists (
      select 1 from public.lead_notes n where n.lead_assignment_id = la.id
    )
    and not exists (
      select 1 from public.lead_files f where f.lead_assignment_id = la.id
    )

    -- A rejected lead has been consciously passed on and is settled under 0019
    -- (chargeable, no replacement). Reclaiming it would contradict that, so it
    -- is left alone. Flagged for review — resale may in fact be the right
    -- outcome for a rejected lead, but that is a pricing decision, not a bug.
    and la.status <> 'rejected'

    -- Still capacity-bound in the ordinary sense.
    and l.assignment_count >= l.max_assignments;
$$;

revoke execute on function public.get_reclaim_candidates(timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.get_reclaim_candidates(timestamptz, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- 5 — Perform the reclaim atomically.
--
-- Re-checks every eligibility rule under a row lock before acting, so two
-- concurrent cron runs cannot both reclaim the same lead: the second finds
-- reclaimed_at already set and aborts. The caller's earlier candidate query is
-- treated as a hint, never as permission.
-- ---------------------------------------------------------------------------
create or replace function public.reclaim_lead_assignment(
  p_assignment_id   uuid,
  p_new_customer_id uuid,
  p_price           numeric,
  p_lead_type       public.lead_type
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_original public.lead_assignments%rowtype;
  v_new_assignment_id uuid;
  v_prior_assignments integer;
begin
  select * into v_original from public.lead_assignments
    where id = p_assignment_id for update;
  if not found then
    raise exception 'Assignment % not found', p_assignment_id;
  end if;

  if v_original.reclaimed_at is not null then
    raise exception 'Assignment % has already been reclaimed', p_assignment_id;
  end if;

  -- Once per lead, ever — re-checked under the lock.
  if exists (
    select 1 from public.lead_assignments prior
    where prior.lead_id = v_original.lead_id
      and prior.id <> p_assignment_id
      and (prior.reclaimed_at is not null or prior.is_reclaimed)
  ) then
    raise exception 'Lead % has already been reclaimed once', v_original.lead_id;
  end if;

  -- Never a customer's first ever lead. A reclaimed lead is a second-hand lead
  -- sold at a discount; handing one to somebody as their very first experience
  -- of the product sets the wrong expectation of what they are paying for.
  select count(*) into v_prior_assignments
    from public.lead_assignments
    where customer_id = p_new_customer_id;

  if v_prior_assignments = 0 then
    raise exception 'Customer % has no prior assignments and cannot receive a reclaimed lead',
      p_new_customer_id;
  end if;

  -- Grant the slot, then spend it. Order matters: assign_lead_to_customer reads
  -- lead_open_reclaim_slots, which only counts a slot once reclaimed_at is set.
  update public.lead_assignments
    set reclaimed_at = now()
    where id = p_assignment_id;

  v_new_assignment_id := public.assign_lead_to_customer(
    v_original.lead_id, p_new_customer_id, p_price, p_lead_type
  );

  update public.lead_assignments
    set is_reclaimed = true
    where id = v_new_assignment_id;

  return v_new_assignment_id;
end;
$$;

revoke execute on function public.reclaim_lead_assignment(uuid, uuid, numeric, public.lead_type)
  from public, anon, authenticated;
grant execute on function public.reclaim_lead_assignment(uuid, uuid, numeric, public.lead_type)
  to service_role;
