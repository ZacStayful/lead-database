-- ==========================================================================
-- 0114 — A NEW FILTER STARTS DELIVERING NOW, NOT AT THE NEXT RENEWAL
-- ==========================================================================
--
-- Applying a filter has always been instant (0026): the apply route writes
-- filter_status = 'active' and get_filtered_candidates_for_lead honours it on
-- the very next lead ingested. What is NOT instant is SUPPLY.
--
-- (gr_)lead_balance is the allocation gate (invariant 1). It is spent one
-- credit per assignment and topped up only by credit_invoice on invoice.paid.
-- A customer who has consumed this cycle's credits therefore receives nothing
-- — filtered or not — until renewal, and applying a filter mid-cycle looks to
-- them exactly like a filter that "activates on billing cycles". The apply
-- route makes it slightly worse: a fresh enable clamps the balance to
-- min(balance, allocation), so applying a filter can only ever REDUCE what is
-- left to spend.
--
-- The leads that customer is already holding are the missing credits. If they
-- have not been touched, they are inventory in the wrong place: charged to
-- somebody who has just told us they do not want that kind of lead, and
-- invisible to the operators who do.
--
-- So at the moment a filter is applied, the customer is asked what should
-- happen to the leads they already hold. Untouched leads that do NOT match the
-- new filter can go back into the pool, their credits refunded, and the filter
-- starts delivering during this cycle instead of after it.
--
-- ---------------------------------------------------------------------------
-- §1 — WHAT "INSTANT" MEANS HERE, AND WHAT IT DOES NOT
-- ---------------------------------------------------------------------------
-- It means the FILTERED FLOW STARTS NOW. It is not a lead-for-lead swap, and
-- nothing here promises a replacement for each lead returned. The customer is
-- knowingly trading unused stock for the chance of leads they actually want,
-- as those leads arrive. Their consent to exactly that is what the apply
-- confirmation captures.
--
-- Two consequences, both deliberate:
--
--   * NO SYNCHRONOUS RE-OFFER. A released lead simply drops back under its
--     max_assignments cap and is redistributed by the ordinary machinery —
--     CLAUDE.md §4: "each daily sync re-offers them, and they place as cycles
--     reset... Banked leads are inventory, not a backlog." Nothing in the
--     apply path calls autoAssignLead in a loop. That would be the
--     like-for-like swap this feature is explicitly not.
--   * NO STOCK GUARANTEE. Nothing here counts or promises how many matching
--     leads are in the book right now. The volume forecast the customer
--     already acknowledges (§28) is the one expectation we set; a second one
--     would be a promise we have not modelled.
--
-- ---------------------------------------------------------------------------
-- §2 — THE RULE, AND WHY IT IS NARROWER THAN THE BRIEF
-- ---------------------------------------------------------------------------
-- A lead is releasable only if the customer has NOT TOUCHED it AND it FAILS
-- the filter being applied. Discard and Keep differ only in how many of those
-- we take (the route decides; this migration just caps at p_max).
--
-- The brief asked, for the keep-at-quota case, that the forecast number be
-- taken back from the existing allocation without qualification. Restricting
-- it to NON-MATCHING leads is a deliberate narrowing, and it is what keeps
-- this migration out of the routing engine entirely:
--
--   Every candidate function excludes customers who already hold the lead via
--   `not exists (select 1 from lead_assignments ...)`. Releasing DELETES that
--   row, so the exclusion goes with it. A released lead that MATCHED the
--   filter could therefore be re-offered straight back to the same customer,
--   who would spend the refunded credit on the lead they had just given up.
--   Avoiding that otherwise means an exclusion table consulted by three
--   privileged predicates — see §4.
--
-- Restricting releases to non-matching leads makes the customer's own active
-- filter the exclusion mechanism, for free.
--
-- ---------------------------------------------------------------------------
-- §3 — ⚠️  A NARROW, DELIBERATE EXCEPTION TO INVARIANT 4
-- ---------------------------------------------------------------------------
-- "Every delivered lead is chargeable. Reject does not refund." (0019, and
-- CLAUDE.md §9.4.) release_unmatched_assignments refunds. That is allowed here
-- and nowhere else, because the lead is being UNDELIVERED rather than kept and
-- refunded: withdrawn unworked, at the customer's own request, and returned to
-- stock for somebody else to buy. Nothing about the delivery survives — the
-- assignment row is deleted, the slot reopens, and the lead is sold again at
-- full price.
--
-- THE UNTOUCHED PREDICATE IS WHAT MAKES THAT CLAIM TRUE. It must never be
-- loosened. Every clause in releasable_filter_assignments below is load-
-- bearing: weaken one and this becomes a refund on a lead somebody worked,
-- which is precisely what 0019 exists to forbid.
--
-- ---------------------------------------------------------------------------
-- §4 — NO PRIVILEGED FUNCTION IS REDEFINED, AND THE GAP THAT LEAVES
-- ---------------------------------------------------------------------------
-- get_filtered_candidates_for_lead, get_unfiltered_candidates_for_lead,
-- get_next_customers_for_lead, customer_can_see_pool_lead,
-- get_escalation_candidates, assign_lead_to_customer and credit_invoice are
-- ALL untouched by this migration. That is the payoff for §2, and it is what
-- lets a reviewer confirm the blast radius by inspection (CLAUDE.md §11, the
-- ACL trap: a create-or-replace discards the function's grants, which is the
-- 0049 lesson).
--
-- The known gap that leaves, accepted with reasons:
--
--   Deleting the assignment removes the "already holds it" guard. While the
--   filter is ACTIVE the released lead fails it, so nothing happens. But a
--   LIFT sets filter_status = 'off', and the lead becomes eligible for that
--   customer again — through routing, and through the pool.
--
--   Accepted, because: a lift is deferred to renewal (0026), so the window
--   opens a month away at the earliest, by which time the lead is usually
--   sold, pooled or expired; a customer who has lifted is asking for any lead
--   again; they would pay full price; and they never opened it. Closing it
--   means create-or-replace on three privileged predicates for a benign
--   outcome. filter_lead_releases below records every release, so if this ever
--   becomes a real complaint the fix is a one-clause addition to those three
--   and the data to prove it is already there.
--
-- ---------------------------------------------------------------------------
-- §5 — DELETING THE ROW IS ONLY SAFE BECAUSE OF 0060
-- ---------------------------------------------------------------------------
-- notifications.lead_assignment_id was created with the default NO ACTION, so
-- deleting an assignment that had ever produced a notification raised a
-- foreign-key violation. 0060 changed it to ON DELETE CASCADE. Every release
-- here deletes an assignment that HAS produced a new-lead notification, so
-- 0060 is a hard dependency of this migration. Do not revert it.
--
-- Re-runnable: every statement is guarded.
-- ==========================================================================


