-- ---------------------------------------------------------------------------
-- 0120 — Two contact limits: when a landlord may be messaged, and how often one
--        landlord may be messaged across DIFFERENT operators (§40.12).
--
-- §40.10 enforced the two limits the setup panel already promised, and both are
-- PER CUSTOMER: a rolling 24-hour daily_send_cap and a min_send_interval_secs.
-- Neither asks the two questions below, and both gaps are structural rather
-- than hypothetical.
--
-- MEASURED ON LIVE DATA before this was written:
--
--   * 6 of the 17 WhatsApps ever sent went out at 20:xx London — outside any
--     hour a stranger should be messaging a member of the public.
--   * 136 of 441 leads are held by 2 or more operators, 28 by 3 or more, and
--     one by 5. Nothing stops all of them messaging the same landlord on the
--     same morning, and none of them can see each other.
--   * 0 landlords have been messaged by two operators yet — because the whole
--     book is one operator testing. The moment a second connects, 136
--     landlords are reachable twice over.
--
-- Additive: three settings and one index. No column is added, no constraint
-- changes, and nothing here touches a balance, counter, pacing or capacity
-- column. Inert until the code reads it.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 1 — Quiet hours, and the cross-operator cooldown.
--
-- Platform-wide in system_settings rather than per-customer columns, following
-- messaging_whatsapp_ceiling_per_second (0115). Per-operator windows would need
-- the customer_whatsapp_connections caps_check widened, WHATSAPP_PUBLIC_COLUMNS
-- updated and UI to set them; nobody has asked, and the platform is the right
-- owner of "what hour may a stranger message a member of the public".
--
-- ⚠️ A MISSING KEY MEANS THE DEFAULT WINDOW — not fail-open, and not
-- fail-closed. The polarity has to be chosen here rather than assumed, because
-- the two precedents in this codebase point opposite ways: messagingEnabled
-- fails CLOSED ("an unreadable flag is off") and fetchUkBankHolidays fails OPEN
-- ("an outage degrades to weekends only"). Neither fits a RESTRICTION:
--   * fail-closed would refuse every send when a row cannot be read, taking the
--     whole feature down to protect against sending at the wrong hour;
--   * fail-open would lift the restriction precisely when we cannot confirm it.
-- So the default IS the rule and these rows only move it. The application
-- carries the same numbers as constants.
--
-- Hours are Europe/London and inclusive-exclusive: >= start and < end.
-- Seven days a week, deliberately. A landlord is a CONSUMER, not a business —
-- a Saturday message may land better than a Tuesday one — so businessTime.ts
-- (weekends plus the gov.uk bank-holiday feed) is the wrong calendar here, and
-- its live 8s fetch has no place on a synchronous send path anyway.
-- ---------------------------------------------------------------------------
insert into public.system_settings (key, value) values
  ('messaging_quiet_start_hour', '9'),
  ('messaging_quiet_end_hour',   '20'),
  -- No two DIFFERENT operators may message one landlord inside this window.
  -- A cooldown rather than a lifetime cap: the risk worth preventing is the
  -- same-morning pile-on, and a lifetime cap would block the operator who
  -- legitimately arrives fifth through no fault of their own.
  ('messaging_lead_cooldown_hours', '24')
on conflict (key) do nothing;


-- ---------------------------------------------------------------------------
-- 2 — The index that makes the cooldown lookup cheap.
--
-- ⚠️ THIS IS THE FIRST CUSTOMER-AGNOSTIC READ IN THE MESSAGING FEATURE, and
-- 0116's header explains why every other one is scoped:
--
--     A landlord held by two operators produces TWO threads, one per customer.
--     The leading customer_id in every unique key is the containment guarantee:
--     one customer's conversation is structurally unreachable from another's.
--
-- The cooldown has to reach across that boundary — it exists precisely to ask a
-- question about the OTHER operators — so the crossing is confined to one
-- function (src/lib/messaging/contactLimits.ts) which returns a BOOLEAN and
-- nothing else. No customer id, no name, no count, no timestamp: anything
-- richer would let one operator probe when another is working a shared
-- landlord, which is §19.7's rule in a new setting.
--
-- lead_message_threads_phone_idx is (customer_id, counterparty_phone_norm), so
-- a lookup with no customer cannot use its leading column and would scan the
-- table on every send. Hence a second index on the counterparty alone.
--
-- KEYED ON THE PHONE, NOT lead_id. §18's duplicate-landlord problem means one
-- person can arrive as several leads rows — 28 exact groups when 0070 was
-- written, and there is deliberately no unique constraint on the identity key —
-- so lead_id under-counts in exactly the case that matters: three operators
-- each holding a different row for the same landlord. counterparty_phone_norm
-- is generated from normalised_phone() and is the identity key the rest of this
-- feature already uses, for this same reason.
-- ---------------------------------------------------------------------------
create index if not exists lead_message_threads_counterparty_idx
  on public.lead_message_threads (counterparty_phone_norm)
  where channel = 'whatsapp' and counterparty_phone_norm is not null;


-- ---------------------------------------------------------------------------
-- No backfill, and nothing retroactive.
--
-- Quiet hours is a rule about the clock at send time; it cannot apply to a
-- message already sent. The cooldown reads the existing lead_messages history,
-- so it is retroactive by construction — but only one lead has ever been
-- messaged, so it blocks nothing today. Verified read-only against production
-- over the 136 leads held by two or more operators before this shipped.
-- ---------------------------------------------------------------------------
