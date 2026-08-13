-- ============================================================================
-- Inactivity-triggered assignment escalation.
--
-- A lead sitting with an operator who has not engaged with it is offered to one
-- further operator, at 10 days and again at 20 days. The original assignment is
-- untouched: same status, same price_paid, no refund, no counter rollback,
-- nothing withdrawn. Only the lead's capacity changes.
--
-- ---------------------------------------------------------------------------
-- RELATIONSHIP TO SOFT RECLAIM (0046) — this supersedes it
-- ---------------------------------------------------------------------------
-- 0046 does the same thing on a three-UK-working-day clock at a reduced price
-- (£10 / £7). Three days was judged too short in practice, and the discount is
-- being dropped: an escalated lead spends one of the receiving customer's
-- monthly credits exactly like any other lead, so it records the full
-- leadPriceFor() price. There is no second charge to collect and no reason for
-- a second price.
--
-- The reclaim MACHINERY is deliberately left in place and unaltered here:
--   * reclaim_lead_assignment / get_reclaim_candidates / lead_open_reclaim_slots
--     still exist and still work
--   * assign_lead_to_customer still adds lead_open_reclaim_slots() to capacity
-- What retires is the reclaim CRON (removed from vercel.json in the code phase),
-- so no new reclaim is ever granted. Leaving the functions means the two
-- assignments already carrying reclaim columns (currently zero) keep their
-- meaning, and a rollback is a vercel.json edit rather than a migration.
--
-- ---------------------------------------------------------------------------
-- WHY THIS ONE DOES INCREMENT max_assignments, WHERE RECLAIM DID NOT
-- ---------------------------------------------------------------------------
-- 0046 refused to increment the cap because ingest.ts and
-- /api/admin/leads/assign-pending auto-fill any gap between assignment_count
-- and max_assignments "at the standard price through normal routing" — which
-- would have handed a £10 reclaim slot away at £15 to whoever was next in line,
-- defeating both the discount and the reclaim rules.
--
-- Escalation has neither a discount nor a bespoke recipient rule: it sells at
-- the standard price through normal routing. So the top-up path is not a
-- defeat mechanism, it is a second executor of the same intent. If the daily
-- sync fills an escalated slot before the escalation job does, the outcome is
-- identical — one more operator, full price, deficit-first. That makes a plain
-- cap increment the correct and simplest mechanism here, and it is why the
-- derived-slot indirection is not reused.
--
-- CEILING OF 5, NOT THE BRIEF'S 4
--
-- The brief set a hard stop at 4 when the base default was 2: two rungs, 2->3
-- and 3->4. 0055 has since raised the default to 3, so a ceiling of 4 leaves
-- room for exactly ONE escalation and the 20-day rung could never fire on any
-- newly ingested lead — the ladder would silently become a single step.
--
-- The instruction is two rungs then stop ("10 days no response, 20 days no
-- response, then leave"), so the ceiling moves with the base that shifted under
-- it: 3 -> 4 -> 5, and no further. Leads ingested before 0055 still carry
-- max_assignments = 2 and simply stop a step earlier at 4.
--
-- PATCH /api/admin/leads/[id] still bounds MANUAL admin edits to 1..4. That is
-- left alone deliberately: 5 is a ceiling the system may reach by escalating a
-- lead nobody worked, not a number an admin should set by hand on a fresh lead.
-- leads.max_assignments carries no CHECK constraint, so nothing needs widening.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 — Settings
--
-- escalation_enabled       — kill switch. The daily job checks this first and
--                            logs a skipped run rather than silently no-oping.
-- escalation_enabled_from  — retroactivity cutoff, stamped at apply time.
--                            Deliberately now() - 3 days, not now(): the brief
--                            allows the three days of assignments immediately
--                            preceding ship, and nothing older, so day one
--                            cannot produce a flood of simultaneous
--                            escalations against months of history.
-- escalation_max_lead_age_days — freshness gate. NOT YET CONFIGURED, and
--                            stored as an EMPTY STRING rather than omitted:
--                            system_settings.value is `text not null`, so there
--                            is no NULL to store, and an absent row is
--                            indistinguishable from a migration that failed to
--                            run. An empty value is an explicit "Zac has not
--                            decided this yet", which the admin panel renders as
--                            such. Empty means the gate does not block, and the
--                            job flags that it ran ungated.
-- ---------------------------------------------------------------------------
insert into public.system_settings (key, value)
  values ('escalation_enabled', 'true')
  on conflict (key) do nothing;

insert into public.system_settings (key, value)
  values ('escalation_enabled_from', (now() - interval '3 days')::text)
  on conflict (key) do nothing;

insert into public.system_settings (key, value)
  values ('escalation_max_lead_age_days', '')
  on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2 — Stage tracking, on the INACTIVE assignment that triggered the escalation.
--
-- Recorded per assignment rather than per lead because the trigger is
-- per-assignee: on a lead with three operators, one inactive assignee escalates
-- regardless of what the others are doing (a deliberate choice, not an
-- oversight). Two assignments of the same lead can each carry a stage.
--
-- The timestamps are not decoration. Phase 5's cannibalisation check asks "did
-- the original assignee do anything AFTER we escalated" — which needs the
-- moment the escalation fired, not merely that it did. Two nullable columns
-- rather than one, so both rungs keep their own date.
-- ---------------------------------------------------------------------------
alter table public.lead_assignments
  add column if not exists inactivity_escalation_stage integer not null default 0,
  add column if not exists escalation_stage_1_at timestamptz,
  add column if not exists escalation_stage_2_at timestamptz;

alter table public.lead_assignments
  drop constraint if exists lead_assignments_escalation_stage_check;
alter table public.lead_assignments
  add constraint lead_assignments_escalation_stage_check
  check (inactivity_escalation_stage between 0 and 2);

-- The daily sweep scans by stage and age. Not partial on status: the sweep
-- deliberately covers every status except the two settled ones, so a predicate
-- on 'new' would exclude most of what it needs to read.
create index if not exists idx_lead_assignments_escalation_sweep
  on public.lead_assignments (inactivity_escalation_stage, assigned_at);

-- ---------------------------------------------------------------------------
-- 3 — leads.enquiry_date is TEXT, and not always a date.
--
-- The freshness gate compares today against enquiry_date, but that column has
-- been TEXT since 0001 and production holds at least two shapes ('2026-07-08'
-- and '2026-08-06 06:26') plus empty strings from the management ingest path,
-- which writes "" for any missing field. A bare cast would raise and take the
-- whole escalation run down with it, so parsing is done defensively and an
-- unparseable value resolves to NULL — treated as "age unknown", which the gate
-- lets through rather than blocking on.
-- ---------------------------------------------------------------------------
create or replace function public.safe_enquiry_date(p_raw text)
returns date
language plpgsql
immutable
as $$
begin
  if p_raw is null or btrim(p_raw) = '' then
    return null;
  end if;
  return p_raw::date;
exception when others then
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4 — Candidate finder.
--
-- Returns assignments eligible for the given rung. The weighted engagement
-- score is applied by the CALLER (0057 supplies it), for the same reason 0046
-- applied its business-day clock in the caller: this function is the cheap,
-- indexable prefilter and the score is the expensive per-row test.
--
-- WHY status = 'new' IS NOT THE FILTER
-- ------------------------------------
-- The brief's Phase 2 gates candidates on status = 'new' with no notes. A dry
-- run against production says that would not work, and would be trivially
-- defeatable:
--
--   * 31 of 87 assignments older than ten days sit at status 'contacted' while
--     scoring 0.10 or less — no open, no call, no note, no stage movement. The
--     customer assignments PATCH route lets an operator set 'contacted' by
--     hand, so pressing "Mark as contacted" and then doing nothing would
--     immunise a lead against escalation permanently. That is the single
--     cheapest action available in the UI, and it is the one the ladder must
--     not reward.
--   * Conversely mark_assignment_contacted (0043) flips status automatically on
--     a note, file, stage move or tel_click, so status = 'new' would also have
--     excluded every lead an operator genuinely started and then abandoned —
--     the exact case worth reselling.
--
-- The brief resolves its own conflict: the weighted score "replaces the simple
-- binary check in Phase 2 step 1". So the score governs, and status is used
-- only to exclude the two SETTLED outcomes:
--
--   'won'      — a conversion. Escalating it would sell a signed landlord.
--   'rejected' — settled and chargeable under 0019; reject means the operator
--                consciously passed, and 0046 excludes it for the same reason.
--
-- Everything else — new, contacted, in_discussion, not_relevant — is judged on
-- whether anything actually happened in the trailing window. 'not_relevant' is
-- deliberately left eligible: an operator saying a lead is not for them is a
-- reason to offer it to somebody else, not to freeze it.
--
-- Notes and files are likewise NOT a hard exclusion any more. They are scored
-- signals with a date (0057), so a note written three weeks ago no longer
-- protects a lead nobody has touched since.
-- ---------------------------------------------------------------------------
create or replace function public.get_escalation_candidates(
  p_cutoff       timestamptz,
  p_stage        integer,
  p_min_age_days integer
)
returns table (
  assignment_id   uuid,
  lead_id         uuid,
  customer_id     uuid,
  lead_type       public.lead_type,
  assigned_at     timestamptz,
  max_assignments integer,
  lead_age_days   integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    la.id,
    la.lead_id,
    la.customer_id,
    l.lead_type,
    la.assigned_at,
    l.max_assignments,
    case
      when public.safe_enquiry_date(l.enquiry_date) is null then null
      else (current_date - public.safe_enquiry_date(l.enquiry_date))
    end
  from public.lead_assignments la
  join public.leads l on l.id = la.lead_id
  where
    -- Never retroactive beyond the stamped cutoff.
    la.assigned_at > p_cutoff
    and la.assigned_at <= now() - make_interval(days => p_min_age_days)

    -- This rung has not fired for this assignment, and the previous one has.
    -- Fires each rung exactly once; re-running the job is a no-op.
    and la.inactivity_escalation_stage = p_stage - 1

    -- Settled outcomes only. Engagement is judged by the caller's score over the
    -- trailing window — see the note above on why status is not the test.
    and la.status not in ('won', 'rejected')

    -- Room left under the hard ceiling.
    and l.max_assignments < 5;
$$;

revoke execute on function public.get_escalation_candidates(timestamptz, integer, integer)
  from public, anon, authenticated;
grant execute on function public.get_escalation_candidates(timestamptz, integer, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- 5 — Perform the escalation atomically.
--
-- Re-checks every rule under a row lock before acting, so two concurrent runs
-- cannot both escalate the same assignment: the second finds the stage already
-- advanced and aborts. The caller's candidate query is a hint, never permission.
--
-- ORDER MATTERS. The cap is raised BEFORE assign_lead_to_customer is called,
-- because that function's capacity check reads leads.max_assignments under its
-- own lock. If the assignment then fails — the recipient's credit was spent
-- between the availability check and here — the whole function raises and the
-- transaction rolls back, taking the cap increase with it. There is no state in
-- which the cap is raised but the stage is unrecorded, or vice versa.
-- ---------------------------------------------------------------------------
create or replace function public.escalate_lead_assignment(
  p_assignment_id   uuid,
  p_new_customer_id uuid,
  p_price           numeric,
  p_lead_type       public.lead_type,
  p_stage           integer
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_original      public.lead_assignments%rowtype;
  v_lead          public.leads%rowtype;
  v_new_assignment_id uuid;
begin
  if p_stage not in (1, 2) then
    raise exception 'Escalation stage must be 1 or 2, got %', p_stage;
  end if;

  select * into v_original from public.lead_assignments
    where id = p_assignment_id for update;
  if not found then
    raise exception 'Assignment % not found', p_assignment_id;
  end if;

  if v_original.inactivity_escalation_stage <> p_stage - 1 then
    raise exception 'Assignment % is at escalation stage %, cannot fire stage %',
      p_assignment_id, v_original.inactivity_escalation_stage, p_stage;
  end if;

  -- Re-assert eligibility under the lock. status is what can genuinely change
  -- between the sweep and here — an operator winning or rejecting the lead in
  -- that window settles it, and a settled lead must not be escalated out from
  -- under them. Engagement itself is not re-scored here: the window is ten days
  -- wide, so a signal arriving in the seconds between the sweep and this call
  -- cannot meaningfully change the answer, and re-scoring under a row lock would
  -- hold it for the length of the score query.
  if v_original.status in ('won', 'rejected') then
    raise exception 'Assignment % is settled (status %) and cannot be escalated',
      p_assignment_id, v_original.status;
  end if;

  select * into v_lead from public.leads
    where id = v_original.lead_id for update;

  if v_lead.max_assignments >= 5 then
    raise exception 'Lead % is at the escalation ceiling (max_assignments = %)',
      v_original.lead_id, v_lead.max_assignments;
  end if;

  update public.leads
    set max_assignments = v_lead.max_assignments + 1
    where id = v_original.lead_id;

  -- Standard assignment path, no bypass: same capacity check, same per-product
  -- balance gate, same credit spend, same monthly counter, same odometer bump.
  v_new_assignment_id := public.assign_lead_to_customer(
    v_original.lead_id, p_new_customer_id, p_price, p_lead_type
  );

  update public.lead_assignments
    set inactivity_escalation_stage = p_stage,
        escalation_stage_1_at = case when p_stage = 1 then now()
                                     else escalation_stage_1_at end,
        escalation_stage_2_at = case when p_stage = 2 then now()
                                     else escalation_stage_2_at end
    where id = p_assignment_id;

  return v_new_assignment_id;
end;
$$;

revoke execute on function public.escalate_lead_assignment(uuid, uuid, numeric, public.lead_type, integer)
  from public, anon, authenticated;
grant execute on function public.escalate_lead_assignment(uuid, uuid, numeric, public.lead_type, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- 6 — Backfill of freed slots on already-escalated leads.
--
-- If a rejection or discard drops an escalated lead below its raised cap, the
-- gap is filled by the ordinary top-up paths (ingest's duplicate branch, and
-- /api/admin/leads/assign-pending) at the standard price through normal
-- routing — which is precisely the intent. No new mechanism is needed, and the
-- escalation job re-checks the same condition on its next run.
--
-- Note discard DELETES the assignment row, taking its escalation stage with it.
-- That is correct: the stage records that THIS assignee was inactive, and once
-- the assignment is gone there is no assignee to have been inactive. The lead
-- keeps its raised max_assignments, so the slot stays open.
-- ---------------------------------------------------------------------------
