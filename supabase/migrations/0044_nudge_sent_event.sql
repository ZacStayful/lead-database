-- ============================================================================
-- Add 'nudge_sent' to the lead_events vocabulary.
--
-- Every other event type in lead_events records something the OPERATOR did.
-- This one records something WE did to them, and it is stored here anyway for
-- one reason: it is the only per-assignment record of a nudge we have.
--
-- The existing dedup lives on customers.last_nudge_sent_at, which answers "did
-- we nudge this person today" but not "have we already nudged them about THIS
-- lead". Without the second question a permanently-ignored lead reappears in
-- the digest every single week, which trains the operator to ignore the digest
-- rather than the lead.
--
-- CONSEQUENCE FOR ENGAGEMENT SCORING (later phase): every aggregate that means
-- "operator activity" must filter to the operator-generated types explicitly
-- rather than counting rows in lead_events. Counting all rows would let our own
-- nudges inflate the engagement score of the least engaged customers — exactly
-- inverting the measure.
--
-- The CHECK constraint is replaced rather than edited in place; 0043 is left
-- untouched.
-- ============================================================================

alter table public.lead_events
  drop constraint if exists lead_events_event_type_check;

alter table public.lead_events
  add constraint lead_events_event_type_check
  check (event_type in (
    -- Operator-generated (engagement signals).
    'detail_opened',
    'tel_click',
    'mailto_click',
    'note_added',
    'file_added',
    'stage_changed',
    -- System-generated (NOT an engagement signal).
    'nudge_sent'
  ));
