-- ==========================================================================
-- 0146 — A REPLACEMENT FOR A REPLACEMENT GOES TO A PERSON
-- ==========================================================================
--
-- §53's Deferred list carried this: "Replacement-of-a-replacement is unbounded
-- except by the counter. The new assignment carries a null quality_claim_id,
-- so it can itself be reported. Acceptable at two a cycle; worth watching if
-- the entitlement ever rises."
--
-- The entitlement can now be raised from a form — §51.11 put
-- quality_allowance_pct on AdminCustomerForm — so "worth watching" stopped
-- being good enough. This bounds it.
--
-- ---------------------------------------------------------------------------
-- §1 — WHAT A CHAIN IS, AND WHY IT IS NOT A REFUSAL
-- ---------------------------------------------------------------------------
-- Report lead A, take replacement B, report B, take C. Each step spends one
-- entitlement, so it is bounded today at two or four a cycle — but every step
-- costs TWO leads of stock (§52.1: the replacement handed over, and the
-- reported lead withdrawn by the clamp), and nothing anywhere recorded that B
-- had arrived as a replacement at all.
--
-- ⚠️ THE ANSWER IS REVIEW, NEVER A REFUSAL, and that is settled rather than
-- new. §51.3 already argues it for the allowance: an operator receiving
-- genuinely dead leads is exactly who would exceed a budget, so refusing them
-- automatically punishes the customer the feature exists for. The same holds
-- here with more force. If we handed somebody a dead replacement, they are
-- owed another one — what they are not owed is a SECOND one decided by nobody.
--
-- Two dead landlords on one paid slot is a sourcing failure, and §51.8 says
-- the queue exists precisely to find those. Routing the second one to a person
-- is how it gets seen instead of quietly papered over.
--
-- ---------------------------------------------------------------------------
-- §2 — ⚠️ A STORED DEPTH, BECAUSE THE CHAIN IS NOT DERIVABLE
-- ---------------------------------------------------------------------------
-- The obvious alternative is to derive it: lead_quality_claims carries
-- replacement_assignment_id and origin_assignment_id, so a recursive join can
-- walk a chain, and 0139 guarantees those rows are never deleted.
--
-- It does not work, and the reason is specific rather than a preference about
-- joins. THE PLAIN ADMIN SWAP WRITES NO CLAIM AT ALL:
-- /api/admin/assignments/[id]/swap calls admin_swap_lead_assignment directly
-- to replace a lead for any support reason, and only the two claim-settling
-- callers (0139, 0141) ever insert a lead_quality_claims row. So a chain that
-- passes through one plain admin swap is invisible to any claims-based
-- derivation — and that is exactly the shape somebody replacing a lead by hand
-- for a customer produces.
--
-- A column on the assignment sees every chain, because there is exactly one
-- insert of a replacement assignment in the schema and all three callers go
-- through it. Same denormalise-to-survive move 0116 makes for lead_messages,
-- 0138 for lead_outcome_reasons and 0139 for origin_assignment_id.
--
-- ---------------------------------------------------------------------------
-- §3 — ⚠️ NOT NULL DEFAULT 0, WHICH LOOKS INCONSISTENT WITH 0145 AND IS NOT
-- ---------------------------------------------------------------------------
-- 0145 made withdrawn_slots NULLABLE and argued at length that a pre-0145 row
-- must be INVISIBLE rather than counted as zero, because a zero there asserts
-- "that swap cost nothing" — which is false and is the one misreading the
-- column exists to prevent.
--
-- This column takes the opposite decision, for a reason that only looks like
-- the same question. A zero here asserts "this assignment did not arrive as a
-- replacement", which is TRUE for essentially the whole book: production holds
-- 514 assignments, ZERO claims of any kind, and 8 leads ever withdrawn — so at
-- most 8 assignments are genuinely depth 1 and will read 0.
--
-- They cannot be identified: the outgoing assignment was deleted, and with no
-- claim rows there is nothing naming who held it. So the choice is a default
-- of 0 or a null that every reader must interpret — and interpreting null as
-- "route to review" would send EVERY pre-0146 assignment to a person, which
-- breaks the feature for the entire book to be careful about at most eight
-- rows.
--
-- The error is therefore bounded at 8, PERMISSIVE (one more automatic swap
-- than intended, on a slot the operator is arguably owed one for anyway), and
-- self-clearing: the claim window is 14 days, so it is gone in a fortnight.
--
-- ---------------------------------------------------------------------------
-- §4 — WHAT THIS MIGRATION DOES NOT DO
-- ---------------------------------------------------------------------------
-- It does not decide anything. The column is written here and read in
-- TypeScript by decideDeadLeadClaim, which is where §51.7 puts the allowance
-- and the peer rules for the reason it gives: arithmetic worth unit-testing
-- directly rather than through a route. Eligibility is untouched —
-- claimable_dead_lead_assignments still returns a chained assignment, because
-- it IS claimable; what changes is that settling it needs a person.
--
-- So this migration is inert until the code ships, and the code is safe to
-- ship late: without it every depth reads 0 and behaviour is exactly today's.
-- ==========================================================================


-- ---------------------------------------------------------------------------
-- 1 — The column
-- ---------------------------------------------------------------------------

alter table public.lead_assignments
  add column if not exists replacement_depth integer not null default 0;

alter table public.lead_assignments
  drop constraint if exists lead_assignments_replacement_depth_check;
alter table public.lead_assignments
  add constraint lead_assignments_replacement_depth_check
  check (replacement_depth >= 0);

comment on column public.lead_assignments.replacement_depth is
  'How many replacements deep this slot is. 0 is a lead delivered by ordinary '
  'routing, an admin force-assign or a pool claim; 1 is the replacement for a '
  'reported lead, 2 the replacement for that, and so on. Written only by '
  'admin_swap_lead_assignment, from the locked pre-image of the outgoing '
  'assignment. Rows predating 0146 read 0 whether or not they arrived as a '
  'replacement — see that migration on why a default beats a null here and '
  'the opposite was right for leads.withdrawn_slots.';


-- ---------------------------------------------------------------------------
-- 2 — The one insert of a replacement assignment stamps the depth
--
-- 0145's body verbatim with ONE column added to the existing insert. Nothing
-- else moves: the retirement guard, the filter guard, the owner checks, the
-- lock order, the clamp and the withdrawal cost are all untouched.
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
  -- 0146. How many replacements deep this slot now is.
  --
  -- ⚠️ READ FROM v_old, THE LOCKED PRE-IMAGE, and it has to be: the outgoing
  -- assignment was DELETED four statements ago, so there is nothing left to
  -- read it from. 0145 states the same rule one migration earlier for
  -- withdrawn_slots, where the row survived and only the value had moved;
  -- here the row is gone entirely, so this is mandatory rather than merely
  -- correct.
  --
  -- This is the single insert of a replacement assignment for ALL THREE swap
  -- callers — the plain admin swap, resolve_dead_lead_claim_with_swap (0139)
  -- and customer_swap_dead_lead (0141) — which is why the depth lives here and
  -- not in any of them.
  insert into public.lead_assignments
    (lead_id, customer_id, price_paid, replacement_depth)
    values (p_new_lead_id, v_old.customer_id, v_old.price_paid,
            coalesce(v_old.replacement_depth, 0) + 1)
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
