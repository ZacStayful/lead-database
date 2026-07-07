-- ============================================================================
-- Enable Guaranteed Rent on the owner account for preview/testing.
--
-- The owner (zac@stayful.co.uk) signs up through the owner-override path, which
-- provisions an active management account but no GR subscription. This one-off
-- backfill flips the same account to an active GR subscriber so the GR surfaces
-- (dashboard documents/agreement, GR badges, admin GR card, and — once GR leads
-- are assigned — the Management/Guaranteed Rent lead filter) are visible without
-- a Stripe subscription.
--
-- greatest(...) keeps a topped-up balance if this ever re-runs. If the owner
-- email differs in your deployment, change the address below.
-- ============================================================================
update public.customers
  set gr_subscription_status  = 'active',
      gr_monthly_allocation   = 10,
      gr_lead_balance         = greatest(gr_lead_balance, 10),
      gr_billing_cycle_anchor = coalesce(gr_billing_cycle_anchor, current_date),
      updated_at              = now()
  where email = 'zac@stayful.co.uk';
