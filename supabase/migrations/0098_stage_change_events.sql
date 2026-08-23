-- ---------------------------------------------------------------------------
-- 0098 — Record pipeline stage changes as events
--
-- `lead_events.event_type` has permitted 'stage_changed' since 0044 and NOTHING
-- HAS EVER WRITTEN ONE. Production carries 0 rows of it: 448 detail_opened,
-- 167 nudge_sent, 2 tel_click, 1 mailto_click, and nothing else.
--
-- So there is no durable record of pipeline movement anywhere.
-- `lead_assignments.pipeline_stage` is current state and
-- `last_status_change_at` is a single overwritten timestamp, which means
-- "how many leads did this customer move through their pipeline in March"
-- cannot be answered, today or retrospectively. That is the gap this closes,
-- and it is the input the month-over-month series (0101) needs.
--
-- ---------------------------------------------------------------------------
-- ⚠️ THIS IS NOT AN ADDITIVE CHANGE. IT MOVES TWO LIVE SYSTEMS.
--
-- Both already read 'stage_changed' and both currently get zero rows:
--
-- 1. get_assignment_engagement_scores (0063) weights `stage_moved` at 0.35 and
--    SUMS matched weights, capped at 1.0. Escalation thresholds are 0.35 at day
--    10 and 0.45 at day 20 (§18). Critically, the function's `passive_only`
--    flag also flips false once stage_moved is true, and the escalation route
--    skips only when `score >= threshold AND NOT passive_only` — so this makes
--    the score actually bite. Effect: leads an operator is visibly advancing
--    stop being resold out from under them.
--
-- 2. get_service_capacity's recycled-supply CTEs (0071/0072/0084) count
--    ('tel_click','mailto_click','stage_changed') as worked, feeding
--    `unworked_rate` -> `recycled_slots_per_month` -> `sustainable_customers`,
--    the §18.2 capacity headline.
--
-- Measured on live data, if every currently-off-cold assignment had an event:
-- management `unworked_rate` 99.0% -> 85.7%; GR unchanged at 100%.
--
-- ⚠️ BUT IT DRIFTS, IT DOES NOT STEP, and anyone watching must know that or
-- they will conclude the trigger is broken. The `recycling` and `unworked_rate`
-- CTEs window on `e.created_at < a.assigned_at + interval '10 days'` — each
-- assignment's OWN first ten days. Every assignment already past day 10 when
-- this applies can never gain a qualifying event, so the rate only moves as new
-- cohorts enter the sample. `recycled_slots_now` windows on `now() - 10 days`
-- and so responds within ten days.
--
-- This is a correction, not a regression: 0063's own header says "stage
-- movement is read from the stage_changed event". The author intended it and it
-- silently never worked.
--
-- ---------------------------------------------------------------------------
-- NO BACKFILL, deliberately.
--
-- The only candidate timestamp for a historic event is `last_status_change_at`,
-- and it is wrong three ways: it is overwritten, it records a STATUS change
-- rather than a STAGE change, and the two decouple exactly on the mid-pipeline
-- moves that are the new information. A fabricated event would then feed
-- routing and the capacity model as though it had been observed — the §18.2
-- error of projecting a pre-intervention measurement forward.
--
-- The series therefore starts on the day this applies. `stage_events_from`
-- below records that date so a reader can tell "no stage changes in July" from
-- "we were not recording yet" — the same job `reclaim_enabled_from` (§7) and
-- `contact_gate_from` (0079) already do.
--
-- ---------------------------------------------------------------------------
-- THE ESCAPE HATCH, if escalation turns out to be over-protected:
--
--     update public.engagement_weights set weight = 0 where signal = 'stage_moved';
--
-- Admin-editable, no deploy, instant — which is exactly why that table holds
-- the weights rather than a function (§18). ⚠️ It reverts the ESCALATION half
-- only. The capacity half hardcodes the event list in SQL and would need 0084's
-- CTEs edited. Deliberately no `system_settings` flag on the write itself: a
-- flag that changes what a score MEANS is a second source of truth about a
-- definition, and the lever above is better in every way.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 1 — The trigger function.
--
-- Writes only into lead_events and never touches lead_assignments, so it cannot
-- re-arm its own AFTER UPDATE OF pipeline_stage.
--
-- metadata carries the transition and nothing else. customer_id, lead_type and
-- every timestamp are derivable from the join, and §27.2's no-spread instinct
-- applies to an unschema'd jsonb column just as hard: what goes in is what is
-- needed. ⚠️ lead_events has a SELECT policy for the owning customer (0043), so
-- this object is visible to that customer's browser — it must never gain an
-- internal field.
-- ---------------------------------------------------------------------------
create or replace function public.trg_stage_records_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.lead_events (assignment_id, event_type, metadata)
  values (
    new.id,
    'stage_changed',
    jsonb_build_object('from', old.pipeline_stage, 'to', new.pipeline_stage)
  );
  return null;
