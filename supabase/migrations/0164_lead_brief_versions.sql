-- ============================================================================
-- 0164 — Lead Brief versions: the "Your brief" editor (Phase 5, Part B)
--
-- Editing a brief makes a new version (build prompt, Phase 5). Two kinds of
-- edit, and they take effect at different times:
--
--   - The ranking and the levels of non-essential priorities apply NOW: a new
--     active version, same area. If an area change is pending, its priorities
--     are updated too, so the edit is not lost at renewal.
--   - The area (base, extra areas, travel, essentials, similar areas) applies
--     at the NEXT RENEWAL: one `scheduled` version, replaced on a re-save and
--     deleted on cancel.
--
-- What this migration adds:
--
--   1. 'scheduled' joins the status CHECK.
--   2. At most ONE change in flight per customer: a scheduled row or a row
--      pending confirmation (A10), never both. A customer's own area save
--      supersedes a pending one (it is their newer choice).
--   3. save_scheduled_lead_brief: store or replace the scheduled row.
--   4. promote_lead_brief: make a version active (a priorities edit, or a due
--      scheduled row at renewal).
--   5. due_scheduled_lead_briefs: the scheduled rows whose renewal has come.
--
-- ⚠️ EVERY WRITE TAKES A PER-CUSTOMER ADVISORY LOCK, and checks that the
-- active version is still the one the caller read (expected_active_id). Two
-- tabs, or a tab and the renewal cron, therefore cannot both build on the same
-- active row: the second gets 'conflict' and asks the customer to reload. The
-- lock is advisory, NOT a row lock on customers, which every assignment
-- updates.
--
-- ⚠️ VERSIONS ARE ALLOCATED HERE, under that lock, never by the caller.
--
-- "Due" is a renewal having happened since the row was saved:
-- replacement_cycle_start(customer) > created_at::date. That is the date
-- nextGrantDate prints (the editor tells the customer "these changes start on
-- {date}") and the date reset_monthly_counts resets on, so there is no stored
-- date to drift when the anchor moves. A re-save deletes and re-inserts the
-- scheduled row, so created_at is always the latest save.
--
-- What this migration does NOT do:
--   - touch routing. get_brief_candidates_for_lead (0163) reads ACTIVE rows
--     only, so a scheduled row is invisible to it until promoted;
--   - change any balance, counter, pacing or capacity column;
--   - affect anyone today: 0 briefs exist, and nobody is flagged.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The status CHECK gains 'scheduled'
-- ---------------------------------------------------------------------------
alter table public.customer_lead_briefs
  drop constraint if exists customer_lead_briefs_status_check;
alter table public.customer_lead_briefs
  add constraint customer_lead_briefs_status_check check (
    status in ('active', 'pending_confirmation', 'scheduled', 'superseded')
  );

-- ---------------------------------------------------------------------------
-- 2. One change in flight per customer
-- ---------------------------------------------------------------------------
create unique index if not exists customer_lead_briefs_one_in_flight
  on public.customer_lead_briefs (customer_id)
  where status in ('scheduled', 'pending_confirmation');

comment on table public.customer_lead_briefs is
  'Lead Brief versions, Management only (0162, 0164). Exactly one active row '
  'per customer; at most one change in flight (scheduled or '
  'pending_confirmation). Written and read on the service role only (RLS on, '
  'no policies).';

-- ---------------------------------------------------------------------------
-- 3. Store or replace the customer's scheduled area change
-- ---------------------------------------------------------------------------
-- p_row carries the computed brief as the editor route built it (briefRow.ts);
-- only the fixed list of columns below is read from it. status, origin,
-- version, confirmed_at and locked_until are decided here, not by the caller.
create or replace function public.save_scheduled_lead_brief(
  p_customer_id uuid,
  p_expected_active_id uuid,
  p_row jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_active uuid;
  v_version integer;
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('lead_brief:' || p_customer_id::text, 0));

  select id into v_active
    from customer_lead_briefs
   where customer_id = p_customer_id and status = 'active';
  if v_active is null or v_active is distinct from p_expected_active_id then
    return jsonb_build_object('result', 'conflict');
  end if;

  -- The customer's own newer choice replaces a wider area awaiting their
  -- confirmation (A10), and any earlier scheduled change.
  update customer_lead_briefs
     set status = 'superseded', superseded_at = now()
   where customer_id = p_customer_id and status = 'pending_confirmation';
  delete from customer_lead_briefs
   where customer_id = p_customer_id and status = 'scheduled';

  select coalesce(max(version), 0) + 1 into v_version
    from customer_lead_briefs where customer_id = p_customer_id;

  insert into customer_lead_briefs (
    customer_id, version, status, origin,
    base_postcode, base_outcode, operating_mode, travel_limit_miles, allocation,
    priorities, essentials, min_bedrooms, min_gross,
    priority_outcodes, similar_areas,
    service_radius_miles, service_outcodes, first_pick_outcodes, pace_outcodes,
    mix_leans_nearby, expected_mix, locked_until, confirmed_at
  ) values (
    p_customer_id, v_version, 'scheduled', 'customer',
    p_row ->> 'base_postcode',
    p_row ->> 'base_outcode',
    p_row ->> 'operating_mode',
    (p_row ->> 'travel_limit_miles')::integer,
    (p_row ->> 'allocation')::integer,
    p_row -> 'priorities',
    array(select jsonb_array_elements_text(coalesce(p_row -> 'essentials', '[]'::jsonb))),
    (p_row ->> 'min_bedrooms')::integer,
    (p_row ->> 'min_gross')::integer,
    array(select jsonb_array_elements_text(coalesce(p_row -> 'priority_outcodes', '[]'::jsonb))),
    array(select jsonb_array_elements_text(coalesce(p_row -> 'similar_areas', '[]'::jsonb))),
    (p_row ->> 'service_radius_miles')::integer,
    array(select jsonb_array_elements_text(coalesce(p_row -> 'service_outcodes', '[]'::jsonb))),
    array(select jsonb_array_elements_text(coalesce(p_row -> 'first_pick_outcodes', '[]'::jsonb))),
    array(select jsonb_array_elements_text(coalesce(p_row -> 'pace_outcodes', '[]'::jsonb))),
    coalesce((p_row ->> 'mix_leans_nearby')::boolean, false),
    coalesce(p_row -> 'expected_mix', '{}'::jsonb),
    -- Set when it is promoted, for the cycle it starts in.
    null,
    now()
  )
  returning id into v_id;

  return jsonb_build_object('result', 'saved', 'id', v_id, 'version', v_version);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Make a version active
-- ---------------------------------------------------------------------------
-- With no source: a priorities edit. A copy of the active row with the new
-- priorities becomes active now, same area and same lock; a scheduled row's
-- priorities are updated too when p_scheduled_priorities is given.
--
-- With a source: a scheduled row whose renewal has come. It becomes active
-- with p_locked_until (required), and any first pick that another customer's
-- active brief now covers is dropped — never added, so it only ever narrows to
-- what the engine would allow today (areas.ts, computeFirstPicks).
--
-- ⚠️ The active row is superseded BEFORE the new one is made active: the
-- one-active index (0162) is checked per statement and is not deferrable.
create or replace function public.promote_lead_brief(
  p_customer_id uuid,
  p_expected_active_id uuid,
  p_source_id uuid,
  p_priorities jsonb,
  p_scheduled_priorities jsonb,
  p_locked_until date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_active customer_lead_briefs%rowtype;
  v_source customer_lead_briefs%rowtype;
  v_version integer;
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('lead_brief:' || p_customer_id::text, 0));

  select * into v_active
    from customer_lead_briefs
   where customer_id = p_customer_id and status = 'active';
  if v_active.id is null or v_active.id is distinct from p_expected_active_id then
    return jsonb_build_object('result', 'conflict');
  end if;

  if p_source_id is null then
    if p_priorities is null then
      return jsonb_build_object('result', 'priorities_required');
    end if;

    update customer_lead_briefs
       set status = 'superseded', superseded_at = now()
     where id = v_active.id;

    select coalesce(max(version), 0) + 1 into v_version
      from customer_lead_briefs where customer_id = p_customer_id;

    insert into customer_lead_briefs (
      customer_id, version, status, origin,
      base_postcode, base_outcode, operating_mode, travel_limit_miles, allocation,
      priorities, essentials, min_bedrooms, min_gross,
      priority_outcodes, similar_areas,
      service_radius_miles, service_outcodes, first_pick_outcodes, pace_outcodes,
      mix_leans_nearby, expected_mix, locked_until, confirmed_at
    ) values (
      p_customer_id, v_version, 'active', 'customer',
      v_active.base_postcode, v_active.base_outcode, v_active.operating_mode,
      v_active.travel_limit_miles, v_active.allocation,
      p_priorities, v_active.essentials, v_active.min_bedrooms, v_active.min_gross,
      v_active.priority_outcodes, v_active.similar_areas,
      v_active.service_radius_miles, v_active.service_outcodes,
      v_active.first_pick_outcodes, v_active.pace_outcodes,
      v_active.mix_leans_nearby, v_active.expected_mix, v_active.locked_until, now()
    )
    returning id into v_id;

    if p_scheduled_priorities is not null then
      update customer_lead_briefs
         set priorities = p_scheduled_priorities
       where customer_id = p_customer_id and status = 'scheduled';
    end if;

    return jsonb_build_object('result', 'promoted', 'id', v_id, 'version', v_version);
  end if;

  if p_locked_until is null then
    return jsonb_build_object('result', 'locked_until_required');
  end if;

  select * into v_source
    from customer_lead_briefs
   where id = p_source_id and customer_id = p_customer_id and status = 'scheduled'
   for update;
  if v_source.id is null then
    return jsonb_build_object('result', 'not_scheduled');
  end if;

  update customer_lead_briefs
     set status = 'superseded', superseded_at = now()
   where id = v_active.id;

  update customer_lead_briefs b
     set status = 'active',
         confirmed_at = coalesce(b.confirmed_at, now()),
         locked_until = p_locked_until,
         first_pick_outcodes = array(
           select f.oc
             from unnest(b.first_pick_outcodes) with ordinality as f(oc, n)
            where not exists (
              select 1
                from customer_lead_briefs o
                join customers c on c.id = o.customer_id
               where o.customer_id <> p_customer_id
                 and o.status = 'active'
                 and c.is_active is not false
                 and c.subscription_status in ('active', 'past_due')
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
   where b.id = v_source.id;

  return jsonb_build_object('result', 'promoted', 'id', v_source.id, 'version', v_source.version);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. The scheduled rows whose renewal has come
-- ---------------------------------------------------------------------------
create or replace function public.due_scheduled_lead_briefs()
returns table (customer_id uuid, brief_id uuid, active_id uuid, allocation integer)
language sql
stable
security definer
set search_path = public
as $$
  select b.customer_id, b.id, a.id, b.allocation
    from customer_lead_briefs b
    join customers c on c.id = b.customer_id
    left join customer_lead_briefs a
      on a.customer_id = b.customer_id and a.status = 'active'
   where b.status = 'scheduled'
     and public.replacement_cycle_start(c) > b.created_at::date
   order by b.created_at;
$$;

-- ---------------------------------------------------------------------------
-- 6. Service role only
-- ---------------------------------------------------------------------------
revoke execute on function public.save_scheduled_lead_brief(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.save_scheduled_lead_brief(uuid, uuid, jsonb) to service_role;

revoke execute on function public.promote_lead_brief(uuid, uuid, uuid, jsonb, jsonb, date)
  from public, anon, authenticated;
grant execute on function public.promote_lead_brief(uuid, uuid, uuid, jsonb, jsonb, date) to service_role;

revoke execute on function public.due_scheduled_lead_briefs()
  from public, anon, authenticated;
grant execute on function public.due_scheduled_lead_briefs() to service_role;
