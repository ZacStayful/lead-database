-- ===========================================================================
-- 0138 — A reason on every outcome, an owner bar on the report, and the last
--        of the orphaned reject columns
--
-- §51 gave an operator a way to report a lead that was dead on arrival, and it
-- records why: a reason, the landlord's own words, and the date they spoke.
-- The other three exits record almost nothing. Reject records NO reason at all,
-- discard records none, and close records one of two coarse options. On today's
-- book that is 25 rejected and 30 closed assignments that ended with no account
-- of why — which is exactly the dataset that would say which sources produce
-- leads that go nowhere.
--
-- This migration does three things:
--
--   1. lead_outcome_reasons — one row per recorded outcome, in a table of its
--      own BECAUSE DISCARD DELETES THE ASSIGNMENT ROW. §13 records the same
--      trap for the lifetime odometer: it "cannot count leads that were
--      delivered and later discarded, because discard deletes the row". A
--      reason column on lead_assignments would die with the thing it explains,
--      and discard is one of the two outcomes recording nothing today.
--
--   2. The reason travels as a PARAMETER to the function that performs the
--      outcome, so it lands in the same transaction. A reason written beside
--      the outcome is a reason that goes missing exactly when the outcome
--      succeeded.
--
--   3. claimable_dead_lead_assignments gains an owner bar, and the three
--      orphaned reject columns and their function are dropped.
--
-- Nothing here changes a balance, a counter, pacing or capacity. The one
-- behavioural change is the owner bar, which REMOVES leads from eligibility.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1 — lead_outcome_reasons
--
-- lead_assignment_id is ON DELETE SET NULL, not cascade. That is the whole
-- point of the table: discard_lead_assignment deletes the assignment, and the
-- reason must survive it with the lead still identified. lead_messages (0116)
-- takes the same shape for the same reason.
--
-- postcode_area and bedrooms are denormalised at write time deliberately. They
-- are what the analysis groups by, and a customer-owned lead can be deleted
-- outright (§30.7), which would otherwise take the evidence with it.
-- ---------------------------------------------------------------------------
create table if not exists public.lead_outcome_reasons (
  id                  uuid primary key default gen_random_uuid(),
  customer_id         uuid not null references public.customers(id) on delete cascade,
  lead_id             uuid references public.leads(id) on delete set null,
  lead_assignment_id  uuid references public.lead_assignments(id) on delete set null,

  outcome             text not null,
  reason              text not null,
  detail              text,

  -- Copied in at write time, never joined for later.
  lead_type           public.lead_type,
  postcode_area       text,
  bedrooms            text,

  created_at          timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'lead_outcome_reasons_outcome_check'
  ) then
    alter table public.lead_outcome_reasons
      add constraint lead_outcome_reasons_outcome_check
      check (outcome in ('reject', 'discard', 'close', 'report'));
  end if;

  -- ⚠️ The vocabulary is per outcome, and the two halves must never overlap.
  --
  -- reject and discard describe the OPERATOR'S OWN FIT — the area they cover,
  -- the properties they take, the numbers, their capacity. close and report
  -- describe the LANDLORD. That split is what stops a no-refund path existing
  -- to the same sentence as the refundable one: an operator cannot reject a
  -- lead "because the landlord had already gone", because that is not on the
  -- reject list and never may be.
  --
  -- Mirrored character-for-character by src/lib/outcomeReasons.ts, and a test
  -- asserts the equality mechanically — the arrangement §29 uses for
  -- cancelOptions.ts.
  if not exists (
    select 1 from pg_constraint where conname = 'lead_outcome_reasons_reason_check'
  ) then
    alter table public.lead_outcome_reasons
      add constraint lead_outcome_reasons_reason_check
      check (
        (outcome in ('reject', 'discard') and reason in (
          'wrong_area', 'wrong_property', 'poor_numbers', 'at_capacity', 'other'
        ))
        or (outcome = 'close' and reason in (
          'not_interested', 'sorted_elsewhere'
        ))
        or (outcome = 'report' and reason in (
          'already_with_operator', 'no_longer_interested', 'unreachable'
        ))
      );
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'lead_outcome_reasons_detail_check'
  ) then
    alter table public.lead_outcome_reasons
      add constraint lead_outcome_reasons_detail_check
      check (detail is null or (length(detail) between 1 and 2000));
  end if;
