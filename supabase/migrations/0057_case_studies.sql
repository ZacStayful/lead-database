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
-- RLS — same shape as training_modules (0056).
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
-- Seed — nine journeys, three signed and six lost, all unpublished so they are
-- reviewed in the admin UI before any subscriber sees them.
--
-- The losses outnumber the wins on purpose. A case study set containing only
-- wins teaches that effort converts, which is the opposite of what this data
-- shows: cases 04, 05 and 06 absorbed the same work as the three that signed.
--
-- ON CONFLICT DO NOTHING throughout, so a re-run cannot overwrite edits.
-- ---------------------------------------------------------------------------
insert into public.case_studies (
  slug, reference, outcome, loss_reason, gate_reached, days_to_outcome,
  property_summary, headline, summary,
  emails_out, calls_made, calls_answered, inbound_replies, meetings_sat,
  had_no_show, offer_applied, data_confidence, sort_order, is_published
) values
(
  'case-01-no-show-then-signed', 'Case 01', 'signed', null, 'meeting_or_after', 20,
  $t$Two-bed, South East$t$,
  $t$A no-show and an expired deadline, then signed on the fifth answered call.$t$,
  $t$Nineteen touchpoints over twenty days. He engaged quickly, then went quiet, no-showed the second meeting and let the reduced-rate deadline lapse. A weaker operator writes him off at the no-show. He signed nine days after it.$t$,
  12, 6, 5, 6, 1, true, true, 'crm_verified', 10, false
),
(
  'case-02-contract-terms-in-writing', 'Case 02', 'signed', null, 'meeting_or_after', 15,
  $t$Three-bed apartment, East Midlands$t$,
  $t$The fastest of the three, and only because the block was two contract terms rather than doubt.$t$,
  $t$An existing short-let owner unhappy with his current manager. He already believed in the model, so the sell was "why us" rather than "why this". The block was contractual switching cost, and it closed the day it was put in writing.$t$,
  null, 6, 3, null, 1, true, false, 'partly_reconstructed', 20, false
),
(
  'case-03-two-decision-makers', 'Case 03', 'signed', null, 'meeting_or_after', 78,
  $t$One-bed initially, became two properties, Yorkshire$t$,
  $t$A dead six-week gap, an expired offer — and the offer expiring is what grew the deal.$t$,
  $t$Eleven weeks from enquiry to signature, with almost nothing happening in the middle. Two decision-makers, only one of whom enquired. The reduced rate lapsed, and the conversation reopening it turned a one-property deal into two.$t$,
  19, null, null, 11, 2, false, true, 'crm_verified', 30, false
),
(
  'case-04-lost-to-competitor', 'Case 04', 'lost', 'competitor', 'meeting_or_after', 56,
  $t$North West$t$,
  $t$The full process, run properly, over eight weeks — and she chose someone else.$t$,
  $t$Meeting sat, action plan delivered, reduced rate applied, follow-ups across two months. The same effort profile as all three of the signed cases above. She went with another company. This is the single most instructive record in the set.$t$,
  null, null, null, null, 1, false, true, 'partly_reconstructed', 40, false
),
(
  'case-05-not-ready-when-the-window-was-open', 'Case 05', 'lost', 'timing', 'meeting_or_after', 40,
  $t$West Yorkshire$t$,
  $t$Her numbers stacked up. She wasn't ready when the offer window was open.$t$,
  $t$Around £20,500 projected net from short-term letting against roughly £17,800 as a standard tenancy — a genuinely positive case. She sat a meeting, took two calls, received a reduced rate, then no-showed the second meeting, said she was still furnishing the property and needed a month, let the offer expire, and went elsewhere.$t$,
  null, null, 2, null, 1, true, true, 'partly_reconstructed', 50, false
),
(
  'case-06-numbers-didnt-beat-the-status-quo', 'Case 06', 'lost', 'numbers_did_not_stack', 'meeting_or_after', 28,
  $t$Seven-bed, East of England$t$,
  $t$Around £27,000 as a long let against roughly £25,000 net short-letting. This lead should not have converted.$t$,
  $t$Meeting sat, agreement drafted and sent, calls across four weeks. He decided to keep the property on a standard tenancy, and the modelling says he was right to.$t$,
  null, null, null, null, 1, false, false, 'partly_reconstructed', 60, false
),
(
  'case-07-ghosted-at-eleven-days', 'Case 07', 'lost', 'ghosted_pre_meeting', 'pre_meeting', 11,
  $t$The Cotswolds$t$,
  $t$Presentation opened, then silence, inside a fortnight.$t$,
  $t$An estimate delivered, a presentation opened, two follow-ups and a call attempt. No reply to any contact.$t$,
  null, null, null, null, 0, false, false, 'crm_verified', 70, false
),
(
  'case-08-engaged-then-gone', 'Case 08', 'lost', 'ghosted_pre_meeting', 'pre_meeting', 7,
  $t$East Midlands$t$,
  $t$Nearly three minutes on the income analyser, then nothing.$t$,
  $t$Close engagement with the estimate — almost three minutes on the analyser — followed by complete silence within the week.$t$,
  null, null, null, null, 0, false, false, 'crm_verified', 80, false
),
(
  'case-09-warm-and-still-gone', 'Case 09', 'lost', 'ghosted_pre_meeting', 'pre_meeting', 5,
  $t$Cumbria$t$,
  $t$He said he was more confident, happy to hand it all over, and sooner than expected. Then he vanished.$t$,
  $t$The warmest pre-meeting signal in the set — an explicit statement of readiness in the presentation questions — and gone three days later without a reply.$t$,
  null, null, null, null, 0, false, false, 'crm_verified', 90, false
)
on conflict (slug) do nothing;

