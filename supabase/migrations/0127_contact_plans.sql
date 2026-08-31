-- ---------------------------------------------------------------------------
-- 0127 — Contact plans: the five-attempt sequence, executed per lead
--
-- §42. Every lead gets a plan of five attempts over nine days — call, WhatsApp,
-- email, call, WhatsApp — each carrying an OBJECTIVE rather than a written
-- message. The operator sees where each landlord sits in that plan, does the
-- attempt with one click, and the click is what records it.
--
-- WHY THIS REUSES §40.13's TABLES RATHER THAN ADDING ITS OWN. `cadence.ts`,
-- `advanceRun`, `stopRun`, and the cascade that kills a run when its assignment
-- is discarded, filter-released or swapped are the hardest parts of this and
-- they are already built and tested. What they have never had is a customer:
-- production carries 0 sequences, 0 steps, 0 runs and 0 drafts, because every
-- path ended at `sendOneMessage`, which refuses without a connected TimelinesAI
-- workspace — and there are ZERO connected workspaces. This migration adds the
-- delivery mode that lets the same machinery drive a to-do list instead.
--
-- ⚠️ INERT ON ITS OWN. Every column is nullable or defaults to today's meaning,
-- the kill switch ships 'false', and no existing function, predicate or trigger
-- is redefined. Nothing reads any of it until the code lands. Nothing here
-- touches a balance, counter, pacing or capacity column, so a lagging migration
-- cannot affect lead allocation.
-- ---------------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------------
-- 1 — Delivery mode. THE SAFETY BOUNDARY OF THE WHOLE FEATURE.
--
-- ⚠️ Without this the sending phase in /api/cron/poll-whatsapp-status picks up
-- a contact-plan attempt, hands it to sendOneMessage, gets `not_connected`
-- back, and SEQUENCE_STOP_CODES maps that to stopRun("no_connection") — which
-- sweeps every remaining attempt on the run to 'skipped'. The plan would die on
-- attempt 1 for every customer, silently, and look like the feature simply not
-- working.
--
-- 'auto'   — the §40.13 behaviour: drafted, then sent through the operator's
--            own connected workspace. Unchanged, and the default, so every
--            existing row keeps exactly the meaning it has today.
-- 'manual' — the operator does it themselves from the to-do list. Never goes
--            near sendOneMessage.
-- ---------------------------------------------------------------------------
alter table public.message_sequences
  add column if not exists delivery text not null default 'auto';

alter table public.message_sequences
  drop constraint if exists message_sequences_delivery_check;
alter table public.message_sequences
  add constraint message_sequences_delivery_check
  check (delivery in ('auto','manual'));

comment on column public.message_sequences.delivery is
  'auto = sent through the operator''s connected workspace (§40.13). manual = the operator does it from the to-do list and it must NEVER reach sendOneMessage, which would stop the run with no_connection (§42).';

-- A mixed plan is call + WhatsApp + email, which the two-value channel column
-- could not express. The sequence-level column stays as the default for steps
-- that do not override it.
alter table public.message_sequences
  drop constraint if exists message_sequences_channel_check;
alter table public.message_sequences
  add constraint message_sequences_channel_check
  check (channel in ('email','whatsapp','mixed'));


-- ---------------------------------------------------------------------------
-- 2 — Channel and objective, PER STEP.
--
-- ⚠️ ON THE STEP, NOT THE SEQUENCE, AND THAT IS THE POINT. The finding this
-- feature is built on is about ORDER: a cold call is answered ~17% of the time,
-- and once a message or email has gone first the following call is answered
-- 0-4%. A rotation cannot be expressed by one channel on the parent row.
--
-- 'call' is new to this codebase. Nothing sends a call — it is a `tel:` link
-- the operator taps — which is exactly why it can exist here without touching
-- any send path.
--
-- `mode = 'objective'` needs no body_template: the step's existing `brief` IS
-- the deliverable, shown to the operator rather than fed to a drafter. That is
-- why the 0122 manual-body CHECK below still only binds 'manual'.
-- ---------------------------------------------------------------------------
alter table public.message_sequence_steps
  add column if not exists channel text not null default 'whatsapp';

alter table public.message_sequence_steps
  drop constraint if exists message_sequence_steps_channel_check;
alter table public.message_sequence_steps
  add constraint message_sequence_steps_channel_check
  check (channel in ('call','whatsapp','email'));

alter table public.message_sequence_steps
  drop constraint if exists message_sequence_steps_mode_check;
alter table public.message_sequence_steps
  add constraint message_sequence_steps_mode_check
  check (mode in ('ai','manual','objective'));

comment on column public.message_sequence_steps.channel is
  'How this attempt reaches the landlord. Per step because the sequence alternates deliberately — leading with a message costs roughly three quarters of the call answer rate (§42).';


