-- ===========================================================================
-- 0139 — A reported lead can be REPLACED, not only refunded; three more
--        reasons; and the effort behind a claim, visible to admin
--
-- §51 shipped on 2026-09-10 and has never been used once: production holds
-- ZERO lead_quality_claims rows against 126 eligible assignments across 13
-- customers. It is invisible — the control appears only on the lead detail
-- page, and only after three opens plus a contact click — and its only
-- outcome is a credit, when what customers keep asking for is the lead
-- replaced.
--
-- This migration makes a swap a possible resolution, widens the vocabulary to
-- six reasons, and gives the review queue the effort figures it decides on.
--
-- ⚠️ IT CHANGES NO EXISTING FUNCTION BODY except flag_lead_dead_if_unanimous,
-- which is reporting-only. The 7-day rule for the competitor reason needs no
-- new SQL at all: apply_dead_lead_claim already takes p_window_days and passes
-- it into claimable_dead_lead_assignments when it re-asserts eligibility under
-- its row lock, and the route already passes that parameter at both call
-- sites. So the rule is enforced in SQL, under the lock, by the caller sending
-- 7 instead of 14 — and the reason -> window map lives in TypeScript where it
-- is unit-testable.
--
-- That ordering matters for the deploy: a clamp written INSIDE
-- apply_dead_lead_claim would make a day-10 competitor claim start failing
-- before the code that explains why has shipped.
--
-- Inert on apply. Widening a CHECK rejects no existing row, dropping a NOT
-- NULL forbids nothing, the foreign-key change only alters delete behaviour,
-- the new columns are nullable-then-backfilled over zero rows, and the two new
-- functions have no caller until the code lands. Nothing here touches a
-- balance, a counter, pacing or capacity.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1 — Six reasons, widened in BOTH places
--
-- ⚠️ The two CHECKs must widen together. lead_quality_claims.reason gates the
-- claim; lead_outcome_reasons' report branch gates the row that records WHY a
-- lead ended. Widen one only and a claim inserts while its outcome row does
-- not — the half of the dataset this whole feature exists to collect.
--
-- ⚠️ already_with_operator is RELABELLED, NOT DUPLICATED. The obvious request
-- was a second reason for "has since chosen another management company", and
-- it must not be built: it would sit one click from this one with the opposite
-- money outcome, which is precisely the failure §51.10 found and had to fix
-- (see the load-bearing comment in src/lib/leadOutcomes.ts about
-- CLOSE_REASONS.sorted_elsewhere). The AGE decides instead — under 7 days the
-- operator never got to pitch, after that they had their chance and lost,
-- which is a lost deal and chargeable. An age is objective and cannot be
-- misreported; a timing adjective can.
--
-- The three new ones are distinct SOURCING failures, which is what makes them
-- worth separating rather than folding into 'no_longer_interested':
--   never_interested — was never a prospect for the service at all
--   property_sold    — the property itself is gone, not just the letting
--   wrong_details    — a DATA fault (wrong name/property/postcode), which
--                      points at the ingest source rather than the landlord,
--                      where 'unreachable' points at a number nobody answers
-- ---------------------------------------------------------------------------
alter table public.lead_quality_claims
  drop constraint if exists lead_quality_claims_reason_check;
alter table public.lead_quality_claims
  add constraint lead_quality_claims_reason_check
  check (reason in (
    'already_with_operator', 'never_interested', 'no_longer_interested',
    'property_sold', 'unreachable', 'wrong_details'
  ));

-- ⚠️ Mirror 0138's SHAPE, not merely its content. outcomeReasons.test.ts parses
-- this constraint by finding "outcome = 'report'", then the next "reason in",
-- then the first ( ) pair — so a reordered or differently-bracketed form
-- breaks the PARSER, not just the assertion, and the failure reads as a
-- mismatch that does not exist.
alter table public.lead_outcome_reasons
  drop constraint if exists lead_outcome_reasons_reason_check;
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
      'already_with_operator', 'never_interested', 'no_longer_interested', 'property_sold', 'unreachable', 'wrong_details'
    ))
  );