-- Lessons, kept out of the VALUES list above so the prose stays readable.
update public.case_studies set lesson_markdown = $t$Two lessons, and the second is the one operators miss.

The no-show and the lapsed deadline were both recoverable, and recovering them is what won the deal. The move that worked was re-anchoring his own selling timeline and offering to reinstate the rate — not chasing harder on the same message.

The real gap is after the signature. He converted willingly and fast, then stalled completely on onboarding admin. Three chases and the property still wasn't live three weeks later. The close is the middle of the work, not the end of it.$t$
where slug = 'case-01-no-show-then-signed' and lesson_markdown is null;

update public.case_studies set lesson_markdown = $t$When a warm lead goes quiet after an offer, it is usually a specific unspoken objection rather than cold feet. Get them on the phone and ask directly what the blocker is.

Then write it down. The email summarising the agreed concessions is the hinge of this whole record — he signed a week later and said so explicitly. After any concession call, send the agreed changes in writing the same day. It turns a verbal maybe into a signable document.

Note the shape of the objection set. A landlord switching from a competitor already believes in short-term letting, so none of the education work applies — the friction is contractual, and it is a different conversation.$t$
where slug = 'case-02-contract-terms-in-writing' and lesson_markdown is null;

update public.case_studies set lesson_markdown = $t$Three things worth taking from this one.

Silence is not death. Six weeks passed with essentially no contact and the deal still closed. This sits at the far end of the four-to-twelve week range and it converted.

A deadline passing is not a loss. The expired-offer email is what prompted the reply that doubled the deal size. Reopening a lapsed offer is a legitimate conversation, not an embarrassment.

Watch who is actually replying. The person who enquired was not the person answering the technical questions. An operator who only ever spoke to the enquirer would have missed where the real engagement was. Keep both parties copied in — here they explicitly asked for it.

And it was untidy throughout: broken booking links, emails missed during annual leave, a colleague stepping in. That is what a real close looks like.$t$
where slug = 'case-03-two-decision-makers' and lesson_markdown is null;

update public.case_studies set lesson_markdown = $t$Nothing here was done wrong. That is the point of including it.

Expect to be in competitive processes and expect to lose a share of them. If you measure your own performance by whether well-worked leads convert, this record will read as failure. It isn't. The variable that decided it was not visible in the pipeline and was not within reach of more follow-up.

What you can do is find out earlier. Asking directly whether they are speaking to other operators — early, plainly, without defensiveness — turns an invisible competitor into a known one, and changes what you say for the remaining weeks.$t$
where slug = 'case-04-lost-to-competitor' and lesson_markdown is null;

update public.case_studies set lesson_markdown = $t$Two things collided here: a competitor, and a landlord whose own timeline did not match the offer window.

