-- supabase/seed/case_studies_seed.sql
--
-- Nine anonymised lead journeys for the Training tab case studies layer.
-- Three signed, six lost. All seeded unpublished — review in /admin/training/
-- case-studies and publish individually.
--
-- ANONYMISATION: no names, no real dates, no towns, no postcodes. Event timing
-- is a day offset from enquiry. Income figures rounded to the nearest £500.
-- Do not add any of the above to this file.
--
-- Run AFTER the case_studies / case_study_events migration has applied.
-- Safe to re-run: parent inserts are ON CONFLICT (slug) DO NOTHING, and events
-- are deleted for the nine seeded slugs before reinsert.

begin;

-- ---------------------------------------------------------------------------
-- Parents
-- ---------------------------------------------------------------------------

insert into case_studies (
  slug, reference, outcome, loss_reason, gate_reached, days_to_outcome,
  property_summary, headline, summary, lesson_markdown,
  emails_out, calls_made, calls_answered, inbound_replies, meetings_sat,
  had_no_show, offer_applied, data_confidence, sort_order, is_published
) values

-- Case 01 -------------------------------------------------------------------
(
  'case-01-no-show-then-signed', 'Case 01', 'signed', null,
  'meeting_or_after', 20, 'Two-bed, South East',
  'A no-show and an expired deadline, then signed on the fifth answered call.',
  'Nineteen touchpoints over twenty days. He engaged quickly, then went quiet, no-showed the second meeting and let the reduced-rate deadline lapse. A weaker operator writes him off at the no-show. He signed nine days after it.',
  $md$Two lessons, and the second is the one operators miss.

The no-show and the lapsed deadline were both recoverable, and recovering them is what won the deal. The move that worked was re-anchoring his own selling timeline and offering to reinstate the rate — not chasing harder on the same message.

The real gap is after the signature. He converted willingly and fast, then stalled completely on onboarding admin. Three chases and the property still was not live three weeks later. The close is the middle of the work, not the end of it.$md$,
  12, 6, 5, 6, 1, true, true, 'crm_verified', 10, false
),

-- Case 02 -------------------------------------------------------------------
(
  'case-02-contract-terms-in-writing', 'Case 02', 'signed', null,
  'meeting_or_after', 15, 'Three-bed apartment, East Midlands',
  'The fastest of the three, and only because the block was two contract terms rather than doubt.',
  'An existing short-let owner unhappy with his current manager. He already believed in the model, so the sell was "why us" rather than "why this". The block was contractual switching cost, and it closed the day it was put in writing.',
  $md$When a warm lead goes quiet after an offer, it is usually a specific unspoken objection rather than cold feet. Get them on the phone and ask directly what the blocker is.

Then write it down. The email summarising the agreed concessions is the hinge of this whole record — he signed a week later and said so explicitly. After any concession call, send the agreed changes in writing the same day. It turns a verbal maybe into a signable document.

Note the shape of the objection set. A landlord switching from a competitor already believes in short-term letting, so none of the education work applies — the friction is contractual, and it is a different conversation.$md$,
  null, 6, 3, 2, null, true, false, 'partly_reconstructed', 20, false
),
-- NOTE: meetings_sat left NULL deliberately. The record says one meeting was
-- attended, but the only meeting in the event trail below is the day-6 no-show.
-- Resolve which is right before publishing this case.

-- Case 03 -------------------------------------------------------------------
(
  'case-03-two-decision-makers', 'Case 03', 'signed', null,
  'meeting_or_after', 78, 'One-bed initially, became two properties, Yorkshire',
  'A dead six-week gap, an expired offer — and the offer expiring is what grew the deal.',
  'Eleven weeks from enquiry to signature, with almost nothing happening in the middle. Two decision-makers, only one of whom enquired. The reduced rate lapsed, and the conversation reopening it turned a one-property deal into two.',
  $md$Three things worth taking from this one.

Silence is not death. Six weeks passed with essentially no contact and the deal still closed. This sits at the far end of the four-to-twelve week range and it converted.

A deadline passing is not a loss. The expired-offer email is what prompted the reply that doubled the deal size. Reopening a lapsed offer is a legitimate conversation, not an embarrassment.

Watch who is actually replying. The person who enquired was not the person answering the technical questions. An operator who only ever spoke to the enquirer would have missed where the real engagement was. Keep both parties copied in — here they explicitly asked for it.

And it was untidy throughout: broken booking links, emails missed during annual leave, a colleague stepping in. That is what a real close looks like.$md$,
  19, 1, 0, 11, 2, false, true, 'crm_verified', 30, false
),

