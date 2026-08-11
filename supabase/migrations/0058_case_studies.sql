-- ============================================================================
-- Case studies — real lead journeys, anonymised, stored as structured data.
--
-- Stored as data rather than prose because the teaching content is the SHAPE of
-- the trail: how many touches, over how many days, through which channels, and
-- where the setbacks fell. One component renders every trail identically; nine
-- hand-written tables drift apart. Case ten becomes data entry.
--
-- ANONYMISATION IS ENFORCED BY THE SCHEMA, NOT BY EDITORIAL CARE.
--
--   * There is no name column, and no first_name column. There is nowhere for a
--     name to be typed, which is the only reliable way to ensure one never is.
--   * There is no date column anywhere. Events carry day_offset, an integer
--     counted from enquiry. A real date plus a region can re-identify a
--     landlord; a day offset cannot.
--   * property_summary carries a region. There is no address or postcode
--     column, so no town can be recorded even by accident.
--
-- Figures in the seeded prose are rounded to the nearest £500 for the same
-- reason. That one is a content rule the schema cannot enforce — but every
-- structural route to identification is closed above.
--
-- Additive only. Nothing here reads, writes or derives from lead_balance,
-- gr_lead_balance, monthly_allocation, leads_received_this_month, or any
-- billing, pacing or capacity column.
-- ============================================================================

create table if not exists public.case_studies (
  id                uuid primary key default gen_random_uuid(),
  slug              text not null unique,
  reference         text not null,
  outcome           text not null check (outcome in ('signed', 'lost')),
  loss_reason       text check (loss_reason in (
                      'ghosted_pre_meeting', 'competitor',
                      'numbers_did_not_stack', 'timing')),
  gate_reached      text not null check (gate_reached in ('pre_meeting', 'meeting_or_after')),
  days_to_outcome   integer not null,
  property_summary  text not null,
  headline          text not null,
  summary           text not null,
  lesson_markdown   text,

  emails_out        integer,
  calls_made        integer,
  calls_answered    integer,
  inbound_replies   integer,
  meetings_sat      integer,
  had_no_show       boolean not null default false,
  offer_applied     boolean not null default false,

  data_confidence   text not null check (data_confidence in ('crm_verified', 'partly_reconstructed')),
  sort_order        integer not null default 0,
  is_published      boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- A loss without a reason teaches nothing, and a win with one is a
  -- contradiction. Both directions are enforced so neither can be entered.
  constraint case_studies_loss_reason_matches_outcome check (
    (outcome = 'lost'   and loss_reason is not null)
    or
    (outcome = 'signed' and loss_reason is null)
  )
);

create index if not exists idx_case_studies_published_order
  on public.case_studies(is_published, sort_order);

create table if not exists public.case_study_events (
  id             uuid primary key default gen_random_uuid(),
  case_study_id  uuid not null references public.case_studies(id) on delete cascade,
  -- Days from enquiry, 0-based. Deliberately not a date; see the header.
  day_offset     integer not null check (day_offset >= 0),
  channel        text not null check (channel in (
                   'form', 'email', 'call', 'sms',
                   'web_meeting', 'offer', 'telemetry', 'onboarding')),
  direction      text not null check (direction in ('outbound', 'inbound', 'none')),
  description    text not null,
  is_setback     boolean not null default false,
  is_outcome     boolean not null default false,
  sort_order     integer not null default 0
);

create index if not exists idx_case_study_events_ordering
  on public.case_study_events(case_study_id, day_offset, sort_order);

-- ---------------------------------------------------------------------------
-- RLS — same shape as training_modules (0057).
-- ---------------------------------------------------------------------------
alter table public.case_studies      enable row level security;
alter table public.case_study_events enable row level security;

drop policy if exists "case_studies_select_published" on public.case_studies;
create policy "case_studies_select_published" on public.case_studies
  for select using (
    auth.role() = 'authenticated' and is_published = true
  );

-- Events inherit their parent's visibility through an EXISTS subquery rather
-- than a denormalised published flag. A copied flag is a second source of truth
-- that can fall out of step with the first, and the failure mode is unpublished
-- events remaining readable after their case study is withdrawn.
drop policy if exists "case_study_events_select_published" on public.case_study_events;
create policy "case_study_events_select_published" on public.case_study_events
  for select using (
    auth.role() = 'authenticated'
    and exists (
      select 1 from public.case_studies c
      where c.id = case_study_events.case_study_id
        and c.is_published = true
    )
  );

-- No INSERT, UPDATE or DELETE policy on either table. Every write goes through
-- an admin server route on the service role.

-- ---------------------------------------------------------------------------
-- Atomic event replacement.
--
-- The admin form sends the whole events array and it replaces the stored set
-- wholesale. Done as two client calls, a failure between the delete and the
-- insert leaves a case study with no events at all — worse than a save that
-- failed outright, because it looks like a successful edit. A function body is
-- a single transaction, so the delete and the insert either both land or
-- neither does.
--
-- SECURITY DEFINER with an empty search_path, and EXECUTE revoked from anon and
-- authenticated: this is a service-role tool called from an admin route, not a
-- customer-facing RPC. Re-asserted explicitly because a later
-- CREATE OR REPLACE would silently discard the ACL (the 0049 lesson).
-- ---------------------------------------------------------------------------
create or replace function public.replace_case_study_events(
  p_case_study_id uuid,
  p_events jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.case_studies where id = p_case_study_id) then
    raise exception 'Case study % not found', p_case_study_id;
  end if;

  delete from public.case_study_events where case_study_id = p_case_study_id;

  insert into public.case_study_events
    (case_study_id, day_offset, channel, direction, description, is_setback, is_outcome, sort_order)
  select
    p_case_study_id,
    (e->>'day_offset')::integer,
    e->>'channel',
    e->>'direction',
    e->>'description',
    coalesce((e->>'is_setback')::boolean, false),
    coalesce((e->>'is_outcome')::boolean, false),
    coalesce((e->>'sort_order')::integer, 0)
  from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) as e;
end;
$$;

revoke all on function public.replace_case_study_events(uuid, jsonb) from public;
revoke all on function public.replace_case_study_events(uuid, jsonb) from anon;
revoke all on function public.replace_case_study_events(uuid, jsonb) from authenticated;

-- ---------------------------------------------------------------------------
-- Seed lives in supabase/seed/case_studies_seed.sql, NOT here.
--
-- An earlier draft of this migration carried its own copy of the nine
-- journeys. The authored seed corrects several tallies against it — Case 03's
-- call counts, Case 04's inbound replies, the pre-meeting cases' email and
-- call figures — and flags a contradiction in Case 02 that has to be resolved
-- before publishing. Two seeds cannot both be right, and ON CONFLICT DO
-- NOTHING means whichever ran first would silently win. So this migration
-- creates the schema and the seed file fills it.
--
-- Run after this migration has applied. It is safe to re-run.
-- ---------------------------------------------------------------------------

-- Point the "Why leads don't sign" module at the comparison view. Stays
-- unpublished; the rest of that article body is being drafted separately.
update public.training_modules
set body_markdown = $t$The nine case studies behind this article are at /dashboard/training/case-studies, where all nine journeys can be compared side by side.

[Article body to follow.]$t$,
    updated_at = now()
where slug = 'why-leads-dont-sign'
  and body_markdown is null;
