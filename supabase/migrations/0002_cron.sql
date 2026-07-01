-- ============================================================================
-- Monthly reset cron.
-- Requires the pg_cron extension (enable it in the Supabase dashboard under
-- Database → Extensions, or via the statement below).
-- Runs reset_monthly_counts() at 00:05 on the 1st of every month.
-- ============================================================================

create extension if not exists pg_cron;

-- Remove any prior schedule with the same name before (re)creating it.
select cron.unschedule('reset-monthly-lead-counts')
where exists (
  select 1 from cron.job where jobname = 'reset-monthly-lead-counts'
);

select cron.schedule(
  'reset-monthly-lead-counts',
  '5 0 1 * *',
  $$ select public.reset_monthly_counts(); $$
);