-- ---------------------------------------------------------------------------
-- 3 — The attempt ledger.
--
-- `message_sequence_drafts` already is one row per (run, step) with a state
-- machine and a send_after. A contact-plan attempt is the same shape, so it
-- carries the objective in `body` and gains the four columns below.
--
-- ⚠️ `done_source` IS THE TRUST BOUNDARY, AND IT IS THE MOST IMPORTANT COLUMN
-- HERE. `lead_events` is the engagement basis for escalation, pooling, the
-- reclaim decision and the scoreboard (§3), and CLIENT_LEAD_EVENT_TYPES is
-- deliberately narrow so a customer cannot manufacture engagement. A "mark
-- complete" button that wrote tel_click would hand every customer a way to
-- shield any lead from ever being escalated away from them.
--
--   'click'  — they used the WhatsApp/Call/Email button. Records a lead_events
--              row AND completes the attempt. done_event_id points at it, so
--              any adherence figure can be taken back to the click behind it.
--   'manual' — "I did this another way". Completes the attempt ONLY. No
--              lead_events row, no engagement score, no escalation shield.
--
-- Adherence counts both, because holding an operator to their own word is the
-- point. Engagement scoring counts only clicks. Admin sees the split, which is
-- what makes a customer whose completions are overwhelmingly manual visible.
--
-- ⚠️ `call_outcome` EXISTS BECAUSE THE SEQUENCE BRANCHES ON IT. A tel_click says
-- they dialled, never that anyone picked up, and attempt 2 is defined as "same
-- day, only if the call went unanswered". 'answered' pauses the run: firing the
-- next attempt at a landlord who is mid-conversation is the one way this
-- feature could actively embarrass an operator.
-- ---------------------------------------------------------------------------
alter table public.message_sequence_drafts
  add column if not exists channel       text not null default 'whatsapp',
  add column if not exists done_at       timestamptz,
  add column if not exists done_event_id uuid references public.lead_events(id) on delete set null,
  add column if not exists done_source   text,
  add column if not exists call_outcome  text;

alter table public.message_sequence_drafts
  drop constraint if exists message_sequence_drafts_channel_check;
alter table public.message_sequence_drafts
  add constraint message_sequence_drafts_channel_check
  check (channel in ('call','whatsapp','email'));

alter table public.message_sequence_drafts
  drop constraint if exists message_sequence_drafts_done_source_check;
alter table public.message_sequence_drafts
  add constraint message_sequence_drafts_done_source_check
  check (done_source is null or done_source in ('click','manual','auto'));

alter table public.message_sequence_drafts
  drop constraint if exists message_sequence_drafts_call_outcome_check;
alter table public.message_sequence_drafts
  add constraint message_sequence_drafts_call_outcome_check
  check (call_outcome is null
         or call_outcome in ('answered','no_answer','voicemail'));

-- A manual completion has no event to point at, by definition — that is the
-- whole distinction — so done_event_id is only ever set alongside 'click'.
alter table public.message_sequence_drafts
  drop constraint if exists message_sequence_drafts_done_event_source_check;
alter table public.message_sequence_drafts
  add constraint message_sequence_drafts_done_event_source_check
  check (done_event_id is null or done_source = 'click');

comment on column public.message_sequence_drafts.done_source is
  'click = completed by a recorded lead_events click (done_event_id points at it). manual = the operator said they did it another way; completes the attempt but writes NO engagement event (§42).';

-- Serves "which attempt does this click close?": the earliest outstanding
-- attempt on this run for that channel.
create index if not exists message_sequence_drafts_open_attempt_idx
  on public.message_sequence_drafts (run_id, channel, step_number)
  where state = 'pending';


