-- ============================================================================
-- Pipeline tracking + discard.
--
-- Adds a pipeline_stage and a due_to_call_date to lead_assignments, and a
-- discard_lead_assignment() function. The status column and its constraint are
-- left untouched — pipeline_stage is an independent axis.
--
-- NOTE: lead_notes already exists (migration 0009) with its own RLS policy, so
-- no notes table is created here.
-- ============================================================================

-- pipeline_stage: text + check constraint, matching the status column pattern
-- (this schema uses text+check rather than native enums). Independent of status.
alter table public.lead_assignments
  add column if not exists pipeline_stage text not null default 'cold';

alter table public.lead_assignments
  drop constraint if exists lead_assignments_pipeline_stage_check;
alter table public.lead_assignments
  add constraint lead_assignments_pipeline_stage_check
  check (pipeline_stage in (
    'cold',
    'interested_in_the_future',
    'web_meeting_booked',
    'web_meeting_no_show',
    'web_meeting_attended',
    'abandoned'
  ));

alter table public.lead_assignments
  add column if not exists due_to_call_date date;

-- ---------------------------------------------------------------------------
-- discard_lead_assignment — atomic, mirroring assign_lead_to_customer's
-- lock-then-check-then-mutate pattern.
--
--   1. Assignment must be status = 'new' AND have no lead_notes rows.
--   2. Delete the lead_assignments row.
--   3. Decrement leads.assignment_count (so the lead is eligible again,
--      respecting max_assignments).
--   4. Do NOT touch customers.leads_received_this_month or lead_balance —
--      a discarded lead still counts toward the monthly allocation.
-- Any failed check raises and rolls back with no changes.
-- ---------------------------------------------------------------------------
create or replace function public.discard_lead_assignment(
  p_lead_assignment_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead_id uuid;
  v_status  text;
  v_notes   integer;
begin
  select lead_id, status
    into v_lead_id, v_status
    from public.lead_assignments
    where id = p_lead_assignment_id
    for update;

  if not found then
    raise exception 'Assignment % not found', p_lead_assignment_id;
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

  delete from public.lead_assignments where id = p_lead_assignment_id;

  update public.leads
    set assignment_count = greatest(assignment_count - 1, 0)
    where id = v_lead_id;
end;
$$;
