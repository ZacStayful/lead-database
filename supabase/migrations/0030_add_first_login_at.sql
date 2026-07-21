-- ============================================================================
-- First-login tracking + welcome email.
--
-- Adds first_login_at to customers so the portal can distinguish a customer's
-- very first sign-in from every subsequent one. Login itself is handled
-- client-side by Supabase (supabase.auth.signInWithPassword), so there is no
-- server login route to hook; instead the dashboard layout — the first
-- authenticated server render after sign-in — atomically flips this column
-- from NULL on first landing and sends a one-time welcome email.
--
-- Exactly-once guarantee: the flip is an
--   UPDATE customers SET first_login_at = now()
--   WHERE id = ? AND first_login_at IS NULL RETURNING id
-- so only the single request that wins the race sees a returned row and sends
-- the email. Concurrent tabs / repeat renders find it already set and no-op.
--
-- Anti-spam backfill: stamp every EXISTING customer as already-onboarded so
-- applying this migration does not blast a "welcome, first time" email to the
-- current customer base on their next visit. Only customers created AFTER this
-- migration start with first_login_at = NULL and therefore receive the welcome
-- on their genuine first sign-in.
-- ============================================================================

alter table public.customers
  add column if not exists first_login_at timestamptz;

-- Treat everyone who already exists as onboarded (see anti-spam note above).
update public.customers
  set first_login_at = now()
  where first_login_at is null;
