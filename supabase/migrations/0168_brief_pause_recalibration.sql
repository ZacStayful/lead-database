-- ============================================================================
-- 0168 — Batch 04 Phase 2: a long pause's area recalculation, and an event
--        n8n can pick up
--
-- docs/build/04-area-changes-pause-topups.md (Phase 2) and the approved Phase 0
-- report, docs/build/04-phase0-report.md (C8, C9). Lead Brief customers only.
--
-- Locked decision 3: a pause over 4 weeks releases the area at once, and the
-- area is recalculated 7 days before return. When the recalculated area is
-- different, it is written as a `pending_confirmation` version (locked decision
-- 4) for the customer to confirm before their leads restart (Phase 3 builds the
-- screen). Nothing here makes anything active.
--
-- What it adds:
--
--   1. write_pending_lead_brief: store the recalculated area as the ONE change
--      in flight (0164), claiming the pause episode first so a second run, or
--      the cron and an early resume together, cannot both write one.
--   2. n8n_events: an outbox of events for n8n to pick up (C8). One event type
--      today, brief_area_updated, so n8n can send the WhatsApp whose wording
--      Zac approves. The app never holds that wording.
--   3. claim_n8n_events: hand n8n the unclaimed events, each exactly once.
--
-- ⚠️ C9: 0164 allows ONE change in flight per customer (a scheduled area change
-- or a pending one). The recalculation is computed from the customer's NEWEST
-- choice: their scheduled change if they have one, otherwise their active
-- brief. It then replaces that scheduled change, so their choice is the one
-- recalculated rather than lost. p_basis_id is the row the caller computed
-- from; if the customer saved a different scheduled change since, the write is
-- refused ('conflict') and the next run recalculates from the new one.
--
-- ⚠️ THE PAUSE EPISODE IS CLAIMED FIRST, by stamping recalibrated_at where it
-- is still null (claim-by-write, the credit_invoice discipline). A pause is
-- recalculated once.
--
-- ⚠️ C8: AN OUTBOX, PULLED BY n8n, never a push. n8n calls
-- POST /api/internal/n8n-events/claim on a schedule. A push needs a URL, and
-- events written before the URL was set would all go out the day it was. An
-- event is never handed out after 48 hours (the caller passes the window), so
-- a WhatsApp about a return that has already happened is never sent.
--
-- What this does NOT do:
--   - replace any existing function, or change any existing table;
--   - make a pending version active (Phase 3, confirm_pending_lead_brief);
--   - affect anyone today: 0 briefs exist, and nobody is on a brief pause.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Store the recalculated area, pending the customer's confirmation
-- ---------------------------------------------------------------------------
-- p_row carries the computed brief as briefRow.ts builds it; only the fixed
-- list of columns below is read from it. status, origin, version, confirmed_at,
-- locked_until and effective_at are decided here, not by the caller's row.
create or replace function public.write_pending_lead_brief(
  p_customer_id uuid,
  p_expected_active_id uuid,
  p_basis_id uuid,
  p_pause_id uuid,
  p_row jsonb,
  p_effective_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_active uuid;
  v_scheduled uuid;
  v_version integer;
  v_id uuid;
  v_claimed uuid;
begin
  if p_effective_at is null then
    return jsonb_build_object('result', 'effective_at_required');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('lead_brief:' || p_customer_id::text, 0));

  select id into v_active
    from customer_lead_briefs
   where customer_id = p_customer_id and status = 'active';
  if v_active is null or v_active is distinct from p_expected_active_id then
    return jsonb_build_object('result', 'conflict');
  end if;

  -- The basis must still be the customer's newest choice (C9).
  select id into v_scheduled
    from customer_lead_briefs
   where customer_id = p_customer_id and status = 'scheduled';
  if p_basis_id is distinct from coalesce(v_scheduled, v_active) then
    return jsonb_build_object('result', 'conflict');
  end if;

  -- Only a customer still on THIS long pause.
  if not exists (
    select 1 from customers c
     where c.id = p_customer_id
       and c.paused_at is not null
       and c.pause_holds_area is false
  ) then
    return jsonb_build_object('result', 'not_paused');
  end if;

  -- Claim the episode: once per pause.
  update subscription_pauses
     set recalibrated_at = now()
   where id = p_pause_id
     and customer_id = p_customer_id
     and hold_area is false
     and recalibrated_at is null
     and ended_at is null
  returning id into v_claimed;
  if v_claimed is null then
    return jsonb_build_object('result', 'not_claimable');
  end if;

  -- One change in flight (0164). The scheduled change is the basis and is
  -- replaced; a pending widening (Lead Brief Phase 6) is older than this
  -- recalculation from live supply, and is superseded.
  delete from customer_lead_briefs
   where customer_id = p_customer_id and status = 'scheduled';
  update customer_lead_briefs
     set status = 'superseded', superseded_at = now()
   where customer_id = p_customer_id and status = 'pending_confirmation';

  select coalesce(max(version), 0) + 1 into v_version
    from customer_lead_briefs where customer_id = p_customer_id;

  insert into customer_lead_briefs (
    customer_id, version, status, origin,
    base_postcode, base_outcode, operating_mode, travel_limit_miles, allocation,
    priorities, essentials, min_bedrooms, min_gross,
    priority_outcodes, similar_areas,
    service_radius_miles, service_outcodes, first_pick_outcodes, pace_outcodes,
    mix_leans_nearby, expected_mix, locked_until, confirmed_at, effective_at
  ) values (
    p_customer_id, v_version, 'pending_confirmation', 'recompute',
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
    -- Set when it is confirmed (Phase 3), for the cycle it starts in.
    null,
    -- Not confirmed: that is what pending means.
    null,
    p_effective_at
  )
  returning id into v_id;

  update subscription_pauses
     set pending_brief_id = v_id
   where id = v_claimed;

  return jsonb_build_object('result', 'written', 'id', v_id, 'version', v_version);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. The outbox n8n reads (C8)
