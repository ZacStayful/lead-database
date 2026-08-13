-- ============================================================================
-- Closing a lead: the outcome signal, and the first thing that takes a dead
-- lead out of circulation.
--
-- THE PROBLEM THIS SOLVES
-- ----------------------
-- 298 leads have been delivered. 72 were genuinely worked — somebody rang or
-- emailed or wrote a note. Three have a recorded outcome. The other 70 got real
-- effort and the result was never captured anywhere.
--
-- That is not operators being lazy. There was no way to report it. The two
-- existing exits both refuse the case that carries the most information:
--
--   reject  — requires pipeline_stage = 'cold'
--   discard — requires status = 'new' AND no notes
--
-- and clicking the landlord's phone number auto-flips status to 'contacted'
-- (0043). So the moment an operator actually TRIES, both exits close. An
-- operator who rings, is told the landlord went with someone else, and wants to
-- file it away has no way to say so. The system is deaf to precisely the
-- operators doing the work.
--
-- WHY SILENCE IS NOT A QUALITY SIGNAL
-- -----------------------------------
-- An earlier draft of this feature treated "no operator worked this lead" as
-- evidence the lead was bad. That is backwards: if nobody rang, nobody knows.
-- Silence measures the operator, never the landlord. Only a lead somebody
-- ATTEMPTED can say anything about quality, which is why this action is
-- available at any stage — the leads worth hearing about are the ones the other
-- two exits reject.
--
-- WHY CLOSING WITHDRAWS THE LEAD FROM EVERYONE
-- --------------------------------------------
-- Both reasons describe the LANDLORD, not the operator:
--
--   not_interested    — they do not want the service
--   sorted_elsewhere  — they already have somebody
--
-- Neither is "this lead is not for me". A landlord who has said no has said no
-- to the next operator too, so continuing to sell them is selling a known dead
-- lead — and phoning a landlord who has already declined twice is how a lead
-- source gets a bad name. A closed lead is therefore offered to nobody new:
-- not by escalation, not by the daily top-up.
--
-- Operators already holding it are NOT disturbed. One operator's report must not
-- cancel another's live conversation, and two operators can legitimately get
-- different answers from the same landlord a week apart.
--
-- NO REFUND. Deliberately unchanged (invariant 4, 0019). Closing records what
-- happened; it does not reopen the charge. Bad or unusable CONTACT DATA — a
-- dead number, a wrong address — is a different thing entirely and is handled
-- by the support desk, not here. That distinction is the whole reason the two
-- reasons below are both about the landlord's answer: this action can never be
-- a route to a credit, so there is no incentive to misreport it.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 — Columns.
--
-- status moves to 'not_relevant', which has been in the CHECK constraint since
-- 0006 and has never once been used — it is exactly this state and needs no new
-- vocabulary. closed_at and closed_reason carry the detail status cannot.
-- ---------------------------------------------------------------------------
alter table public.lead_assignments
  add column if not exists closed_at     timestamptz,
  add column if not exists closed_reason text;

alter table public.lead_assignments
  drop constraint if exists lead_assignments_closed_reason_check;
alter table public.lead_assignments
  add constraint lead_assignments_closed_reason_check
  check (closed_reason is null or closed_reason in (
    'not_interested',
    'sorted_elsewhere'
  ));

-- Routing asks "does this lead have any closed assignment" on every top-up and
-- every escalation, so the lookup is by lead through the assignment.
create index if not exists idx_lead_assignments_closed
  on public.lead_assignments (lead_id)
  where closed_at is not null;

-- ---------------------------------------------------------------------------
-- 2 — Is this lead dead?
--
-- Derived from the assignments rather than stored on the lead, for the same
-- reason lead_open_reclaim_slots is derived (0046): a stored flag and the rows
-- it summarises can drift apart, a derived one cannot. It also means undoing a
-- close is just clearing the columns, with no second place to remember.
-- ---------------------------------------------------------------------------
create or replace function public.lead_is_closed(p_lead_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.lead_assignments
    where lead_id = p_lead_id and closed_at is not null
  );
$$;