-- ---------------------------------------------------------------------------
-- 1 — filter_lead_releases: what went back, and why
--
-- Modelled on filter_forecast_acknowledgements (0100 §5): RLS ENABLED WITH NO
-- POLICY, which is deny-all to anon/authenticated and a no-op for the service
-- role. Best-effort audit only — NOTHING reads this table to decide anything.
-- Live state is the absence of the lead_assignments row, never this.
--
-- It exists to answer "why did this lead leave my dashboard?" for a customer
-- who has forgotten, and to make §4's accepted gap measurable if it ever
-- stops being acceptable.
-- ---------------------------------------------------------------------------
create table if not exists public.filter_lead_releases (
  id                  uuid primary key default gen_random_uuid(),
  customer_id         uuid not null references public.customers(id) on delete cascade,
  lead_id             uuid references public.leads(id) on delete set null,
  lead_type           public.lead_type not null,
  -- 'discard'       — the customer chose to put non-matching leads back.
  -- 'quota_refill'  — they chose to keep, but their credits were spent, so the
  --                   forecast number was freed to make the filter deliverable.
  mode                text not null,
  credit_refunded     boolean not null default true,
  price_paid          numeric,
  -- The filter that was in force at the moment of release. Stored rather than
  -- read back from customers, which changes on the next apply.
  areas               text[],
  min_bedrooms        integer,
  max_bedrooms        integer,
  released_at         timestamptz not null default now()
);