-- ---------------------------------------------------------------------------
create table if not exists public.n8n_events (
  id           uuid primary key default gen_random_uuid(),
  -- A closed list: n8n branches on it, and a new type is a decision.
  event_type   text not null check (event_type in ('brief_area_updated')),
  customer_id  uuid not null references public.customers(id) on delete cascade,
  -- What the event is about, for the one-per-subject guard below. For
  -- brief_area_updated, the pause episode.
  subject_id   uuid not null,
  -- The facts n8n needs to fill in the message Zac approved. Never the
  -- message itself.
  payload      jsonb not null check (jsonb_typeof(payload) = 'object'),
  created_at   timestamptz not null default now(),
  -- Set when n8n claimed it. Claimed once, never handed out again.
  claimed_at   timestamptz,
  constraint n8n_events_one_per_subject unique (event_type, subject_id)
);

comment on table public.n8n_events is
  'Batch 04 (0168). Events for n8n to pick up through POST /api/internal/n8n-events/claim. '
  'Written and read on the service role only (RLS on, no policies).';

-- What the claim scans.
create index if not exists n8n_events_unclaimed_idx
  on public.n8n_events (created_at)
  where claimed_at is null;

alter table public.n8n_events enable row level security;

-- ---------------------------------------------------------------------------
-- 3. Hand n8n the unclaimed events, each once
-- ---------------------------------------------------------------------------
-- Claim-by-write: the rows are stamped in the same statement that returns
-- them, and `for update skip locked` lets two overlapping n8n runs share the
-- queue without either getting an event twice. An event older than
-- p_max_age_hours is never handed out: the message it was for is out of date.
--
-- ⚠️ Returns jsonb, not a table: a set-returning function is called by
-- PostgREST in a FROM clause, and §27.4 records a write that did not persist
-- through that path.
create or replace function public.claim_n8n_events(
  p_limit integer,
  p_max_age_hours integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_out jsonb;
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'p_limit must be between 1 and 100';
  end if;
  if p_max_age_hours is null or p_max_age_hours < 1 then
    raise exception 'p_max_age_hours must be at least 1';
  end if;

  with picked as (
    select e.id
      from n8n_events e
     where e.claimed_at is null
       and e.created_at > now() - make_interval(hours => p_max_age_hours)
     order by e.created_at, e.id
     limit p_limit
     for update skip locked
  ), claimed as (
    update n8n_events e
       set claimed_at = now()
      from picked
     where e.id = picked.id
    returning e.id, e.event_type, e.customer_id, e.payload, e.created_at
  )
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'id', c.id,
               'event_type', c.event_type,
               'customer_id', c.customer_id,
               'payload', c.payload,
               'created_at', c.created_at
             )
             order by c.created_at, c.id
           ),
           '[]'::jsonb
         )
    into v_out
    from claimed c;

  return v_out;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Service role only
-- ---------------------------------------------------------------------------
revoke execute on function public.write_pending_lead_brief(uuid, uuid, uuid, uuid, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function public.write_pending_lead_brief(uuid, uuid, uuid, uuid, jsonb, timestamptz)
  to service_role;

revoke execute on function public.claim_n8n_events(integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_n8n_events(integer, integer) to service_role;