revoke execute on function public.lead_is_closed(uuid) from public, anon, authenticated;
grant execute on function public.lead_is_closed(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 3 — Close an assignment.
--
-- Ownership is checked inside the function, not by the caller, so the route and
-- the rule cannot disagree — the same reason reject_lead_assignment takes a
-- customer id (§5E).
--
-- Available from ANY stage except the two settled ones. A won lead cannot be
-- closed (it would erase a conversion) and a rejected one is already settled.
-- Everything else — new, contacted, in_discussion — can be closed, because the
-- whole point is to catch the case after real work has happened.
--
-- Idempotent: closing an already-closed assignment matches no rows and raises,
-- so a double-tap in the UI cannot rewrite the original reason or timestamp.
-- ---------------------------------------------------------------------------
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
     and status not in ('won', 'rejected');

  if not found then
    raise exception
      'Assignment not found, not owned by this customer, already closed, or already settled';
  end if;
end;
$$;

revoke execute on function public.close_lead_assignment(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.close_lead_assignment(uuid, uuid, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 4 — Escalation skips closed leads and closed assignments.
--
-- Definition verbatim from 0062 except the two added conditions. Rewritten in
-- full rather than patched so the whole eligibility rule stays readable in one
-- place — this query is the answer to "why did that lead escalate", and a
-- reader should never have to diff two migrations to get it.
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
    la.assigned_at > p_cutoff
    and la.assigned_at <= now() - make_interval(days => p_min_age_days)
    and la.inactivity_escalation_stage = p_stage - 1
    and la.status not in ('won', 'rejected')
    and l.max_assignments < 5

    -- This operator has filed the lead. Escalating it would be chasing them
    -- about a lead they have already told us the outcome of.
    and la.closed_at is null

    -- ANY operator has reported the landlord as done. Selling a lead that has
    -- already said no is how a lead source earns a bad name — and it is exactly
    -- the outcome this whole feature exists to avoid.
    and not exists (
      select 1 from public.lead_assignments closed
      where closed.lead_id = la.lead_id
        and closed.closed_at is not null
    );
$$;

revoke execute on function public.get_escalation_candidates(timestamptz, integer, integer)
  from public, anon, authenticated;
grant execute on function public.get_escalation_candidates(timestamptz, integer, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- 5 — Outcome reporting, for the review loop.
--
-- Grouped by lead_profile because that is the one quality dimension the data
-- actually carries: every lead comes from the website, so there is no source to
-- compare, but there are seven distinct enquiry types and no reason to assume
-- they convert alike.
--
-- attempted is the denominator that matters. A rate over ALL delivered leads
-- would mostly measure whether operators bothered; over attempted leads it
-- measures the leads themselves, which is the question.
-- ---------------------------------------------------------------------------
create or replace function public.get_lead_outcome_report()
returns table (
  lead_type          public.lead_type,
  lead_profile       text,
  delivered          integer,
  attempted          integer,
  won                integer,
  closed_not_interested integer,
  closed_sorted_elsewhere integer,
  rejected           integer,
  win_rate_of_attempted numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with per_lead as (
    select
      l.id, l.lead_type,
      nullif(btrim(coalesce(l.lead_profile, '')), '') as profile,
      bool_or(
        exists (select 1 from public.lead_events e
                 where e.assignment_id = la.id
                   and e.event_type in ('tel_click', 'mailto_click'))
        or exists (select 1 from public.lead_notes n where n.lead_assignment_id = la.id)
        or la.closed_at is not null
      ) as attempted,
      bool_or(la.status = 'won')                             as won,
      bool_or(la.closed_reason = 'not_interested')           as not_interested,
      bool_or(la.closed_reason = 'sorted_elsewhere')         as sorted_elsewhere,
      bool_or(la.status = 'rejected')                        as rejected
    from public.leads l
    join public.lead_assignments la on la.lead_id = l.id
    group by l.id, l.lead_type, l.lead_profile
  )
  select
    lead_type,
    coalesce(profile, 'Not stated'),
    count(*)::integer,
    count(*) filter (where attempted)::integer,
    count(*) filter (where won)::integer,
    count(*) filter (where not_interested)::integer,
    count(*) filter (where sorted_elsewhere)::integer,
    count(*) filter (where rejected)::integer,
    case when count(*) filter (where attempted) > 0
         then round(
           count(*) filter (where won)::numeric
           / count(*) filter (where attempted), 3)
    end
  from per_lead
  group by lead_type, coalesce(profile, 'Not stated')
  order by lead_type, count(*) desc;
$$;

revoke execute on function public.get_lead_outcome_report() from public, anon, authenticated;
grant execute on function public.get_lead_outcome_report() to service_role;