-- ---------------------------------------------------------------------------
-- 4 — The landlord-level rate limit.
--
-- 69% of open landlords (126 of 182) are held by two or more operators and 37
-- by three. Five attempts each is fifteen approaches to one person, which is
-- mass messaging however carefully each operator behaves.
--
-- ⚠️ KEYED ON THE PHONE, NOT ON lead_id. One landlord arrives as several `leads`
-- rows — 28 exact duplicate groups when 0070 was written, and deliberately no
-- unique constraint on the identity key — so lead_id under-counts in exactly
-- the case that matters.
--
-- ⚠️ IT RETURNS A BARE BOOLEAN AND NOTHING ELSE. Not a count, not a timestamp,
-- not who. §40.12 settled this and §19.7 settled it before that: a richer
-- return value is a probe that tells operator A when operator B is working a
-- shared landlord. The caller defers the attempt by a day; the operator is
-- never told why, and cannot be.
--
-- Counts operator-generated contact only. `nudge_sent` and `message_received`
-- are excluded for the §3 reason — our own reminders and the landlord's own
-- reply are not approaches by anybody.
-- ---------------------------------------------------------------------------
create or replace function public.landlord_approach_ok(
  p_phone_norm text,
  p_max_day    integer,
  p_max_week   integer
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- A landlord we cannot identify by phone is not rate limited: there is no
  -- key to group them by, and refusing every such lead would silently stop the
  -- plan for anyone whose number did not parse.
  select case when p_phone_norm is null then true else (
    select
      count(*) filter (where e.created_at >= now() - interval '1 day')  < p_max_day
      and
      count(*) filter (where e.created_at >= now() - interval '7 days') < p_max_week
    from public.lead_events e
    join public.lead_assignments a on a.id = e.assignment_id
    join public.leads l            on l.id = a.lead_id
    where public.normalised_phone(l.phone) = p_phone_norm
      and e.event_type in ('tel_click','whatsapp_click','mailto_click','message_sent')
      and e.created_at >= now() - interval '7 days'
  ) end;
$$;

revoke all on function public.landlord_approach_ok(text, integer, integer) from public;
revoke all on function public.landlord_approach_ok(text, integer, integer) from anon;
revoke all on function public.landlord_approach_ok(text, integer, integer) from authenticated;
grant execute on function public.landlord_approach_ok(text, integer, integer) to service_role;

-- The existing idx_leads_identity_key leads on lead_identity_key(...) and
-- cannot serve a lookup by phone alone.
create index if not exists leads_normalised_phone_idx
  on public.leads (public.normalised_phone(phone));


-- ---------------------------------------------------------------------------
-- 5 — Adherence: is the customer actually doing the work?
--
-- ONE FUNCTION, THREE READERS — the customer's own figures, the admin panel and
-- the weekly notice. Three separate readings of "are they keeping up" would
-- eventually disagree, and the customer-facing one disagreeing with the admin
-- one is the version of that failure that costs a support argument.
--
-- `due` counts attempts that have fallen due, so an attempt scheduled for next
-- Tuesday is neither done nor missed — it has not been asked for yet. Including
-- it would make every customer look behind on the day they join.
-- ---------------------------------------------------------------------------
create or replace function public.get_customer_followup_adherence(
  p_since timestamptz default now() - interval '14 days'
)
returns table (
  customer_id         uuid,
  business_name       text,
  due                 integer,
  done                integer,
  done_by_click       integer,
  done_manually       integer,
  skipped             integer,
  overdue             integer,
  oldest_overdue_days integer,
  adherence_pct       integer,
  last_action_at      timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with attempts as (
    select d.customer_id,
           d.state,
           d.done_at,
           d.done_source,
           d.send_after
    from public.message_sequence_drafts d
    join public.message_sequence_runs   r on r.id = d.run_id
    join public.message_sequences       s on s.id = r.sequence_id
    where s.delivery = 'manual'
      and d.send_after >= p_since
      and d.send_after <= now()
  )
  select c.id,
         c.business_name,
         count(a.*)::int,
         count(a.*) filter (where a.state = 'sent')::int,
         count(a.*) filter (where a.state = 'sent' and a.done_source = 'click')::int,
         count(a.*) filter (where a.state = 'sent' and a.done_source = 'manual')::int,
         count(a.*) filter (where a.state = 'cancelled')::int,
         count(a.*) filter (where a.state = 'pending')::int,
         coalesce(
           max(extract(day from now() - a.send_after))
             filter (where a.state = 'pending'),
           0
         )::int,
         case when count(a.*) = 0 then null
              else round(100.0 * count(a.*) filter (where a.state = 'sent')
                               / count(a.*))::int
         end,
         max(a.done_at)
  from public.customers c
  join attempts a on a.customer_id = c.id
  group by c.id, c.business_name;
$$;

revoke all on function public.get_customer_followup_adherence(timestamptz) from public;
revoke all on function public.get_customer_followup_adherence(timestamptz) from anon;
revoke all on function public.get_customer_followup_adherence(timestamptz) from authenticated;
grant execute on function public.get_customer_followup_adherence(timestamptz) to service_role;


-- ---------------------------------------------------------------------------
-- 6 — Switches.
--
-- ⚠️ `contact_plans_enabled` SHIPS FALSE, the §40.13 precedent. What it gates
-- puts real approaches in front of members of the public.
--
-- The landlord limits are separate from `messaging_lead_cooldown_hours` (0120)
-- on purpose: that one guards SENDS through a connected workspace and cannot
-- see a hand-off click or a call at all, which is every approach this feature
-- produces.
-- ---------------------------------------------------------------------------
insert into public.system_settings (key, value) values
  ('contact_plans_enabled',              'false'),
  -- One approach a day, three a week, across EVERY operator holding that
  -- landlord. A three-holder landlord therefore hears from somebody about three
  -- times a week rather than fifteen times in nine days.
  ('contact_landlord_max_per_day',       '1'),
  ('contact_landlord_max_per_week',      '3'),
  -- Below this, with at least the minimum overdue, the weekly notice fires.
  ('followup_adherence_notice_pct',      '50'),
  ('followup_adherence_notice_min_overdue', '5')
on conflict (key) do nothing;

commit;