-- Case 04 -------------------------------------------------------------------
(
  'case-04-lost-to-competitor', 'Case 04', 'lost', 'competitor',
  'meeting_or_after', 56, 'North West',
  'The full process, run properly, over eight weeks — and she chose someone else.',
  'Meeting sat, action plan delivered, reduced rate applied, follow-ups across two months. The same effort profile as all three of the signed cases. She went with another company. This is the single most instructive record in the set.',
  $md$Nothing here was done wrong. That is the point of including it.

Expect to be in competitive processes and expect to lose a share of them. If you measure your own performance by whether well-worked leads convert, this record will read as failure. It is not. The variable that decided it was not visible in the pipeline and was not within reach of more follow-up.

What you can do is find out earlier. Asking directly whether they are speaking to other operators — early, plainly, without defensiveness — turns an invisible competitor into a known one, and changes what you say for the remaining weeks.$md$,
  null, null, null, 1, 1, false, true, 'partly_reconstructed', 40, false
),

-- Case 05 -------------------------------------------------------------------
(
  'case-05-not-ready-when-the-window-was-open', 'Case 05', 'lost', 'timing',
  'meeting_or_after', 40, 'West Yorkshire',
  'Her numbers stacked up. She was not ready when the offer window was open.',
  'Around £20,500 projected net from short-term letting against roughly £17,800 as a standard tenancy — a genuinely positive case. She sat a meeting, took two calls, received a reduced rate, then no-showed the second meeting, said she was still furnishing the property and needed a month, let the offer expire, and went elsewhere.',
  $md$Two things collided here: a competitor, and a landlord whose own timeline did not match the offer window.

The lesson is not "chase harder". It is that a reduced-rate deadline only creates urgency in someone who is otherwise ready. Offered to a landlord who is four weeks from being able to start, it does the opposite — it forces a decision they cannot make, and the expiry becomes a reason to disengage rather than a reason to move.

When someone tells you they need a month, believe them, and put the offer where the month ends.$md$,
  null, null, 2, 1, 1, true, true, 'partly_reconstructed', 50, false
),

-- Case 06 -------------------------------------------------------------------
(
  'case-06-numbers-didnt-beat-the-status-quo', 'Case 06', 'lost',
  'numbers_did_not_stack', 'meeting_or_after', 28, 'Seven-bed, East of England',
  'Around £27,000 as a long let against roughly £25,000 net short-letting. This lead should not have converted.',
  'Meeting sat, agreement drafted and sent, calls across four weeks. He decided to keep the property on a standard tenancy, and the modelling says he was right to.',
  $md$This is a qualification lesson, not a sales one.

The projected short-let income was below what he was already earning. No amount of selling should have converted that, and it would have been the wrong outcome if it had — a landlord who switches into a worse position leaves within a year and tells people why.

The skill is reading that signal in the first week rather than the fourth. When the estimate does not clear the landlord's current income by a margin that survives the extra work and variability, say so early and move on. Four weeks spent here is four weeks not spent on the other nineteen leads.$md$,
  null, null, 2, 1, 1, false, false, 'partly_reconstructed', 60, false
),