The lesson is not "chase harder". It is that a reduced-rate deadline only creates urgency in someone who is otherwise ready. Offered to a landlord who is four weeks from being able to start, it does the opposite — it forces a decision they can't make, and the expiry becomes a reason to disengage rather than a reason to move.

When someone tells you they need a month, believe them, and put the offer where the month ends.$t$
where slug = 'case-05-not-ready-when-the-window-was-open' and lesson_markdown is null;

update public.case_studies set lesson_markdown = $t$This is a qualification lesson, not a sales one.

The projected short-let income was below what he was already earning. No amount of selling should have converted that, and it would have been the wrong outcome if it had — a landlord who switches into a worse position leaves within a year and tells people why.

The skill is reading that signal in the first week rather than the fourth. When the estimate does not clear the landlord's current income by a margin that survives the extra work and variability, say so early and move on. Four weeks spent here is four weeks not spent on the other nineteen leads.$t$
where slug = 'case-06-numbers-didnt-beat-the-status-quo' and lesson_markdown is null;

-- One lesson, three cases. Written once because it is one lesson: the three
-- records differ only in how warm the lead looked before it went silent.
update public.case_studies set lesson_markdown = $t$This is the most common way a lead ends, and the least satisfying. A landlord asks for an estimate, engages with it — sometimes closely — and then simply stops responding. No objection to answer, no competitor to beat, nothing to fix.

The gap is specific and it is worth naming: it sits between the estimate landing and a meeting being booked. Everything before that point happened automatically. Everything after it depends on you getting a time in the diary. The leads that die here never had a conversation, so nothing you would call selling ever took place.

Two practical consequences. First, a warm signal is not a commitment — Case 09 gave every indication of being ready and was gone in three days. Do not reprioritise your week on the strength of enthusiasm in a form. Second, the single highest-value action on a new lead is booking the meeting, not perfecting the follow-up email. Get the time in the diary while they are still reading the estimate.$t$
where slug in (
  'case-07-ghosted-at-eleven-days',
  'case-08-engaged-then-gone',
  'case-09-warm-and-still-gone'
) and lesson_markdown is null;

-- ---------------------------------------------------------------------------
-- Events. Joined to their case study by slug, and skipped entirely for any
-- case that already has events, so a re-run cannot duplicate a timeline.
-- ---------------------------------------------------------------------------
insert into public.case_study_events
  (case_study_id, day_offset, channel, direction, description, is_setback, is_outcome, sort_order)