-- lead_id is ON DELETE SET NULL, not CASCADE: an admin purging a lead must not
-- erase the record that we refunded somebody for it.

alter table public.filter_lead_releases
  drop constraint if exists filter_lead_releases_mode_check;
alter table public.filter_lead_releases
  add constraint filter_lead_releases_mode_check
  check (mode in ('discard', 'quota_refill'));

create index if not exists idx_filter_lead_releases_customer
  on public.filter_lead_releases (customer_id, lead_type);

alter table public.filter_lead_releases enable row level security;

comment on table public.filter_lead_releases is
  'Leads returned to the pool when a customer applied a lead filter, and the credit refunded for each. Best-effort audit trail: LIVE state is the absence of the lead_assignments row, never this table. Nothing reads it to decide anything.';


-- ---------------------------------------------------------------------------
-- 2 — releasable_filter_assignments: what COULD go back
--
-- Read-only. Answers "which of this customer's held leads are untouched and
-- would fail the filter they are about to apply".
--
-- ⚠️ IT TAKES THE PROPOSED CRITERIA AS ARGUMENTS, and that is the whole reason
-- it exists. lead_matches_customer_filter (0074) reads the STORED
-- customers.(gr_)filter_* columns, so it cannot answer a question about a
-- filter that has not been saved yet — and the customer has to be asked BEFORE
-- it is saved, because the answer decides what we do next.
--
-- The matching arm below is therefore a deliberate second copy of that
-- predicate's semantics, not an accident: same area rule (empty selection
-- matches everything), same bedroom bounds, and the same rule that a lead
-- whose postcode area or bedroom count will not parse matches NO filtered
-- customer. Keep the two in step — if 0074's predicate ever changes, this
-- changes with it, or the preview and the routing disagree about what the
-- customer selected.
-- ---------------------------------------------------------------------------
create or replace function public.releasable_filter_assignments(
  p_customer_id   uuid,
  p_lead_type     public.lead_type,
  p_areas         text[],
  p_min_bedrooms  integer,
  p_max_bedrooms  integer
)
returns table (
  assignment_id uuid,
  lead_id       uuid,
  postcode_area text,
  bedrooms      text,
  assigned_at   timestamptz,
  price_paid    numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    la.id,
    l.id,
    l.postcode_area,
    l.bedrooms,
    la.assigned_at,
    la.price_paid
  from public.lead_assignments la
  join public.leads l on l.id = la.lead_id
  where la.customer_id = p_customer_id
    and l.lead_type = p_lead_type

    -- ---------------------------------------------------------------------
    -- UNTOUCHED. Every clause here is load-bearing (§3) — this is what makes
    -- the refund an undelivery rather than a refund on worked-for value.
    -- ---------------------------------------------------------------------
    and la.viewed_at is null              -- never expanded the card
    and la.status = 'new'                 -- never contacted, won, rejected, closed
    and la.pipeline_stage = 'cold'        -- nothing built on it
    -- Reported as done — the landlord said no, or sorted it elsewhere (0067).
    -- `status = 'new'` already excludes this, because closing sets
    -- 'not_relevant', but closing is somebody having WORKED the lead and this
    -- predicate is the whole basis for calling the refund an undelivery (§3).
    -- Stating it outright costs nothing and survives a future close path that
    -- leaves status alone.
    and la.closed_at is null
    -- §19.6: a pool claim must never reopen its slot. discard_lead_assignment
    -- sets pool_expired_at instead of decrementing for exactly this reason;
    -- rather than reproduce that branch, a claimed lead is simply not
    -- releasable. The customer rang the landlord before keeping it, which is
    -- the opposite of untouched anyway.
    and la.claimed_from_pool_at is null
    and not exists (
      select 1 from public.lead_notes n where n.lead_assignment_id = la.id
    )
    and not exists (
      select 1 from public.lead_files f where f.lead_assignment_id = la.id
    )
    -- Any operator-generated telemetry at all. nudge_sent is EXCLUDED for the
    -- usual reason (CLAUDE.md §3): it is system-generated, and counting it
    -- would lock exactly the leads nobody has touched — the ones this feature
    -- exists to recover.
    and not exists (
      select 1 from public.lead_events e
      where e.assignment_id = la.id and e.event_type <> 'nudge_sent'
    )

    -- ---------------------------------------------------------------------
    -- NOT SOMEBODY ELSE'S TO GIVE BACK.
    -- ---------------------------------------------------------------------
    -- A lead the customer added themselves (§30). Releasing it would return
    -- their own lead to the marketplace and refund them for it.
    and l.owner_customer_id is null
    -- ⚠️ A lead an admin WITHDREW on a swap (0059). The swap withdraws it by
    -- clamping max_assignments DOWN to assignment_count, so every selection
    -- path skips it. Releasing another holder's copy decrements
    -- assignment_count while the clamp stays put — which puts the lead back
    -- UNDER its cap and hands a deliberately-withdrawn lead straight back into
    -- ordinary routing. Barring it here is cheaper and safer than re-clamping
    -- after the fact.
    and l.withdrawn_at is null

    -- ---------------------------------------------------------------------
    -- FAILS THE PROPOSED FILTER. An unparseable postcode area or bedroom
    -- count matches no filtered customer (0026/0074), so such a lead FAILS
    -- and is releasable.
    -- ---------------------------------------------------------------------
    and not (
      l.postcode_area is not null
      and nullif(substring(coalesce(l.bedrooms, '') from '\d+'), '')::int is not null
      and (
        p_areas is null
        or array_length(p_areas, 1) is null
        or l.postcode_area = any (p_areas)
      )
      and (
        p_min_bedrooms is null
        or nullif(substring(coalesce(l.bedrooms, '') from '\d+'), '')::int >= p_min_bedrooms
      )
      and (
        p_max_bedrooms is null
        or nullif(substring(coalesce(l.bedrooms, '') from '\d+'), '')::int <= p_max_bedrooms
      )
    )
  -- Stalest first, so a partial release (the keep-at-quota case) gives back
  -- the leads that have sat longest rather than the ones that just arrived.
  order by la.assigned_at asc, la.id asc;
$$;

revoke execute on function public.releasable_filter_assignments(
  uuid, public.lead_type, text[], integer, integer
) from public, anon, authenticated;
grant execute on function public.releasable_filter_assignments(
  uuid, public.lead_type, text[], integer, integer
) to service_role;


-- ---------------------------------------------------------------------------
-- 3 — release_unmatched_assignments: put them back
--
-- The mutation, and the money. Locks the customer row first, then works
-- against the CURRENT stored filter — so the caller MUST have written the new
-- criteria to customers before calling this, or it will measure the old
-- filter. That ordering is asserted in the route and restated here because it
-- is the one way to get this wrong silently.
--
-- p_max caps the release. The route always passes a number.
--
-- p_clamp_to_allocation folds in the apply route's balance clamp
-- (min(balance, allocation) on a fresh enable). It moves here because doing it
-- in TypeScript is a blind read-modify-write: the route reads the balance at
-- request start and writes back a value computed from it, so a concurrent
-- ingest spending a credit in between is silently reverted. Under this row
-- lock, with the refund in the same transaction, it cannot be.
-- ---------------------------------------------------------------------------
create or replace function public.release_unmatched_assignments(
  p_customer_id           uuid,
  p_lead_type             public.lead_type,
  p_max                   integer,
  p_mode                  text,
  p_clamp_to_allocation   boolean default false
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer   public.customers%rowtype;
  v_areas      text[];
  v_min        integer;
  v_max        integer;
  v_allocation integer;
  v_released   integer := 0;
  r            record;
begin
  if p_mode is null or p_mode not in ('discard', 'quota_refill') then
    raise exception 'Unknown release mode %', p_mode;
  end if;

  select * into v_customer from public.customers
    where id = p_customer_id for update;
  if not found then
    raise exception 'Customer % not found', p_customer_id;
  end if;

  -- Read the filter that is now in force, per product (invariant 6).
  if p_lead_type = 'guaranteed_rent' then
    v_areas      := v_customer.gr_filter_areas;
    v_min        := v_customer.gr_filter_min_bedrooms;
    v_max        := v_customer.gr_filter_max_bedrooms;
    v_allocation := coalesce(v_customer.gr_monthly_allocation, 0);
  else
    v_areas      := v_customer.filter_areas;
    v_min        := v_customer.filter_min_bedrooms;
    v_max        := v_customer.filter_max_bedrooms;
    v_allocation := coalesce(v_customer.monthly_allocation, 0);
  end if;

  -- The fresh-enable clamp, under the lock. Applied BEFORE the refunds below,
  -- so a customer never has credits confiscated that they were just given back
  -- for leads they returned in this same call.
  if p_clamp_to_allocation then
    if p_lead_type = 'guaranteed_rent' then
      update public.customers
        set gr_lead_balance = least(coalesce(gr_lead_balance, 0), v_allocation),
            updated_at = now()
        where id = p_customer_id;
    else
      update public.customers
        set lead_balance = least(coalesce(lead_balance, 0), v_allocation),
            updated_at = now()
        where id = p_customer_id;
    end if;
  end if;

  -- ⚠️ The early return sits HERE, below the clamp, not at the top. A fresh
  -- enable has always clamped the balance to the allocation, and the route
  -- skips this RPC when there is nothing to release — so returning early on
  -- p_max = 0 before the clamp would quietly drop that behaviour for every
  -- customer with no releasable leads. Clamp first, then decide there is
  -- nothing to do.
  if p_max is null or p_max <= 0 then
    return 0;
  end if;

  for r in
    select *
    from public.releasable_filter_assignments(
      p_customer_id, p_lead_type, v_areas, v_min, v_max
    )
    limit p_max
  loop
    -- Same disposal as discard_lead_assignment: the row goes. Every existing
    -- reader — dashboard, analytics, admin, exports, leaderboard, engagement
    -- scoring, the public API — then behaves exactly as it does for a discard,
    -- with no change anywhere. Notes and files would cascade; the untouched
    -- predicate guarantees there are none. Notifications cascade thanks to
    -- 0060 (§5) — without it this DELETE raises a foreign-key violation.
    delete from public.lead_assignments where id = r.assignment_id;

    -- Reopen the slot so ordinary redistribution can place it (§4 of
    -- CLAUDE.md). No re-offer happens here; the daily sync and
    -- /api/admin/leads/assign-pending do that.
    update public.leads
      set assignment_count = greatest(assignment_count - 1, 0)
      where id = r.lead_id;

    -- The refund. Exactly the shape 0017 used before 0019 withdrew it from
    -- reject: give the credit back and roll the pacing counter back with it,
    -- mirroring the spend assign_lead_to_customer made. Rolling the counter
    -- back matters as much as the credit — leaving it would read the customer
    -- as having received leads they no longer hold, and the deficit-first
    -- router would deprioritise them for the rest of the cycle.
    --
    -- (gr_)pool_debit is deliberately NOT touched: invariant 12 settles it
    -- only inside credit_invoice. management_lifetime_leads_received is not
    -- touched either — invariant 9, it only ever counts up.
    if p_lead_type = 'guaranteed_rent' then
      update public.customers
        set gr_lead_balance = coalesce(gr_lead_balance, 0) + 1,
            gr_leads_received_this_month =
              greatest(coalesce(gr_leads_received_this_month, 0) - 1, 0),
            updated_at = now()
        where id = p_customer_id;
    else
      update public.customers
        set lead_balance = coalesce(lead_balance, 0) + 1,
            leads_received_this_month =
              greatest(coalesce(leads_received_this_month, 0) - 1, 0),
            updated_at = now()
        where id = p_customer_id;
    end if;

    insert into public.filter_lead_releases (
      customer_id, lead_id, lead_type, mode, credit_refunded,
      price_paid, areas, min_bedrooms, max_bedrooms
    ) values (
      p_customer_id, r.lead_id, p_lead_type, p_mode, true,
      r.price_paid, v_areas, v_min, v_max
    );

    v_released := v_released + 1;
  end loop;

  return v_released;
end;
$$;

revoke execute on function public.release_unmatched_assignments(
  uuid, public.lead_type, integer, text, boolean
) from public, anon, authenticated;
grant execute on function public.release_unmatched_assignments(
  uuid, public.lead_type, integer, text, boolean
) to service_role;
