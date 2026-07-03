-- ============================================================================
-- Remove the overflow feature entirely.
-- Lead volume is now governed by lead_balance (see 0005_add_lead_balance.sql),
-- so the per-customer overflow opt-in flag is no longer referenced anywhere in
-- the application. The functions that read overflow_enabled are redefined in
-- 0005, which runs immediately after this migration.
-- ============================================================================

alter table public.customers drop column if exists overflow_enabled;
