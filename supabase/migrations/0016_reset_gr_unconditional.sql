-- ============================================================================
-- Make the guaranteed-rent monthly reset unconditional.
--
-- 0013's reset_monthly_counts zeroed gr_leads_received_this_month only for
-- currently-active GR subscribers, while the management counter reset for
-- everyone. That asymmetry meant a customer whose GR subscription lapsed over
-- the reset boundary kept a stale GR counter, so on reactivation their GR
-- pacing deficit was strongly negative and they were deprioritised for GR
-- leads until the following month.
--
-- Reset both counters unconditionally — zeroing an inactive customer's counter
-- is harmless (they are not routed leads) and keeps the two products symmetric.
-- ============================================================================
create or replace function public.reset_monthly_counts()
returns void
language sql
security definer
set search_path = public
as $$
  update public.customers
    set leads_received_this_month = 0,
        gr_leads_received_this_month = 0,
        updated_at = now();
$$;
