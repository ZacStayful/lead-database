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
-- Nullable with no default: existing customers keep first_login_at = NULL, so
-- they would receive the welcome email on their next sign-in. If that back-fill
-- behaviour is undesirable, stamp existing rows with now() after deploy.
-- ============================================================================

alter table public.customers
  add column if not exists first_login_at timestamptz;