-- ---------------------------------------------------------------------------
-- 2 — The claim must SURVIVE the swap that fulfils it
--
-- ⚠️ THIS IS THE HAZARD THAT DECIDES THE SHAPE OF THE WHOLE FEATURE.
-- admin_swap_lead_assignment (0109) does `delete from lead_assignments`, and
-- lead_assignment_id was `not null ... on delete cascade`. So approving a
-- claim BY SWAPPING would destroy the claim, its reason, and the landlord's
-- own words — the evidence this feature is built to collect, deleted by the
-- act of acting on it.
--
-- ⚠️ AND THE OBVIOUS FIX SILENTLY RETIRES THE IDEMPOTENCY GUARD. Dropping the
-- NOT NULL and switching to ON DELETE SET NULL saves the row, but §51.7 names
-- the UNIQUE constraint on this column as THE guard against a double-refund,
-- and Postgres permits unlimited NULLs in a unique index. Reasoning that no
-- reachable path can insert a second claim against a nulled one is true today
-- and true only three hops away — claimable_dead_lead_assignments queries live
-- rows, so a deleted assignment can never be offered again.
--
-- So the guard MOVES to a column nothing can ever null: origin_assignment_id
-- carries NO FOREIGN KEY AT ALL. Same denormalise-to-survive-the-delete move
-- 0138 makes for postcode_area and bedrooms, and 0116 for lead_messages.
--
-- The original UNIQUE stays. It still holds among non-nulls and costs nothing.
--
-- Intended second-order effect, stated so it does not read as a leak on a
-- later audit: the REPLACEMENT assignment is a fresh row with quality_claim_id
-- null, so a replacement that is itself dead can be reported too.
-- ---------------------------------------------------------------------------
alter table public.lead_quality_claims
  drop constraint if exists lead_quality_claims_lead_assignment_id_fkey;
alter table public.lead_quality_claims
  alter column lead_assignment_id drop not null;
alter table public.lead_quality_claims
  add constraint lead_quality_claims_lead_assignment_id_fkey
  foreign key (lead_assignment_id)
  references public.lead_assignments(id) on delete set null;

alter table public.lead_quality_claims
  add column if not exists origin_assignment_id uuid;

update public.lead_quality_claims
  set origin_assignment_id = lead_assignment_id
  where origin_assignment_id is null
    and lead_assignment_id is not null;

-- ⚠️ DERIVED BY TRIGGER, NOT BY ITS WRITERS. apply_dead_lead_claim inserts
-- without naming this column, and so would any future writer. Setting it in
-- that function would mean changing an existing body — the one thing this
-- migration otherwise avoids — and would leave the next writer free to forget.
-- A trigger makes it a property of the table, which is what it is: the column
-- exists only to remember what lead_assignment_id held before a swap nulled
-- it, so nothing should ever supply it by hand.
create or replace function public.set_claim_origin_assignment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.origin_assignment_id is null then
    new.origin_assignment_id := new.lead_assignment_id;
  end if;
  return new;
end;
$$;

revoke execute on function public.set_claim_origin_assignment()
  from public, anon, authenticated;

drop trigger if exists set_claim_origin_assignment on public.lead_quality_claims;
create trigger set_claim_origin_assignment
  before insert on public.lead_quality_claims
  for each row execute function public.set_claim_origin_assignment();

do $$
begin
  -- Zero rows in production at apply time, so this cannot fail there. Guarded
  -- anyway: a rebuild from empty runs this against whatever seed data exists.
  if not exists (
    select 1 from public.lead_quality_claims where origin_assignment_id is null
  ) then
    alter table public.lead_quality_claims
      alter column origin_assignment_id set not null;
  end if;
end $$;

create unique index if not exists lead_quality_claims_origin_assignment_key
  on public.lead_quality_claims (origin_assignment_id);

-- ---------------------------------------------------------------------------
-- 3 — resolution gains 'swap', plus what was actually handed over
--
-- ⚠️ THIS REVERSES §51.5 DELIBERATELY. That section says of this very column:
-- "There is no 'replacement' value: §39.1 is explicit that a release is not a
-- lead-for-lead swap and there is no synchronous re-offer, and this follows
-- that precedent exactly." Do not read this as somebody undoing that by
-- accident — the same loud-reversal note LeadCard.tsx carries about 0079.
--
-- What changed is the decision, not the reasoning. §39.1's argument is about
-- the FILTER RELEASE, where a synchronous re-offer would have to loop
-- autoAssignLead inside a request. Here a person chooses the replacement by
-- hand, which is neither synchronous nor automatic, and every approval is a
-- manual decision precisely because management stock is thin: about 70 leads
-- carry a free slot, and each swap costs two of them (one handed over, one
-- withdrawn by the swap).
--
-- ⚠️ The two audit columns carry NO FOREIGN KEYS, on purpose. A later swap of
-- the replacement would null an FK and take with it the record of what we
-- gave this customer — the same reasoning as origin_assignment_id above.
-- ---------------------------------------------------------------------------
alter table public.lead_quality_claims
  drop constraint if exists lead_quality_claims_resolution_check;