end;
$$;

revoke execute on function public.trg_stage_records_event()
  from public, anon, authenticated;
grant execute on function public.trg_stage_records_event() to service_role;

-- ---------------------------------------------------------------------------
-- 2 — The trigger.
--
-- ⚠️ THE `WHEN` CLAUSE IS THE GAMING GUARD, NOT DECORATION.
--
-- `after update of pipeline_stage` fires whenever the column appears in the
-- UPDATE's target list, EVEN IF THE VALUE IS UNCHANGED — and
-- PATCH /api/customer/assignments/[id] writes `update.pipeline_stage =
-- body.pipeline_stage` whenever the field is present in the body. Without
-- `is distinct from`, an operator re-selecting the stage they are already on
-- would emit an event and buy the lead another ten days of escalation
-- protection. That is precisely the loophole 0063's header warns about: "the
-- moment operators learn that ignored leads get resold, that click becomes the
-- cheapest way to hold a lead they are not working."
--
-- Named `..._records_event` so it sorts after `lead_assignments_stage_mark_
-- contacted` (0043) and `lead_assignments_stage_mark_won` (0050). Postgres
-- fires same-event triggers alphabetically. Ordering does not affect
-- correctness here — this function reads only OLD/NEW, which are fixed for the
-- statement — but "the couplings happen, then the event records them" is the
-- right semantic order and is better chosen than inherited.
--
-- Recursion is impossible, three ways over:
--   1. the function never writes lead_assignments;
--   2. the only INSERT trigger on lead_events is lead_events_mark_contacted,
--      `when (new.event_type = 'tel_click')` (0043:270), which a stage_changed
--      row does not match;
--   3. even if it did, mark_assignment_contacted writes status /
--      first_contacted_at / last_status_change_at and never pipeline_stage, so
--      the chain terminates on this trigger's own `OF` clause.
--
-- The §6A automatic `won` flip deliberately emits NOTHING extra: the stage move
-- that caused it already emits this event, and the "Mark as signed" button sets
-- status without touching pipeline_stage, so there is no transition to record.
-- ---------------------------------------------------------------------------
drop trigger if exists lead_assignments_stage_records_event on public.lead_assignments;
create trigger lead_assignments_stage_records_event
  after update of pipeline_stage on public.lead_assignments
  for each row
  when (new.pipeline_stage is distinct from old.pipeline_stage)
  execute function public.trg_stage_records_event();


-- ---------------------------------------------------------------------------
-- 3 — The marker, so an empty month reads honestly.
--
-- Without this, "0 stage changes in July 2026" is indistinguishable from
-- "operators did nothing in July", and the first month-over-month chart would
-- show a fictional surge on the day this applied.
--
-- `do nothing` on conflict: re-applying this migration must not move the date
-- and silently re-write what the series claims to know.
-- ---------------------------------------------------------------------------
insert into public.system_settings (key, value)
  values ('stage_events_from', now()::text)
  on conflict (key) do nothing;


-- ---------------------------------------------------------------------------
-- 4 — A warning on a column this feature sits next to.
--
-- Unrelated to the trigger, recorded here because 0099 adds a table with the
-- SAME GRAIN and the OPPOSITE summing rule, and anyone who has read 0064 will
-- get it wrong. `capture_engagement_snapshots`' revenue subquery is not
-- product-filtered, so it writes the identical figure to a customer's
-- management row AND their guaranteed_rent row.
-- ---------------------------------------------------------------------------
comment on column public.customer_engagement_snapshots.lifetime_revenue_pence is
  'Cumulative sum(payments.amount_pence) for this CUSTOMER, not this product. Written identically to both the management and guaranteed_rent row — NEVER sum across lead_type or it double-counts. Contrast customer_commercial_snapshots.mrr_pence (0099), which is genuinely per product and MUST be summed. Also understated: payments is known incomplete.';
