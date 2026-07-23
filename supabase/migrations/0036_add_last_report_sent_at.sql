-- ============================================================================
-- last_report_sent_at — when the Friday progress-report cron last emailed a
-- customer. Used for weekly idempotency: a manual re-run of the cron within the
-- same week is a no-op for anyone already sent, so the report cannot double-send.
--
-- Nullable: a customer who has never received a progress report has NULL here.
-- Distinct from last_nudge_sent_at (0034), which dedups the Monday inactivity
-- nudge; the two streams track their own last-send independently.
-- ============================================================================

alter table public.customers
  add column if not exists last_report_sent_at timestamptz;
