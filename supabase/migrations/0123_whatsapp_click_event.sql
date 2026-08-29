-- ---------------------------------------------------------------------------
-- 0123 — whatsapp_click: the free WhatsApp hand-off signal (§40.15)
--
-- A customer with no TimelinesAI workspace can now compose a message here and
-- hand it to their OWN WhatsApp through a wa.me deep link. Production says why
-- that matters: 1 of 21 active customers has a connected workspace, so the
-- other 20 have been looking at a Send button that cannot send.
--
-- ⚠️ A TAP IS A CLICK, NOT A SEND, AND THE MODEL SAYS SO.
--
-- The hand-off leaves the browser. Nothing comes back — no provider id, no
-- delivery receipt, no reply. So this is NOT message_sent, and no lead_messages
-- row is written: every status in that table is a delivery claim we cannot
-- make. 0117 already fixed the shape of this argument for message_sent —
-- "a customer able to POST it could shield every lead they hold" — and the
-- honest precedent already in CLIENT_LEAD_EVENT_TYPES is tel_click, which is an
-- attempt to ring rather than proof of a call.
--
-- ⚠️ AND IT IS DELIBERATELY CLIENT-REPORTABLE, unlike message_sent. That is the
-- whole point: the browser is the only witness. It goes through
-- POST /api/customer/events, which is already the only way to write this table
-- and already carries the ownership check, the 60-second dedupe and the
-- 600/hour cap. No new route exists for it.
--
-- This migration is inert on its own — nothing emits the event until the UI
-- ships — which is why it is split from 0124's engagement-function edits.
--
-- Deployment order: migrations before code.
-- ---------------------------------------------------------------------------

-- 1 — The event type.
alter table public.lead_events drop constraint if exists lead_events_event_type_check;
alter table public.lead_events add constraint lead_events_event_type_check
  check (event_type in (
    'detail_opened',
    'tel_click',
    'mailto_click',
    'whatsapp_click',
    'note_added',
    'file_added',
    'stage_changed',
    'message_sent',
    'message_received',
    'nudge_sent'
  ));

-- ---------------------------------------------------------------------------
-- 2 — The weight.
--
-- 0.50, level with tel_click and below message_sent's 0.60.
--
-- ⚠️ THE OBVIOUS READING WOULD BE 0.30. mailto_click sits there precisely
-- because it "opens a mail client with no guarantee anything was sent", and on
-- that test a wa.me hand-off is the same act.
--
-- It is 0.50 because of what it now DOES rather than what it proves: this
-- signal flips the assignment to contacted (part 3), and both signals already
-- trusted to do that are >= 0.50. A signal that marks a lead contacted while
-- scoring below the one that does not (mailto_click) would make this table
-- disagree with itself. The gap to message_sent is what still separates a tap
-- from a message with a provider id behind it.
-- ---------------------------------------------------------------------------
insert into public.engagement_weights (signal, weight, description)
values (
  'whatsapp_click',
  0.50,
  'Opened a pre-written WhatsApp to the landlord from their own phone (§40.15). '
  || 'No delivery receipt exists for it — the message leaves the browser and never '
  || 'comes back — so it is weighted below message_sent (0.60), which carries a '
  || 'provider message id. Level with tel_click, and like tel_click it flips the '
  || 'assignment to contacted.'
)
on conflict (signal) do update
  set weight      = excluded.weight,
      description = excluded.description,
      updated_at  = now();

-- ---------------------------------------------------------------------------
-- 3 — Contact.
--
-- ⚠️ CONSEQUENCE, STATED RATHER THAN DISCOVERED — the same one 0118 recorded
-- for message_sent. Flipping to contacted makes the lead UNDISCARDABLE, because
-- discard requires status = 'new'. 0124 additionally takes it out of
-- get_reclaim_candidates. So one tap per lead is enough to make a whole book
-- look worked, and that is accepted: the alternative is a customer who did
-- message the landlord being chased for inactivity and having the lead taken
-- off them.
-- ---------------------------------------------------------------------------
drop trigger if exists lead_events_mark_contacted on public.lead_events;
create trigger lead_events_mark_contacted
  after insert on public.lead_events
  for each row
  when (new.event_type in ('tel_click', 'whatsapp_click', 'message_sent'))
  execute function public.trg_event_marks_contacted();