-- Cases 07-09 ---------------------------------------------------------------
(
  'case-07-ghosted-at-eleven-days', 'Case 07', 'lost', 'ghosted_pre_meeting',
  'pre_meeting', 11, 'The Cotswolds',
  'Presentation opened, then silence, inside a fortnight.',
  'Enquiry, estimate, two follow-ups and a call attempt over eleven days. No reply to any contact after the estimate landed.',
  $md$This is the most common way a lead ends, and the least satisfying. A landlord asks for an estimate, engages with it — sometimes closely — and then simply stops responding. No objection to answer, no competitor to beat, nothing to fix.

The gap is specific and it is worth naming: it sits between the estimate landing and a meeting being booked. Everything before that point happened automatically. Everything after it depends on you getting a time in the diary. The leads that die here never had a conversation, so nothing you would call selling ever took place.

Two practical consequences. First, a warm signal is not a commitment — one of these three gave every indication of being ready and was gone in three days. Do not reprioritise your week on the strength of enthusiasm in a form. Second, the single highest-value action on a new lead is booking the meeting, not perfecting the follow-up email. Get the time in the diary while they are still reading the estimate.$md$,
  3, 1, 0, 0, 0, false, false, 'crm_verified', 70, false
),
(
  'case-08-engaged-then-gone', 'Case 08', 'lost', 'ghosted_pre_meeting',
  'pre_meeting', 7, 'East Midlands',
  'Nearly three minutes on the income analyser, then nothing.',
  'Measurable engagement with the estimate — close to three minutes on the analyser — followed by no response to a follow-up or a call attempt. Gone within a week.',
  $md$This is the most common way a lead ends, and the least satisfying. A landlord asks for an estimate, engages with it — sometimes closely — and then simply stops responding. No objection to answer, no competitor to beat, nothing to fix.

The gap is specific and it is worth naming: it sits between the estimate landing and a meeting being booked. Everything before that point happened automatically. Everything after it depends on you getting a time in the diary. The leads that die here never had a conversation, so nothing you would call selling ever took place.

Two practical consequences. First, a warm signal is not a commitment — one of these three gave every indication of being ready and was gone in three days. Do not reprioritise your week on the strength of enthusiasm in a form. Second, the single highest-value action on a new lead is booking the meeting, not perfecting the follow-up email. Get the time in the diary while they are still reading the estimate.$md$,
  2, 1, 0, 0, 0, false, false, 'crm_verified', 80, false
),
(
  'case-09-warm-and-still-gone', 'Case 09', 'lost', 'ghosted_pre_meeting',
  'pre_meeting', 5, 'Cumbria',
  'He said he was more confident, happy to hand it all over, and sooner than expected. Then he vanished.',
  'Read to slide seven of the presentation and answered the follow-up questions warmly. Five days later, no reply to a follow-up or a call attempt. The most positive signal in the set and the shortest record.',
  $md$This is the most common way a lead ends, and the least satisfying. A landlord asks for an estimate, engages with it — sometimes closely — and then simply stops responding. No objection to answer, no competitor to beat, nothing to fix.

The gap is specific and it is worth naming: it sits between the estimate landing and a meeting being booked. Everything before that point happened automatically. Everything after it depends on you getting a time in the diary. The leads that die here never had a conversation, so nothing you would call selling ever took place.

Two practical consequences. First, a warm signal is not a commitment — this lead gave every indication of being ready and was gone in three days. Do not reprioritise your week on the strength of enthusiasm in a form. Second, the single highest-value action on a new lead is booking the meeting, not perfecting the follow-up email. Get the time in the diary while they are still reading the estimate.$md$,
  2, 1, 0, 0, 0, false, false, 'crm_verified', 90, false
)

on conflict (slug) do nothing;

-- ---------------------------------------------------------------------------
-- Events
-- ---------------------------------------------------------------------------

delete from case_study_events
where case_study_id in (
  select id from case_studies where slug in (
    'case-01-no-show-then-signed',
    'case-02-contract-terms-in-writing',
    'case-03-two-decision-makers',
    'case-04-lost-to-competitor',
    'case-05-not-ready-when-the-window-was-open',
    'case-06-numbers-didnt-beat-the-status-quo',
    'case-07-ghosted-at-eleven-days',
    'case-08-engaged-then-gone',
    'case-09-warm-and-still-gone'
  )
);

insert into case_study_events (
  case_study_id, day_offset, channel, direction, description,
  is_setback, is_outcome, sort_order
)
select cs.id, v.day_offset, v.channel, v.direction, v.description,
       v.is_setback, v.is_outcome, v.sort_order
