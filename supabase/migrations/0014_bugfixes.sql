-- ============================================================================
-- Bug fixes (review round):
--  H1  Restrict the leads SELECT policy so a customer can only read leads
--      actually assigned to them (was: any authenticated user could read all).
--  M3  Reset leads_received_this_month on each customer's billing-anchor day
--      (was: a blanket reset on the calendar 1st, which drifts from the anchor
--      the pacing maths uses). Cron becomes daily.
--  L6  Ensure the account_status CHECK constraint exists even on databases
--      upgraded by re-running the consolidated schema.
-- ============================================================================

-- H1 — leads are readable only where the row is assigned to the caller.
drop policy if exists "leads_select_authenticated" on public.leads;
drop policy if exists "leads_select_assigned" on public.leads;
create policy "leads_select_assigned" on public.leads
  for select using (
    exists (
      select 1
      from public.lead_assignments la
      join public.customers c on c.id = la.customer_id
      where la.lead_id = leads.id
        and c.user_id = auth.uid()
    )
  );

-- L6 — make sure the account_status check exists (idempotent).
alter table public.customers
  drop constraint if exists customers_account_status_check;
alter table public.customers
  add constraint customers_account_status_check
  check (account_status in ('waitlisted', 'invited', 'active', 'cancelled'));

-- M3 — reset each customer's monthly counter on their own anchor day.
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
  update public.customers
    set leads_received_this_month = 0,
        updated_at = now()
    where
      extract(day from coalesce(billing_cycle_anchor, created_at::date)) = v_dom
      -- Anchor days past this month's length (29–31) roll onto the last day.
      or (v_dom = v_last_dom
          and extract(day from coalesce(billing_cycle_anchor, created_at::date)) > v_last_dom);
end;
$$;

-- Re-point the cron to run daily; the function now decides who resets today.
select cron.unschedule('reset-monthly-lead-counts')
where exists (
  select 1 from cron.job where jobname = 'reset-monthly-lead-counts'
);
select cron.schedule(
  'reset-monthly-lead-counts',
  '5 0 * * *',
  $$ select public.reset_monthly_counts(); $$
);
