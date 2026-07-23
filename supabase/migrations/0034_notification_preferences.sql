-- ============================================================================
-- notification_preferences — per-customer opt-in/out for the four portal
-- notification streams, plus last_nudge_sent_at for inactivity-nudge dedup.
--
--   new_lead         — new lead assignment alerts (in-portal + email)
--   credit_warnings  — low / exhausted credit warnings (management only)
--   inactivity_nudge — Monday reminder about leads awaiting follow-up
--   progress_report  — Friday weekly summary of leads worked through
--
-- Stored as a single jsonb blob so new streams can be added without a schema
-- change. The column is NOT NULL with a full default, so every existing row is
-- backfilled on ADD COLUMN and no live row can ever hold NULL. Application code
-- still treats a *missing key* inside the jsonb as `true` (defensive fallback),
-- but that is a safety net, not the primary mechanism — the default below is.
--
-- This is a separate stream set from sms_alerts_enabled (0031), which stays its
-- own boolean; the two coexist and are not merged here.
--
-- last_nudge_sent_at is stamped by the Stage 3 inactivity-nudge cron so a manual
-- re-run of the cron on the same day does not send a customer a duplicate nudge.
-- Nullable: a customer who has never been nudged has NULL here.
-- ============================================================================

alter table public.customers
  add column if not exists notification_preferences jsonb not null default
    '{"new_lead": true, "credit_warnings": true, "inactivity_nudge": true, "progress_report": true}'::jsonb;

alter table public.customers
  add column if not exists last_nudge_sent_at timestamptz;

-- Belt-and-suspenders backfill. The NOT NULL DEFAULT above already fills every
-- existing row on ADD COLUMN, so this matches nothing on a fresh apply; it is
-- kept to make the "no NULL after this migration" guarantee explicit and to stay
-- consistent with the ADD-then-UPDATE convention used by earlier migrations.
update public.customers
set notification_preferences =
  '{"new_lead": true, "credit_warnings": true, "inactivity_nudge": true, "progress_report": true}'::jsonb
where notification_preferences is null;
