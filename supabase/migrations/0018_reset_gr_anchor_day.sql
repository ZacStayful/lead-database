-- ============================================================================
-- Extend reset_monthly_counts to also reset the guaranteed-rent monthly counter.
--
-- 0014_bugfixes moved the management reset onto each customer's billing-anchor
-- day (daily cron, per-customer) instead of a blanket calendar-1st reset. This
-- redefinition keeps that management behaviour verbatim and adds the symmetric
-- GR reset: gr_leads_received_this_month zeroes on each customer's GR anchor
-- day (gr_billing_cycle_anchor, falling back to created_at). The daily cron from
-- 0014 already drives it — the function decides who resets today.
-- ============================================================================
create or replace function public.reset_monthly_counts()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today     date := current_date;
  v_dom       int  := extract(day from v_today);
  v_last_dom  int  := extract(day from (date_trunc('month', v_today) + interval '1 month - 1 day'));
begin
  -- Management counter — unchanged from 0014.
  update public.customers
    set leads_received_this_month = 0,
        updated_at = now()
    where
      extract(day from coalesce(billing_cycle_anchor, created_at::date)) = v_dom
      or (v_dom = v_last_dom
          and extract(day from coalesce(billing_cycle_anchor, created_at::date)) > v_last_dom);

  -- GR counter — same anchor-day logic on the GR billing anchor.
  update public.customers
    set gr_leads_received_this_month = 0
    where
      extract(day from coalesce(gr_billing_cycle_anchor, created_at::date)) = v_dom
      or (v_dom = v_last_dom
          and extract(day from coalesce(gr_billing_cycle_anchor, created_at::date)) > v_last_dom);
end;
$$;