alter table public.lead_quality_claims
  add constraint lead_quality_claims_resolution_check
  check (resolution in ('none', 'credit', 'swap'));

alter table public.lead_quality_claims
  add column if not exists replacement_lead_id uuid;
alter table public.lead_quality_claims
  add column if not exists replacement_assignment_id uuid;

-- ---------------------------------------------------------------------------
-- 4 — resolve_dead_lead_claim_with_swap: ONE transaction, never two calls
--
-- ⚠️ TWO HTTP CALLS CANNOT SETTLE THIS. The swap deletes the assignment, which
-- nulls this claim's pointer; if a following "resolve" call then failed, the
-- result is an under_review claim, no assignment, and a free lead already
-- delivered and emailed. That is non-atomic settlement of a money decision,
-- and it is why this exists rather than the admin route calling the existing
-- swap route and then the existing resolve route.
--
-- ⚠️ A SWAP CREDITS NOTHING. No balance, no monthly-counter rollback, no
-- clean_leads_streak reset, no quality_claims_this_cycle increment. The
-- customer keeps the slot they already paid for and receives a different lead
-- into it at the same price_paid — admin_swap_lead_assignment moves no money
-- by design. Crediting as well would hand them a free lead on top of the
-- replacement.
--
-- ⚠️ It deliberately does NOT call uphold_dead_lead_claim. That function
-- exists so the credit path is identical whether it fired automatically or an
-- admin pressed it (§51.7), and this is not that path. The divergence is the
-- point, not drift.
--
-- Returns null rather than raising when the claim is already settled, mirroring
-- resolve_dead_lead_claim, so an admin double-click cannot swap twice.
-- ---------------------------------------------------------------------------
create or replace function public.resolve_dead_lead_claim_with_swap(
  p_claim_id              uuid,
  p_reviewer              uuid,
  p_review_note           text,
  p_new_lead_id           uuid,
  p_allow_filter_mismatch boolean
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim  public.lead_quality_claims%rowtype;
  v_new_id uuid;
begin
  select * into v_claim
    from public.lead_quality_claims
    where id = p_claim_id
    for update;

  if not found then
    raise exception 'Quality claim % not found', p_claim_id;
  end if;

  -- Already decided. The caller reports this as a 409 rather than an error:
  -- nothing went wrong, the decision was simply already made.
  if v_claim.status <> 'under_review' then
    return null;
  end if;

  -- A claim whose assignment has already gone cannot be swapped — there is
  -- nothing to swap out. Reachable only if the assignment was deleted by some
  -- other path between the queue rendering and the decision.
  if v_claim.lead_assignment_id is null then
    raise exception 'This claim''s assignment no longer exists, so there is nothing to replace';
  end if;

  -- Recorded BEFORE the swap, because the swap nulls lead_assignment_id via
  -- the foreign key above. Same transaction either way, so the ordering is
  -- about readability rather than safety.
  update public.lead_quality_claims
    set status              = 'upheld',
        resolution          = 'swap',
        allowance_consumed  = false,
        replacement_lead_id = p_new_lead_id,
        reviewed_by         = p_reviewer,
        reviewed_at         = now(),
        review_note         = p_review_note
    where id = p_claim_id;

  -- The THREE-argument form with an explicit boolean. The two-argument shim
  -- delegates false, and passing through a null here would silently place a
  -- lead outside the customer's filter (0109).
  v_new_id := public.admin_swap_lead_assignment(
    v_claim.lead_assignment_id,
    p_new_lead_id,
    coalesce(p_allow_filter_mismatch, false)
  );

  update public.lead_quality_claims
    set replacement_assignment_id = v_new_id
    where id = p_claim_id;

  return v_new_id;
end;
$$;

revoke execute on function public.resolve_dead_lead_claim_with_swap(uuid, uuid, text, uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.resolve_dead_lead_claim_with_swap(uuid, uuid, text, uuid, boolean)
  to service_role;

-- ---------------------------------------------------------------------------
-- 5 — get_assignment_effort: how hard did they actually try?
--
-- /admin/quality shows peer statuses and a budget line and NOTHING about the
-- work behind a claim. The number that makes this worth building: of 25
-- rejected assignments on the book, 18 were rejected after exactly ONE look at
-- the lead. An admin approving a replacement on a lead with one open and no
-- contact attempt is the case this exists to catch.
--
-- ⚠️ DO NOT WIDEN get_outcome_evidence INSTEAD. It computes most of this
-- already, but it is gated to status in ('won','not_relevant','rejected') and
-- /admin/outcomes lists exactly what that filter returns — widening it changes
-- an unrelated page. This one has NO status gate, which is the whole reason it
-- exists: a claimed assignment is live.
--
-- ⚠️ detail_opened is counted SEPARATELY as `opens` and never folded into the
-- contact tally. Reading a lead is not contacting it (§6), and that
-- distinction is the entire point of putting these figures in front of a
-- person. nudge_sent is excluded for the reason §3 gives — it is something WE
-- did to the operator, and counting it would inflate exactly the thin claims
-- that most deserve a look.
-- ---------------------------------------------------------------------------
create or replace function public.get_assignment_effort(p_assignment_ids uuid[])
returns table (
  assignment_id   uuid,
  opens           integer,
  contact_clicks  integer,
  tel_clicks      integer,
  whatsapp_clicks integer,
  mailto_clicks   integer,
  messages_sent   integer,
  note_count      integer,
  file_count      integer,
  first_event_at  timestamptz,
  last_event_at   timestamptz,
  assigned_at     timestamptz,
  days_held       numeric,
  pipeline_stage  text,
  status          text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    la.id,
    coalesce(e.opens, 0)::integer,
    (coalesce(e.tel, 0) + coalesce(e.wa, 0)
       + coalesce(e.mail, 0) + coalesce(e.msg, 0))::integer,
    coalesce(e.tel, 0)::integer,
    coalesce(e.wa, 0)::integer,
    coalesce(e.mail, 0)::integer,
    coalesce(e.msg, 0)::integer,
    coalesce(n.notes, 0)::integer,
    coalesce(f.files, 0)::integer,
    e.first_at,
    e.last_at,
    la.assigned_at,
    round(extract(epoch from (now() - la.assigned_at)) / 86400.0, 1),
    la.pipeline_stage,
    la.status
  from public.lead_assignments la
  left join lateral (
    select
      count(*) filter (where ev.event_type = 'detail_opened')  as opens,
      count(*) filter (where ev.event_type = 'tel_click')      as tel,
      count(*) filter (where ev.event_type = 'whatsapp_click') as wa,
      count(*) filter (where ev.event_type = 'mailto_click')   as mail,
      count(*) filter (where ev.event_type = 'message_sent')   as msg,
      min(ev.created_at) filter (where ev.event_type <> 'nudge_sent') as first_at,
      max(ev.created_at) filter (where ev.event_type <> 'nudge_sent') as last_at
    from public.lead_events ev
    where ev.assignment_id = la.id
  ) e on true
  left join lateral (
    select count(*) as notes from public.lead_notes ln
    where ln.lead_assignment_id = la.id
  ) n on true
  left join lateral (
    select count(*) as files from public.lead_files lf
    where lf.lead_assignment_id = la.id
  ) f on true
  where la.id = any(p_assignment_ids);
$$;

revoke execute on function public.get_assignment_effort(uuid[])
  from public, anon, authenticated;
grant execute on function public.get_assignment_effort(uuid[]) to service_role;

-- ---------------------------------------------------------------------------
-- 6 — flag_lead_dead_if_unanimous remembers a swap
--
-- The only existing body this migration touches, and it is reporting-only —
-- leads.quality_flag retires nothing from allocation (§51.5, invariant 11).
--
-- It counted upheld claims by joining through lead_assignment_id. After a swap
-- that pointer is null AND the assignment is deleted, so the operator leaves
-- both the numerator and the denominator: the ratio stays defensible, which is
-- why no change was strictly required.
--
-- ⚠️ But it must be added to BOTH sides or not at all. Counting swap-settled
-- claims toward v_dead alone would flag leads 'dead' that are not, because the
-- denominator no longer contains the operator who reported them.
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
      and c.resolution = 'swap'
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
grant execute on function public.flag_lead_dead_if_unanimous(uuid) to service_role;