end $$;

-- The analysis groups by these three. Nothing reads a single row by id.
create index if not exists lead_outcome_reasons_outcome_idx
  on public.lead_outcome_reasons (outcome, created_at desc);
create index if not exists lead_outcome_reasons_area_idx
  on public.lead_outcome_reasons (postcode_area)
  where postcode_area is not null;
create index if not exists lead_outcome_reasons_customer_idx
  on public.lead_outcome_reasons (customer_id, created_at desc);

-- Deny-all to the browser, as lead_quality_claims, subscription_pauses and
-- twenty-odd others. Every write is service-role, through the functions below.
alter table public.lead_outcome_reasons enable row level security;

-- ---------------------------------------------------------------------------
-- 2 — record_lead_outcome_reason
--
-- One writer, called from inside each outcome function so the reason and the
-- outcome share a transaction. Denormalises from the lead under the caller's
-- existing lock.
--
-- ⚠️ A NULL reason is a no-op, not an error. The old function arities are kept
-- as shims (below) so code deployed before this migration keeps working, and
-- they delegate with null. An outcome must never fail because nobody supplied
-- a reason.
-- ---------------------------------------------------------------------------
create or replace function public.record_lead_outcome_reason(
  p_customer_id   uuid,
  p_assignment_id uuid,
  p_lead_id       uuid,
  p_outcome       text,
  p_reason        text,
  p_detail        text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_reason is null or btrim(p_reason) = '' then
    return;
  end if;

  insert into public.lead_outcome_reasons (
    customer_id, lead_id, lead_assignment_id,
    outcome, reason, detail,
    lead_type, postcode_area, bedrooms
  )
  select
    p_customer_id, p_lead_id, p_assignment_id,
    p_outcome, btrim(p_reason), nullif(btrim(coalesce(p_detail, '')), ''),
    l.lead_type, l.postcode_area, l.bedrooms
  from public.leads l
  where l.id = p_lead_id;
end;
$$;

revoke execute on function public.record_lead_outcome_reason(uuid, uuid, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.record_lead_outcome_reason(uuid, uuid, uuid, text, text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 3 — reject, with a reason
--
-- ⚠️ THE NEW PARAMETERS HAVE NO DEFAULT, AND MUST NOT GAIN ONE.
--
-- A defaulted parameter creates an OVERLOAD, not a replacement, and every
-- existing two-argument call then fails with "function is not unique". This
-- repo has hit that trap twice — §34 for admin_swap_lead_assignment and §35 for
-- assign_lead_to_customer, where both functions already carried a defaulted
-- p_lead_type. The fix both sections record is the one used here: a distinct
-- arity with no default, and the old one kept as a shim.
--
-- The shim is also what makes migration-before-code safe. Applied ahead of the
-- deploy, the route still calls two arguments and rejects exactly as it does
-- today, recording no reason. That is the safe direction for the window.
--
-- The four-argument body is 0043's verbatim, plus the lead lookup the
-- denormalisation needs and the one call. Verified byte-identical to
-- production's live prosrc before it was copied (md5 9a2959f5…), the check §11
-- says not to assume.
-- ---------------------------------------------------------------------------
create or replace function public.reject_lead_assignment(
  p_assignment_id uuid,
  p_customer_id   uuid,
  p_reason        text,
  p_detail        text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead_id uuid;
begin
  update public.lead_assignments
    set status = 'rejected'
    where id = p_assignment_id
      and customer_id = p_customer_id
      and pipeline_stage = 'cold'
      and status not in ('won', 'rejected')
    returning lead_id into v_lead_id;

  if not found then
    raise exception 'Assignment not found, not owned by this customer, or not rejectable';
  end if;

  perform public.record_lead_outcome_reason(
    p_customer_id, p_assignment_id, v_lead_id, 'reject', p_reason, p_detail
  );
end;
$$;

revoke execute on function public.reject_lead_assignment(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.reject_lead_assignment(uuid, uuid, text, text)
  to service_role;

-- The original arity, delegating. Kept so a call made before the code deploys
-- still works.
create or replace function public.reject_lead_assignment(
  p_assignment_id uuid,
  p_customer_id   uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.reject_lead_assignment(p_assignment_id, p_customer_id, null, null);
end;
$$;

revoke execute on function public.reject_lead_assignment(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.reject_lead_assignment(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 4 — discard, with a reason
--
-- ⚠️ THE INSERT HAPPENS BEFORE THE DELETE, and that ordering is the feature.
-- lead_assignment_id is ON DELETE SET NULL, so deleting the assignment a moment
-- later nulls the pointer and leaves the row standing with its lead_id and its
-- denormalised area and bedroom count intact. Written after the delete there
-- would be no assignment to read the lead from.
--
-- Body is 0107's verbatim (md5 86fa1308…, verified against production before
-- copying) with the reason call inserted, and the same no-default rule as
-- above.
-- ---------------------------------------------------------------------------
create or replace function public.discard_lead_assignment(
  p_lead_assignment_id uuid,
  p_reason             text,
  p_detail             text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead_id  uuid;
  v_status   text;
  v_notes    integer;
  v_claimed  timestamptz;
  v_customer uuid;
begin
  select lead_id, status, claimed_from_pool_at, customer_id
    into v_lead_id, v_status, v_claimed, v_customer
    from public.lead_assignments
    where id = p_lead_assignment_id
    for update;

  if not found then
    raise exception 'Assignment % not found', p_lead_assignment_id;
  end if;

  -- Discard is refused on an owned lead, for BOTH parties, and the reasons
  -- differ.
  --
  -- For the uploader: discard deletes the assignment row, which is the only
  -- thing making the lead visible to them under leads_select_assigned. They
  -- would be left with a row they own, cannot see, and cannot reach the delete
  -- control for. `DELETE /api/customer/my-leads/[id]` is the verb for a lead
  -- you own.
  --
  -- For the BUYER of a resold lead: discard decrements assignment_count, which
  -- reopens the slot while nothing records that the lead has already been sold
  -- once — so ordinary routing would sell it a second time and the cap of one
  -- would be breached by the single path that destroys the evidence (§19.6's
  -- argument, in its original form). They have reject and close instead.
  if exists (
    select 1 from public.leads l
    where l.id = v_lead_id and l.owner_customer_id is not null
  ) then
    raise exception 'Assignment % is on a customer-added lead and cannot be discarded',
      p_lead_assignment_id;
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

  -- ⚠️ Before the delete. See the header.
  perform public.record_lead_outcome_reason(
    v_customer, p_lead_assignment_id, v_lead_id, 'discard', p_reason, p_detail
  );

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

revoke execute on function public.discard_lead_assignment(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.discard_lead_assignment(uuid, text, text) to service_role;

create or replace function public.discard_lead_assignment(
  p_lead_assignment_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.discard_lead_assignment(p_lead_assignment_id, null, null);
end;
$$;

revoke execute on function public.discard_lead_assignment(uuid)
  from public, anon, authenticated;
grant execute on function public.discard_lead_assignment(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 5 — close, which already recorded a reason, now records it in one place too
--
-- closed_reason on lead_assignments stays and is unchanged; a closed lead can
-- never be discarded (status is not 'new'), so that column is safe where a
-- discard reason would not be. The insert here is what puts close into the same
-- analysis as the other three.
--
-- Body is 0067's verbatim plus the lead lookup and the one call. Same
-- no-default rule: the three-argument arity is kept as a shim.
-- ---------------------------------------------------------------------------
create or replace function public.close_lead_assignment(
  p_assignment_id uuid,
  p_customer_id   uuid,
  p_reason        text,
  p_detail        text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead_id uuid;
begin
  if p_reason not in ('not_interested', 'sorted_elsewhere') then
    raise exception 'Unknown close reason: %', p_reason;
  end if;

  update public.lead_assignments
     set status                = 'not_relevant',
         closed_at             = now(),
         closed_reason         = p_reason,
         last_status_change_at = now()
   where id = p_assignment_id
     and customer_id = p_customer_id
     and closed_at is null
     and status not in ('won', 'rejected')
   returning lead_id into v_lead_id;

  if not found then
    raise exception
      'Assignment not found, not owned by this customer, already closed, or already settled';
  end if;

  perform public.record_lead_outcome_reason(
    p_customer_id, p_assignment_id, v_lead_id, 'close', p_reason, p_detail
  );
end;
$$;

revoke execute on function public.close_lead_assignment(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.close_lead_assignment(uuid, uuid, text, text) to service_role;

create or replace function public.close_lead_assignment(
  p_assignment_id uuid,
  p_customer_id   uuid,
  p_reason        text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.close_lead_assignment(p_assignment_id, p_customer_id, p_reason, null);
end;
$$;

revoke execute on function public.close_lead_assignment(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.close_lead_assignment(uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 6 — ⚠️ An owned lead can never be reported
--
-- claimable_dead_lead_assignments had no owner bar. create_customer_leads
-- (0102) inserts an owned lead with price_paid = 0, spending no credit and
-- moving no counter — but uphold_dead_lead_claim credits lead_balance + 1
-- unconditionally. So an operator could upload a lead, open it, report the
-- landlord as gone and be credited for a lead nobody ever charged them for.
--
-- Five such assignments were eligible on production when this was written, and
-- an uploaded lead is exactly the kind an operator opens repeatedly — so §51's
-- new prompt would have landed on them and invited it.
--
-- Body is 0137's verbatim with one clause added. Same signature, so this is a
-- replacement rather than an overload; the grants are re-asserted below anyway,
-- per §11's rule that any create-or-replace on a privileged function must.
-- ---------------------------------------------------------------------------
create or replace function public.claimable_dead_lead_assignments(
  p_customer_id  uuid,
  p_window_days  integer default 14
)
returns table (
  assignment_id uuid,
  lead_id       uuid,
  assigned_at   timestamptz,
  price_paid    numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select la.id, la.lead_id, la.assigned_at, la.price_paid
  from public.lead_assignments la
  join public.leads l on l.id = la.lead_id
  where la.customer_id = p_customer_id

    -- Timely. A lead reported three months on cannot be traced to a source and
    -- the landlord's state then is unknowable now.
    and la.assigned_at >= now() - make_interval(days => greatest(p_window_days, 1))

    -- One claim per assignment, ever.
    and la.quality_claim_id is null

    -- ⚠️ NOT A LEAD THE CUSTOMER BROUGHT IN THEMSELVES. Nothing was charged for
    -- it (price_paid = 0), so there is no credit to give back — only one to
    -- invent. 0138.
    and l.owner_customer_id is null

    -- ⚠️ WORKED. The inverse of 0114's untouched predicate, and the reason this
    -- refund is an admission the lead was void rather than a refund on
    -- worked-for value the operator simply disliked.
    --
    -- Operator-generated telemetry ONLY. nudge_sent is excluded for the reason
    -- CLAUDE.md §3 gives — it is something WE did to the operator, and counting
    -- it would let our own nudges qualify the least engaged customers.
    and exists (
      select 1 from public.lead_events e
      where e.assignment_id = la.id
        and e.event_type in ('detail_opened', 'tel_click', 'mailto_click', 'whatsapp_click')
    )

    -- A lead already settled as won cannot also have been dead on arrival.
    and la.status <> 'won'

    -- §19.6 and invariant 11: a pool claim is a lead the operator chose to take
    -- knowing its age, and it never reopens its slot. It is not sold supply.
    and la.claimed_from_pool_at is null
$$;

revoke execute on function public.claimable_dead_lead_assignments(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.claimable_dead_lead_assignments(uuid, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 7 — The orphans, finally
--
-- rejection_reason, contact_validation_result and claim_denied exist on
-- lead_assignments in production and in NO migration, left by an abandoned
-- branch, together with apply_lead_rejection() which reads two of them. §11
-- names them and states the rule: drop them, or commit the columns with the
-- function — never one without the other. §36.8 calls that function "the ONLY
-- object still differing between production and a rebuild".
--
-- We are now building reject reasons properly, so inheriting an abandoned
-- branch's shape would be the wrong half of that choice.
--
-- Verified empty on production before writing this: rejection_reason 0 of 511
-- rows set, contact_validation_result 0 of 511, claim_denied never anything but
-- its default. Re-confirm immediately before applying rather than trusting this
-- comment.
--
-- ⚠️ This closes the last known drift between production and a rebuild from
-- supabase/migrations/.
-- ---------------------------------------------------------------------------
drop function if exists public.apply_lead_rejection(
  uuid, uuid, public.lead_type, text, jsonb, boolean, boolean
);

alter table public.lead_assignments drop column if exists rejection_reason;
alter table public.lead_assignments drop column if exists contact_validation_result;
alter table public.lead_assignments drop column if exists claim_denied;
