-- ============================================================================
-- 0054 — Guaranteed Rent subscriber capacity.
--
-- `max_active_customers` (0007) has always been a management-only figure: the
-- weighted "used" side of it sums `monthly_allocation` across customers with
-- `account_status = 'active'`, and both of those columns are management-only
-- (see CLAUDE.md §3 and invariant 6). Guaranteed Rent therefore had no cap and
-- no place in the admin overview at all.
--
-- This adds the parallel key. Same shape, same default of 10, but it is read
-- against the GR side of `customers`: weight from `gr_monthly_allocation`,
-- population from `gr_subscription_status = 'active'`. Nothing here touches the
-- management key, so the existing figure is unchanged.
--
-- Seeded at 10 to match the management default — "10 management customers and
-- 10 guaranteed rent customers". A GR subscription is £150/mo for 10 leads, so
-- one standard GR subscriber is one slot.
-- ============================================================================

insert into public.system_settings (key, value)
  values ('gr_max_active_customers', '10')
  on conflict (key) do nothing;