from (values

-- Case 01 -------------------------------------------------------------------
('case-01-no-show-then-signed',  0, 'form',      'inbound',  'Enquiry submitted', false, false, 10),
('case-01-no-show-then-signed',  2, 'email',     'outbound', 'Income estimate and introduction', false, false, 20),
('case-01-no-show-then-signed',  7, 'telemetry', 'none',     'Opened the income presentation a second time', false, false, 30),
('case-01-no-show-then-signed', 11, 'web_meeting','none',    'First web meeting — attended', false, false, 40),
('case-01-no-show-then-signed', 11, 'offer',     'none',     'Reduced management rate offered, expiring day 22', false, false, 50),
('case-01-no-show-then-signed', 11, 'email',     'outbound', 'Post-call income plan', false, false, 60),
('case-01-no-show-then-signed', 13, 'web_meeting','none',    'Second web meeting — no show', true,  false, 70),
('case-01-no-show-then-signed', 17, 'call',      'outbound', 'Call answered', false, false, 80),
('case-01-no-show-then-signed', 18, 'email',     'inbound',  'Asks for a slot later that week or the same afternoon', false, false, 90),
('case-01-no-show-then-signed', 18, 'call',      'outbound', 'Call answered', false, false, 100),
('case-01-no-show-then-signed', 18, 'email',     'outbound', 'Management agreement sent', false, false, 110),
('case-01-no-show-then-signed', 18, 'email',     'inbound',  'Replies with property photos, partner copied in', false, false, 120),
('case-01-no-show-then-signed', 20, 'call',      'outbound', 'Call answered — he took it from a business trip abroad', false, false, 130),
('case-01-no-show-then-signed', 20, 'email',     'inbound',  'Signed agreement returned', false, true,  140),
('case-01-no-show-then-signed', 23, 'onboarding','outbound', 'Welcome and onboarding steps', false, false, 150),
('case-01-no-show-then-signed', 26, 'onboarding','outbound', 'Onboarding form chase', false, false, 160),
('case-01-no-show-then-signed', 30, 'onboarding','outbound', 'Second onboarding form chase', false, false, 170),
('case-01-no-show-then-signed', 30, 'email',     'inbound',  'Partner sends photos and video — but not the form', true,  false, 180),
('case-01-no-show-then-signed', 30, 'onboarding','outbound', 'The form, not just the photos', false, false, 190),

-- Case 02 -------------------------------------------------------------------
('case-02-contract-terms-in-writing',  0, 'form',      'inbound',  'Enquiry — already letting short-term with another manager', false, false, 10),
('case-02-contract-terms-in-writing',  1, 'email',     'outbound', 'Income estimate and introduction', false, false, 20),
('case-02-contract-terms-in-writing',  4, 'email',     'outbound', 'Web meeting booked', false, false, 30),
('case-02-contract-terms-in-writing',  6, 'web_meeting','none',    'Web meeting — no show', true,  false, 40),
('case-02-contract-terms-in-writing',  8, 'call',      'outbound', 'Call answered — two specific contract terms named as the blocker', false, false, 50),
('case-02-contract-terms-in-writing',  8, 'email',     'outbound', 'Written summary of the agreed changes, sent the same day', false, false, 60),
('case-02-contract-terms-in-writing', 11, 'call',      'outbound', 'Call answered', false, false, 70),
('case-02-contract-terms-in-writing', 15, 'email',     'inbound',  'Signed agreement returned, thanking us for the written summary', false, true, 80),
('case-02-contract-terms-in-writing', 20, 'onboarding','outbound', 'Onboarding begins — wrong-address confusion', false, false, 90),
('case-02-contract-terms-in-writing', 30, 'onboarding','outbound', 'Onboarding form chase, no bookable kick-off slots', false, false, 100),
('case-02-contract-terms-in-writing', 37, 'onboarding','none',     'Property live', false, false, 110),

-- Case 03 -------------------------------------------------------------------
('case-03-two-decision-makers',  0, 'form',      'inbound',  'Enquiry — one-bed', false, false, 10),
('case-03-two-decision-makers',  0, 'email',     'outbound', 'Income estimate and introduction', false, false, 20),
('case-03-two-decision-makers',  3, 'call',      'outbound', 'Call attempted, no answer', false, false, 30),
('case-03-two-decision-makers',  3, 'email',     'outbound', 'Follow-up to book a meeting', false, false, 40),
('case-03-two-decision-makers',  4, 'email',     'inbound',  'A second decision-maker accepts the meeting invitation', false, false, 50),
('case-03-two-decision-makers',  5, 'web_meeting','none',    'First web meeting — attended', false, false, 60),
('case-03-two-decision-makers',  5, 'email',     'outbound', 'Agreement, onboarding pack and income estimate', false, false, 70),
('case-03-two-decision-makers',  5, 'email',     'inbound',  'Floor plan and planning questions, from the second decision-maker', false, false, 80),
('case-03-two-decision-makers',  7, 'email',     'inbound',  'Furnishing and VAT questions', false, false, 90),
('case-03-two-decision-makers',  7, 'email',     'outbound', 'Furnishing costs and revised estimate', false, false, 100),
('case-03-two-decision-makers', 48, 'email',     'outbound', 'Check-in after six weeks of silence', true,  false, 110),
('case-03-two-decision-makers', 57, 'email',     'inbound',  'Second meeting booked', false, false, 120),
('case-03-two-decision-makers', 60, 'web_meeting','none',    'Second web meeting — attended', false, false, 130),
('case-03-two-decision-makers', 60, 'email',     'outbound', 'Agreement, onboarding walkthrough and photography quote', false, false, 140),
('case-03-two-decision-makers', 60, 'offer',     'none',     'Reduced management rate offered', false, false, 150),
('case-03-two-decision-makers', 61, 'email',     'outbound', 'Post-meeting follow-up', false, false, 160),
('case-03-two-decision-makers', 69, 'email',     'outbound', 'Offer has expired — extend by a day or two?', true,  false, 170),
('case-03-two-decision-makers', 69, 'email',     'inbound',  'We have bought another property', false, false, 180),
('case-03-two-decision-makers', 69, 'email',     'outbound', 'Renegotiated: lower rate across two properties, fixed six-month term', false, false, 190),
('case-03-two-decision-makers', 74, 'email',     'inbound',  'Signing and sending the documents tonight', false, false, 200),
('case-03-two-decision-makers', 77, 'email',     'inbound',  'Signed — two properties', false, true,  210),
('case-03-two-decision-makers', 90, 'onboarding','outbound', 'Onboarding, kick-off call booking problems', false, false, 220),
('case-03-two-decision-makers',126, 'onboarding','outbound', 'Listings live', false, false, 230),

-- Case 04 -------------------------------------------------------------------
('case-04-lost-to-competitor',  0, 'form',      'inbound',  'Enquiry', false, false, 10),
('case-04-lost-to-competitor',  1, 'email',     'outbound', 'Income estimate and introduction', false, false, 20),
('case-04-lost-to-competitor', 10, 'web_meeting','none',    'Web meeting — attended', false, false, 30),
('case-04-lost-to-competitor', 10, 'email',     'outbound', 'Profitability action plan sent', false, false, 40),
('case-04-lost-to-competitor', 14, 'offer',     'none',     'Reduced management rate offered', false, false, 50),
('case-04-lost-to-competitor', 21, 'email',     'outbound', 'Follow-up', false, false, 60),
('case-04-lost-to-competitor', 35, 'email',     'outbound', 'Follow-up', false, false, 70),
('case-04-lost-to-competitor', 49, 'email',     'outbound', 'Follow-up', false, false, 80),
('case-04-lost-to-competitor', 56, 'email',     'inbound',  'Going with another company', false, true,  90),

-- Case 05 -------------------------------------------------------------------
('case-05-not-ready-when-the-window-was-open',  0, 'form',      'inbound',  'Enquiry', false, false, 10),
('case-05-not-ready-when-the-window-was-open',  1, 'email',     'outbound', 'Income estimate — c. £20,500 net short-let vs c. £17,800 as a standard tenancy', false, false, 20),
('case-05-not-ready-when-the-window-was-open',  9, 'web_meeting','none',    'Web meeting — attended', false, false, 30),
('case-05-not-ready-when-the-window-was-open', 12, 'call',      'outbound', 'Call answered', false, false, 40),
('case-05-not-ready-when-the-window-was-open', 14, 'offer',     'none',     'Reduced management rate offered', false, false, 50),
('case-05-not-ready-when-the-window-was-open', 21, 'web_meeting','none',    'Second web meeting — no show', true,  false, 60),
('case-05-not-ready-when-the-window-was-open', 23, 'call',      'outbound', 'Call answered — still furnishing, needs a month', true,  false, 70),
('case-05-not-ready-when-the-window-was-open', 30, 'offer',     'none',     'Offer expires', true,  false, 80),
('case-05-not-ready-when-the-window-was-open', 40, 'email',     'inbound',  'Went with another company', false, true,  90),

-- Case 06 -------------------------------------------------------------------
('case-06-numbers-didnt-beat-the-status-quo',  0, 'form',      'inbound',  'Enquiry — seven-bed', false, false, 10),
('case-06-numbers-didnt-beat-the-status-quo',  1, 'email',     'outbound', 'Income estimate — c. £25,000 net short-let vs c. £27,000 current long let', false, false, 20),
('case-06-numbers-didnt-beat-the-status-quo',  8, 'web_meeting','none',    'Web meeting — attended', false, false, 30),
('case-06-numbers-didnt-beat-the-status-quo', 10, 'email',     'outbound', 'Management agreement drafted and sent', false, false, 40),
('case-06-numbers-didnt-beat-the-status-quo', 17, 'call',      'outbound', 'Call answered', false, false, 50),
('case-06-numbers-didnt-beat-the-status-quo', 24, 'call',      'outbound', 'Call answered', false, false, 60),
('case-06-numbers-didnt-beat-the-status-quo', 28, 'email',     'inbound',  'Keeping it as a long let', false, true,  70),

-- Case 07 -------------------------------------------------------------------
('case-07-ghosted-at-eleven-days',  0, 'form',  'inbound',  'Enquiry', false, false, 10),
('case-07-ghosted-at-eleven-days',  1, 'email', 'outbound', 'Income estimate and presentation', false, false, 20),
('case-07-ghosted-at-eleven-days',  4, 'email', 'outbound', 'Follow-up to book a meeting', false, false, 30),
('case-07-ghosted-at-eleven-days',  8, 'call',  'outbound', 'Call attempted, no answer', false, false, 40),
('case-07-ghosted-at-eleven-days', 11, 'email', 'outbound', 'Final follow-up — no reply to any contact', false, true, 50),

-- Case 08 -------------------------------------------------------------------
('case-08-engaged-then-gone', 0, 'form',      'inbound',  'Enquiry', false, false, 10),
('case-08-engaged-then-gone', 1, 'email',     'outbound', 'Income estimate and presentation', false, false, 20),
('case-08-engaged-then-gone', 1, 'telemetry', 'none',     'Two minutes forty-nine seconds on the income analyser', false, false, 30),
('case-08-engaged-then-gone', 3, 'email',     'outbound', 'Follow-up to book a meeting', false, false, 40),
('case-08-engaged-then-gone', 7, 'call',      'outbound', 'Call attempted, no answer — no reply to any contact', false, true, 50),

-- Case 09 -------------------------------------------------------------------
('case-09-warm-and-still-gone', 0, 'form',      'inbound',  'Enquiry', false, false, 10),
('case-09-warm-and-still-gone', 1, 'email',     'outbound', 'Income estimate and presentation', false, false, 20),
('case-09-warm-and-still-gone', 2, 'telemetry', 'none',     'Read to slide seven of the presentation', false, false, 30),
('case-09-warm-and-still-gone', 2, 'form',      'inbound',  'Answered the presentation questions warmly — more confident now, happy to hand it all over, sooner than expected', false, false, 40),
('case-09-warm-and-still-gone', 3, 'email',     'outbound', 'Follow-up to book a meeting', false, false, 50),
('case-09-warm-and-still-gone', 5, 'call',      'outbound', 'Call attempted, no answer — no reply to any contact', false, true, 60)

) as v(slug, day_offset, channel, direction, description, is_setback, is_outcome, sort_order)
join case_studies cs on cs.slug = v.slug;

commit;

-- ---------------------------------------------------------------------------
-- Expected counts after seeding — check these before assuming success
-- ---------------------------------------------------------------------------
-- case_studies: 9 rows, all is_published = false
-- case_study_events per case:
--   case-01  19    case-02  11    case-03  23
--   case-04   9    case-05   9    case-06   7
--   case-07   5    case-08   5    case-09   6
--   total   94
-- Exactly one is_outcome = true per case (9 total).
--
-- APPLIED TO PRODUCTION 4 Aug 2026. Verified: 9 cases, 94 events, 0 published,
-- every per-case count matching the table above and exactly one outcome event
-- each.
