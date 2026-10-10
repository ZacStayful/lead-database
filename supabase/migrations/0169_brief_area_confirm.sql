-- ============================================================================
-- 0169 — Batch 04 Phase 3: confirming a recalculated area, and extending a
--        long pause from the confirm screen
--
-- docs/build/04-area-changes-pause-topups.md (Phase 3) and the approved Phase 0
-- report, docs/build/04-phase0-report.md (C4, C5, C10). Lead Brief customers
-- only.
--
-- Locked decision 4: a `pending_confirmation` brief is shown on login, and
-- becomes active when the customer confirms it, or 72 hours after its return
-- or effective date when they never do. Labels, first picks and the "why"
-- checklist are measured against the confirmed area from that moment.
--
-- What it adds:
--
--   1. confirm_pending_lead_brief (C10): make the pending version active and
--      the old one superseded, with first picks recomputed and locked until the
--      next renewal. Used by the confirm screen and the 72-hour auto-accept.
--   2. extend_brief_pause: "Extend my pause" on the confirm screen. A later
--      return date, up to the existing maximum (3 months from the pause); the
--      waiting area is set aside and recalculated again 7 days before the new
--      date.
--
-- ⚠️ C10: A NEW FUNCTION BESIDE promote_lead_brief (0164), never a change to
-- it. promote_lead_brief promotes a `scheduled` row only, and Lead Brief Phase 6
-- may also touch it. Function-overlap check: neither name below exists in any
-- other migration or open branch.
--
-- ⚠️ BOTH TAKE THE SAME ADVISORY LOCK as every other brief write (0164, 0168):
-- 'lead_brief:' || customer_id. So a confirm cannot race the recalculation, the
-- editor, the renewal cron or the auto-accept.
--
-- ⚠️ THE ACTIVE ROW IS SUPERSEDED BEFORE THE PENDING ONE IS MADE ACTIVE: the
-- one-active index (0162) is checked per statement and is not deferrable.
--
-- ⚠️ FIRST PICKS. The caller passes the first picks it recomputed from live
-- supply (the same engine call as the editor's), or null when supply could
-- not be read, in which case the stored ones are kept. Either way any first
-- pick another customer's active brief now covers is dropped, never added:
-- promote_lead_brief's rule, with one difference. A customer on a LONG pause
-- holds no area (locked decision 3, Phase 2's toOtherBriefs), so their brief
-- blocks nothing here.
--
-- ⚠️ The n8n event's subject (0168, n8n_events.subject_id) is the PENDING
-- BRIEF from Phase 3 on, not the pause episode: an extended pause is
-- recalculated again, and one event per episode would swallow the second
-- WhatsApp. The table is unchanged; only what the app writes into it moves.
--
-- Neither function deletes anything, so this applies through the Supabase tool
-- (a statement containing a delete hangs it, as 0164 and 0168 found).
--
-- What this does NOT do:
--   - change promote_lead_brief, write_pending_lead_brief or any other
--     existing function, table or constraint;
--   - resume anyone. Restarting leads stays resumePausedCustomer's job (the
--     route and the auto-accept cron call it after a confirm);
--   - affect anyone today: 0 briefs exist, and nobody is on a brief pause.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Confirm a pending version
-- ---------------------------------------------------------------------------
-- p_auto: true from the 72-hour auto-accept. It stamps auto_accepted_at, and
-- it is refused ('not_due') until 72 hours after effective_at, so the cron can
-- never confirm early whatever it is handed.
create or replace function public.confirm_pending_lead_brief(
  p_customer_id uuid,
  p_expected_active_id uuid,
  p_pending_id uuid,
  p_first_picks text[],
  p_locked_until date,
  p_auto boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_active uuid;
  v_pending customer_lead_briefs%rowtype;
begin
  if p_locked_until is null then
    return jsonb_build_object('result', 'locked_until_required');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('lead_brief:' || p_customer_id::text, 0));

  select id into v_active
    from customer_lead_briefs
   where customer_id = p_customer_id and status = 'active';
  if v_active is null or v_active is distinct from p_expected_active_id then
    return jsonb_build_object('result', 'conflict');
  end if;

  select * into v_pending
    from customer_lead_briefs
   where id = p_pending_id
     and customer_id = p_customer_id
     and status = 'pending_confirmation'
   for update;
  if v_pending.id is null then
    return jsonb_build_object('result', 'not_pending');
  end if;

  if coalesce(p_auto, false)
     and (v_pending.effective_at is null or v_pending.effective_at + interval '72 hours' > now()) then
    return jsonb_build_object('result', 'not_due');
  end if;

  update customer_lead_briefs
     set status = 'superseded', superseded_at = now()
   where id = v_active;

  update customer_lead_briefs b
     set status = 'active',
         confirmed_at = now(),
         auto_accepted_at = case when coalesce(p_auto, false) then now() end,
         locked_until = p_locked_until,
         first_pick_outcodes = array(
           select f.oc
             from unnest(coalesce(p_first_picks, b.first_pick_outcodes)) with ordinality as f(oc, n)
            where not exists (
              select 1
                from customer_lead_briefs o
                join customers c on c.id = o.customer_id
               where o.customer_id <> p_customer_id
                 and o.status = 'active'
                 and c.is_active is not false
                 and c.subscription_status in ('active', 'past_due')
                 -- A long pause holds no area (locked decision 3).
                 and not (c.paused_at is not null and c.pause_holds_area is false)
                 and (
                   f.oc = any(o.service_outcodes)
                   or (
                     f.oc = any(o.first_pick_outcodes)
                     and o.locked_until is not null
                     and o.locked_until >= current_date
                   )
                 )
            )
            order by f.n
         )
   where b.id = v_pending.id;

  return jsonb_build_object(
    'result', 'confirmed',
    'id', v_pending.id,
    'version', v_pending.version,
    'auto', coalesce(p_auto, false)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Extend a long pause
-- ---------------------------------------------------------------------------
-- Only a LONG brief pause (locked decision 3): the return date moves later,
-- never past 3 months from the day they paused (the 0167 CHECK, judged here
-- first so the caller gets a result rather than an error). The area waiting
-- for them is superseded, and the episode is set back to "not recalculated",
-- so the resume cron recalculates it again 7 days before the new date.
--
-- Stripe needs nothing: a pause voids invoices with no end date (§21), and
-- the return is ours to decide.
create or replace function public.extend_brief_pause(
  p_customer_id uuid,
  p_pause_id uuid,
  p_resumes_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_episode subscription_pauses%rowtype;
  v_new date;
  v_customer uuid;
begin
  if p_resumes_at is null then
    return jsonb_build_object('result', 'resumes_at_required');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('lead_brief:' || p_customer_id::text, 0));

  select * into v_episode
    from subscription_pauses
   where id = p_pause_id
     and customer_id = p_customer_id
     and hold_area is false
     and ended_at is null
   for update;
  if v_episode.id is null then
    return jsonb_build_object('result', 'not_extendable');
  end if;

  if not exists (
    select 1 from customers c
     where c.id = p_customer_id
       and c.paused_at is not null
       and c.pause_holds_area is false
  ) then
    return jsonb_build_object('result', 'not_paused');
  end if;

  v_new := (p_resumes_at at time zone 'Europe/London')::date;
  if p_resumes_at <= v_episode.resumes_at then
    return jsonb_build_object('result', 'not_later');
  end if;
  if v_new <= (now() at time zone 'Europe/London')::date then
    return jsonb_build_object('result', 'too_soon');
  end if;
  if v_new > ((v_episode.paused_at at time zone 'Europe/London')::date + interval '3 months')::date then
    return jsonb_build_object('result', 'too_late');
  end if;

  -- The waiting area: recalculated again before the new date.
  update customer_lead_briefs
     set status = 'superseded', superseded_at = now()
   where customer_id = p_customer_id and status = 'pending_confirmation';

  update subscription_pauses
     set resumes_at = p_resumes_at,
         recalibrated_at = null,
         pending_brief_id = null
   where id = v_episode.id;

  update customers
     set pause_resumes_at = p_resumes_at,
         -- The notice belongs to the old date (0101); the new one gets its own.
         pause_ending_notice_sent_at = null,
         updated_at = now()
   where id = p_customer_id
     and paused_at is not null
     and pause_holds_area is false
  returning id into v_customer;
  if v_customer is null then
    -- Checked above under the lock; a concurrent resume would have to clear
    -- paused_at without the lock. Undo rather than leave the episode moved.
    raise exception 'extend_brief_pause: customer % is no longer on a long pause', p_customer_id;
  end if;

  return jsonb_build_object('result', 'extended', 'resumes_at', p_resumes_at);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Service role only
-- ---------------------------------------------------------------------------
revoke execute on function public.confirm_pending_lead_brief(uuid, uuid, uuid, text[], date, boolean)
  from public, anon, authenticated;
grant execute on function public.confirm_pending_lead_brief(uuid, uuid, uuid, text[], date, boolean)
  to service_role;

revoke execute on function public.extend_brief_pause(uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.extend_brief_pause(uuid, uuid, timestamptz) to service_role;