select c.id, e.day_offset, e.channel, e.direction, e.description, e.is_setback, e.is_outcome, e.sort_order
from public.case_studies c
join (values
  -- Case 01
  ('case-01-no-show-then-signed',  0, 'form',        'inbound',  $t$Enquiry submitted$t$, false, false,  10),
  ('case-01-no-show-then-signed',  2, 'email',       'outbound', $t$Income estimate and introduction$t$, false, false,  20),
  ('case-01-no-show-then-signed',  7, 'telemetry',   'none',     $t$Opened the income presentation a second time$t$, false, false,  30),
  ('case-01-no-show-then-signed', 11, 'web_meeting', 'none',     $t$First web meeting — attended$t$, false, false,  40),
  ('case-01-no-show-then-signed', 11, 'offer',       'none',     $t$Reduced management rate offered, expiring day 22$t$, false, false,  50),
  ('case-01-no-show-then-signed', 11, 'email',       'outbound', $t$Post-call income plan$t$, false, false,  60),
  ('case-01-no-show-then-signed', 13, 'web_meeting', 'none',     $t$Second web meeting — no show$t$, true,  false,  70),
  ('case-01-no-show-then-signed', 17, 'call',        'outbound', $t$Call answered$t$, false, false,  80),
  ('case-01-no-show-then-signed', 18, 'email',       'inbound',  $t$Asks for a slot later that week or the same afternoon$t$, false, false,  90),
  ('case-01-no-show-then-signed', 18, 'call',        'outbound', $t$Call answered$t$, false, false, 100),
  ('case-01-no-show-then-signed', 18, 'email',       'outbound', $t$Management agreement sent$t$, false, false, 110),
  ('case-01-no-show-then-signed', 18, 'email',       'inbound',  $t$Replies with property photos, partner copied in$t$, false, false, 120),
  ('case-01-no-show-then-signed', 20, 'call',        'outbound', $t$Call answered — he took it from a business trip abroad$t$, false, false, 130),
  ('case-01-no-show-then-signed', 20, 'email',       'inbound',  $t$Signed agreement returned$t$, false, true,  140),
  ('case-01-no-show-then-signed', 23, 'onboarding',  'outbound', $t$Welcome and onboarding steps$t$, false, false, 150),
  ('case-01-no-show-then-signed', 26, 'onboarding',  'outbound', $t$Onboarding form chase$t$, false, false, 160),
  ('case-01-no-show-then-signed', 30, 'onboarding',  'outbound', $t$Second onboarding form chase$t$, false, false, 170),
  ('case-01-no-show-then-signed', 30, 'email',       'inbound',  $t$Partner sends photos and video — but not the form$t$, true,  false, 180),
  ('case-01-no-show-then-signed', 30, 'onboarding',  'outbound', $t$"The form, not just the photos"$t$, false, false, 190),

  -- Case 02
  ('case-02-contract-terms-in-writing',  0, 'form',        'inbound',  $t$Enquiry — already letting short-term with another manager$t$, false, false,  10),
  ('case-02-contract-terms-in-writing',  1, 'email',       'outbound', $t$Income estimate and introduction$t$, false, false,  20),
  ('case-02-contract-terms-in-writing',  4, 'email',       'outbound', $t$Web meeting booked$t$, false, false,  30),
  ('case-02-contract-terms-in-writing',  6, 'web_meeting', 'none',     $t$Web meeting — no show$t$, true,  false,  40),
  ('case-02-contract-terms-in-writing',  8, 'call',        'outbound', $t$Call answered — two specific contract terms named as the blocker$t$, false, false,  50),
  ('case-02-contract-terms-in-writing',  8, 'email',       'outbound', $t$Written summary of the agreed changes, sent the same day$t$, false, false,  60),
  ('case-02-contract-terms-in-writing', 11, 'call',        'outbound', $t$Call answered$t$, false, false,  70),
  ('case-02-contract-terms-in-writing', 15, 'email',       'inbound',  $t$Signed agreement returned, thanking us for the written summary$t$, false, true,   80),
  ('case-02-contract-terms-in-writing', 20, 'onboarding',  'outbound', $t$Onboarding begins — wrong-address confusion$t$, false, false,  90),
  ('case-02-contract-terms-in-writing', 30, 'onboarding',  'outbound', $t$Onboarding form chase, no bookable kick-off slots$t$, false, false, 100),
  ('case-02-contract-terms-in-writing', 37, 'onboarding',  'none',     $t$Property live$t$, false, false, 110),

  -- Case 03
  ('case-03-two-decision-makers',  0, 'form',        'inbound',  $t$Enquiry — one-bed$t$, false, false,  10),
  ('case-03-two-decision-makers',  0, 'email',       'outbound', $t$Income estimate and introduction$t$, false, false,  20),
  ('case-03-two-decision-makers',  3, 'call',        'outbound', $t$Call attempted, no answer$t$, false, false,  30),
  ('case-03-two-decision-makers',  3, 'email',       'outbound', $t$Follow-up to book a meeting$t$, false, false,  40),
  ('case-03-two-decision-makers',  4, 'email',       'inbound',  $t$A second decision-maker accepts the meeting invitation$t$, false, false,  50),
  ('case-03-two-decision-makers',  5, 'web_meeting', 'none',     $t$First web meeting — attended$t$, false, false,  60),
  ('case-03-two-decision-makers',  5, 'email',       'outbound', $t$Agreement, onboarding pack and income estimate$t$, false, false,  70),
  ('case-03-two-decision-makers',  5, 'email',       'inbound',  $t$Floor plan and planning questions, from the second decision-maker$t$, false, false,  80),
  ('case-03-two-decision-makers',  7, 'email',       'inbound',  $t$Furnishing and VAT questions$t$, false, false,  90),
  ('case-03-two-decision-makers',  7, 'email',       'outbound', $t$Furnishing costs and revised estimate$t$, false, false, 100),
  ('case-03-two-decision-makers', 48, 'email',       'outbound', $t$Check-in after six weeks of silence$t$, true,  false, 110),
  ('case-03-two-decision-makers', 57, 'email',       'inbound',  $t$Second meeting booked$t$, false, false, 120),
  ('case-03-two-decision-makers', 60, 'web_meeting', 'none',     $t$Second web meeting — attended$t$, false, false, 130),
  ('case-03-two-decision-makers', 60, 'email',       'outbound', $t$Agreement, onboarding walkthrough and photography quote$t$, false, false, 140),
  ('case-03-two-decision-makers', 60, 'offer',       'none',     $t$Reduced management rate offered$t$, false, false, 150),
  ('case-03-two-decision-makers', 61, 'email',       'outbound', $t$Post-meeting follow-up$t$, false, false, 160),
  ('case-03-two-decision-makers', 69, 'email',       'outbound', $t$Offer has expired — extend by a day or two?$t$, true,  false, 170),
  ('case-03-two-decision-makers', 69, 'email',       'inbound',  $t$"We've bought another property"$t$, false, false, 180),
  ('case-03-two-decision-makers', 69, 'email',       'outbound', $t$Renegotiated: lower rate across two properties, fixed six-month term$t$, false, false, 190),
  ('case-03-two-decision-makers', 74, 'email',       'inbound',  $t$"Signing and sending the documents tonight"$t$, false, false, 200),
  ('case-03-two-decision-makers', 77, 'email',       'inbound',  $t$Signed — two properties$t$, false, true,  210),
  ('case-03-two-decision-makers', 90, 'onboarding',  'outbound', $t$Onboarding, kick-off call booking problems$t$, false, false, 220),
  ('case-03-two-decision-makers',126, 'onboarding',  'none',     $t$Listings live$t$, false, false, 230),

  -- Case 04
  ('case-04-lost-to-competitor',  0, 'form',        'inbound',  $t$Enquiry$t$, false, false, 10),
  ('case-04-lost-to-competitor',  1, 'email',       'outbound', $t$Income estimate and introduction$t$, false, false, 20),
  ('case-04-lost-to-competitor', 10, 'web_meeting', 'none',     $t$Web meeting — attended$t$, false, false, 30),
  ('case-04-lost-to-competitor', 10, 'email',       'outbound', $t$Profitability action plan sent$t$, false, false, 40),
  ('case-04-lost-to-competitor', 14, 'offer',       'none',     $t$Reduced management rate offered$t$, false, false, 50),
  ('case-04-lost-to-competitor', 21, 'email',       'outbound', $t$Follow-up$t$, false, false, 60),
  ('case-04-lost-to-competitor', 35, 'email',       'outbound', $t$Follow-up$t$, false, false, 70),
  ('case-04-lost-to-competitor', 49, 'email',       'outbound', $t$Follow-up$t$, false, false, 80),
  ('case-04-lost-to-competitor', 56, 'email',       'inbound',  $t$Going with another company$t$, false, true,  90),

  -- Case 05
  ('case-05-not-ready-when-the-window-was-open',  0, 'form',        'inbound',  $t$Enquiry$t$, false, false, 10),
  ('case-05-not-ready-when-the-window-was-open',  1, 'email',       'outbound', $t$Income estimate — c. £20,500 net short-let vs c. £17,800 as a standard tenancy$t$, false, false, 20),
  ('case-05-not-ready-when-the-window-was-open',  9, 'web_meeting', 'none',     $t$Web meeting — attended$t$, false, false, 30),
  ('case-05-not-ready-when-the-window-was-open', 12, 'call',        'outbound', $t$Call answered$t$, false, false, 40),
  ('case-05-not-ready-when-the-window-was-open', 14, 'offer',       'none',     $t$Reduced management rate offered$t$, false, false, 50),
  ('case-05-not-ready-when-the-window-was-open', 21, 'web_meeting', 'none',     $t$Second web meeting — no show$t$, true,  false, 60),
  ('case-05-not-ready-when-the-window-was-open', 23, 'call',        'outbound', $t$Call answered — still furnishing, needs a month$t$, true,  false, 70),
  ('case-05-not-ready-when-the-window-was-open', 30, 'offer',       'none',     $t$Offer expires$t$, true,  false, 80),
  ('case-05-not-ready-when-the-window-was-open', 40, 'email',       'inbound',  $t$Went with another company$t$, false, true,  90),

  -- Case 06
  ('case-06-numbers-didnt-beat-the-status-quo',  0, 'form',        'inbound',  $t$Enquiry — seven-bed$t$, false, false, 10),
  ('case-06-numbers-didnt-beat-the-status-quo',  1, 'email',       'outbound', $t$Income estimate — c. £25,000 net short-let vs c. £27,000 current long let$t$, false, false, 20),
  ('case-06-numbers-didnt-beat-the-status-quo',  8, 'web_meeting', 'none',     $t$Web meeting — attended$t$, false, false, 30),
  ('case-06-numbers-didnt-beat-the-status-quo', 10, 'email',       'outbound', $t$Management agreement drafted and sent$t$, false, false, 40),
  ('case-06-numbers-didnt-beat-the-status-quo', 17, 'call',        'outbound', $t$Call answered$t$, false, false, 50),
  ('case-06-numbers-didnt-beat-the-status-quo', 24, 'call',        'outbound', $t$Call answered$t$, false, false, 60),
  ('case-06-numbers-didnt-beat-the-status-quo', 28, 'email',       'inbound',  $t$Keeping it as a long let$t$, false, true,  70),

  -- Case 07
  ('case-07-ghosted-at-eleven-days',  0, 'form',  'inbound',  $t$Enquiry$t$, false, false, 10),
  ('case-07-ghosted-at-eleven-days',  1, 'email', 'outbound', $t$Income estimate and presentation$t$, false, false, 20),
  ('case-07-ghosted-at-eleven-days',  4, 'email', 'outbound', $t$Follow-up to book a meeting$t$, false, false, 30),
  ('case-07-ghosted-at-eleven-days',  8, 'call',  'outbound', $t$Call attempted, no answer$t$, false, false, 40),
  ('case-07-ghosted-at-eleven-days', 11, 'email', 'outbound', $t$Final follow-up — no reply to any contact$t$, false, true,  50),

  -- Case 08
  ('case-08-engaged-then-gone', 0, 'form',      'inbound',  $t$Enquiry$t$, false, false, 10),
  ('case-08-engaged-then-gone', 1, 'email',     'outbound', $t$Income estimate and presentation$t$, false, false, 20),
  ('case-08-engaged-then-gone', 1, 'telemetry', 'none',     $t$Two minutes forty-nine seconds on the income analyser$t$, false, false, 30),
  ('case-08-engaged-then-gone', 3, 'email',     'outbound', $t$Follow-up to book a meeting$t$, false, false, 40),
  ('case-08-engaged-then-gone', 7, 'call',      'outbound', $t$Call attempted, no answer — no reply to any contact$t$, false, true,  50),

  -- Case 09
  ('case-09-warm-and-still-gone', 0, 'form',      'inbound',  $t$Enquiry$t$, false, false, 10),
  ('case-09-warm-and-still-gone', 1, 'email',     'outbound', $t$Income estimate and presentation$t$, false, false, 20),
  ('case-09-warm-and-still-gone', 2, 'telemetry', 'none',     $t$Read to slide seven of the presentation$t$, false, false, 30),
  ('case-09-warm-and-still-gone', 2, 'form',      'inbound',  $t$Answered the presentation questions warmly — more confident now, happy to hand it all over, sooner than expected$t$, false, false, 40),
  ('case-09-warm-and-still-gone', 3, 'email',     'outbound', $t$Follow-up to book a meeting$t$, false, false, 50),
  ('case-09-warm-and-still-gone', 5, 'call',      'outbound', $t$Call attempted, no answer — no reply to any contact$t$, false, true,  60)
) as e(slug, day_offset, channel, direction, description, is_setback, is_outcome, sort_order)
  on e.slug = c.slug
where not exists (
  select 1 from public.case_study_events x where x.case_study_id = c.id
);

-- ---------------------------------------------------------------------------
-- Point the "Why leads don't sign" module at the comparison view. Stays
-- unpublished; the rest of that article body is being drafted separately.
-- ---------------------------------------------------------------------------
update public.training_modules
set body_markdown = $t$The nine case studies behind this article are at /dashboard/training/case-studies, where all nine journeys can be compared side by side.

[Article body to follow.]$t$,
    updated_at = now()
where slug = 'why-leads-dont-sign'
  and body_markdown is null;
