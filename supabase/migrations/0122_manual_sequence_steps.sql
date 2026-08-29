-- ---------------------------------------------------------------------------
-- 0122 — Hand-written follow-up steps, with merge fields (§40.14)
--
-- ADDITIVE AND INERT. Three nullable columns and one CHECK, with every default
-- chosen so that existing rows keep exactly the meaning they have today. It
-- redefines no function and touches no balance, counter, pacing or capacity
-- column, so a lagging deploy cannot affect lead allocation.
--
-- WHAT THIS IS FOR. 0121 shipped follow-up sequences where every message is
-- written by the model. That is right when the property has been analysed, and
-- it is not always what an operator wants: some of them have a chase that works
-- and would rather send their own words. `mode = 'manual'` lets a step carry a
-- template the operator wrote, with {{fields}} filled in per lead so the
-- message still reads as being about that specific landlord and property.
--
-- ⚠️ PER STEP, NOT PER SEQUENCE, and that is the whole reason `mode` sits here
-- rather than on `message_sequences`. The useful ladder is mixed: let the model
-- write the opener, where it has the property's own figures to work with, then
-- send a two-line "still interested?" in the operator's own words for steps 2
-- and 3. A sequence-level flag would force them to build two sequences, and a
-- lead may only be in one at a time (0121's unique on assignment_id).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1 — How a step is written.
--
-- Defaulting to 'ai' is what makes this migration inert: every step that exists
-- when it applies keeps behaving exactly as it does now, and the drafting cron's
-- branch reads the default before any code writes the column.
-- ---------------------------------------------------------------------------
alter table public.message_sequence_steps
  add column if not exists mode text not null default 'ai';

alter table public.message_sequence_steps
  add column if not exists body_template text;

alter table public.message_sequence_steps
  drop constraint if exists message_sequence_steps_mode_check;
alter table public.message_sequence_steps
  add constraint message_sequence_steps_mode_check check (mode in ('ai','manual'));

-- ⚠️ A MANUAL STEP WITH NO TEXT WOULD DRAFT NOTHING, EVERY NIGHT, FOR EVER.
-- The drafting cron writes nothing when it cannot produce a message and leaves
-- the run where it was, so tomorrow retries — which is right for a model that
-- was briefly unavailable and wrong for a step that can never succeed. The run
-- would sit stalled until the seven-day drafting_failed timeout swept it, with
-- no indication of why. The constraint makes that state unreachable.
--
-- The converse is deliberately NOT enforced: an 'ai' step may carry a
-- body_template, so switching a step from manual to AI and back does not
-- destroy what the operator wrote.
alter table public.message_sequence_steps
  drop constraint if exists message_sequence_steps_manual_body_check;
alter table public.message_sequence_steps
  add constraint message_sequence_steps_manual_body_check
  check (mode <> 'manual' or (body_template is not null and length(btrim(body_template)) > 0));

comment on column public.message_sequence_steps.mode is
  'ai = the model writes it per lead; manual = body_template is rendered per lead. Per STEP so one '
  'ladder can mix an AI opener with hand-written chases.';
comment on column public.message_sequence_steps.body_template is
  'The operator''s own words, with {{fields}} unresolved. Rendered by mergeFields.ts against a '
  'CLOSED catalogue — the route never reads a column name supplied by the browser.';

-- ---------------------------------------------------------------------------
-- 2 — Where {{booking_link}} comes from.
--
-- ⚠️ ON `customers`, NOT ON THE CONNECTION ROW, and for a stated reason:
-- getCurrentCustomer() reads this table on the service role with select("*"),
-- so every surface already has it with no join and no RLS work. That is how
-- presentation_brand was done (§37) and how presentation_settings before it.
--
-- It exists because a hand-written template REFUSES a raw URL. Links are the
-- strongest single spam signal in a cold WhatsApp and the number at risk
-- belongs to the operator — but a booking link is the one they legitimately
-- want, so it is offered as a field they set once rather than as forty
-- different pasted URLs. One link, stored, checked, and inserted by name.
-- ---------------------------------------------------------------------------
alter table public.customers
  add column if not exists messaging_booking_link text;

comment on column public.customers.messaging_booking_link is
  'The operator''s own booking/calendar URL, inserted into a hand-written follow-up as '
  '{{booking_link}}. The only way a link reaches a templated message (SS40.14).';
