-- ============================================================================
-- A terminal "Won" pipeline stage, and status kept in step with it.
--
-- THE PROBLEM
-- -----------
-- Every assignment carries two independent category systems: `status`
-- (new/contacted/in_discussion/won/not_relevant/rejected) and `pipeline_stage`
-- (cold → … → abandoned). Customers work in the STAGE dropdown, but the
-- Management stage list had no terminal win — it stopped at
-- 'web_meeting_attended'. Winning a lead was only expressible through `status`,
-- via a separate "Mark as signed" button.
--
-- So an operator working the dropdown had nowhere to record a signed landlord,
-- and "Won" looked, reasonably, like it had gone missing.
--
-- Guaranteed Rent already had its terminal win: 'contract_signed'. Management
-- gains 'won'. GR is deliberately NOT given a second terminal stage after
-- contract_signed — that would be the same state twice.
--
-- KEEPING status IN STEP
-- ----------------------
-- status = 'won' is what the ROI funnel, the win-rate figure and the signed
-- celebration all count. If the new stage were a pure label, an operator could
-- set a lead to Won in the dropdown and it would never register as a conversion
-- anywhere — the number they most want to see would silently stay at zero.
--
-- So reaching a terminal winning stage sets status = 'won', mirroring the
-- existing flip that sets 'contacted' when a lead moves off 'cold' (0043). Both
-- routes to a win — the button and the dropdown — now end in the same place.
--
-- RECURSION: the trigger is AFTER UPDATE OF pipeline_stage and the flip writes
-- only status / last_status_change_at, never pipeline_stage, so it cannot
-- re-arm itself. The WHEN clause is a second stop.
--
-- NO BACKFILL: production currently holds zero assignments at status 'won'
-- (100 rows, all 'new' or 'contacted'), so there is no historical drift between
-- the two systems to reconcile. Nothing is rewritten.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 — Allow the new stage.
--
-- Replaces the 0015 constraint. Every previously-valid value is retained; 'won'
-- is added. Management and GR stage lists are enforced in the application
-- (stagesForLeadType), not here — the column has always accepted the union of
-- both products' stages, and narrowing that now would reject existing GR rows.
-- ---------------------------------------------------------------------------
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
    'abandoned',
    -- Guaranteed Rent
    'viewing_booked',
    'contract_sent',
    'contract_signed',
    -- Terminal win (Management; GR uses contract_signed)
    'won'
  ));

-- ---------------------------------------------------------------------------
-- 2 — Mark an assignment won.
--
-- Idempotent: the `status <> 'won'` predicate means a repeat call does nothing.
-- Deliberately does NOT overwrite a 'rejected' status — a rejected lead is a
-- settled, chargeable outcome (0019) and must not be silently converted into a
-- win by a stray dropdown change.
--
-- first_contacted_at is stamped with coalesce for the case where a lead is won
-- without ever having been marked contacted: speed-to-lead would otherwise have
-- no value at all for the operator's fastest conversions.
-- ---------------------------------------------------------------------------
create or replace function public.mark_assignment_won(
  p_assignment_id uuid
)
returns void
language sql
security definer
set search_path = public
as $$
  update public.lead_assignments
     set status                = 'won',
         first_contacted_at    = coalesce(first_contacted_at, now()),
         last_status_change_at = now()
   where id = p_assignment_id
     and status not in ('won', 'rejected');
$$;

revoke execute on function public.mark_assignment_won(uuid)
  from public, anon, authenticated;
grant execute on function public.mark_assignment_won(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 3 — Trigger: a terminal winning stage sets status = 'won'.
--
-- 'won' is the Management terminal stage; 'contract_signed' is the GR one. Both
-- mean the same thing, so both flip the status and the customer's win rate is
-- correct whichever product they hold.
-- ---------------------------------------------------------------------------
create or replace function public.trg_stage_marks_won()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.mark_assignment_won(new.id);
  return null;
end;
$$;

revoke execute on function public.trg_stage_marks_won()
  from public, anon, authenticated;
grant execute on function public.trg_stage_marks_won() to service_role;

drop trigger if exists lead_assignments_stage_mark_won on public.lead_assignments;
create trigger lead_assignments_stage_mark_won
  after update of pipeline_stage on public.lead_assignments
  for each row
  when (
    new.pipeline_stage in ('won', 'contract_signed')
    and old.pipeline_stage is distinct from new.pipeline_stage
  )
  execute function public.trg_stage_marks_won();
