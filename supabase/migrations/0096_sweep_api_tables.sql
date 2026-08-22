-- ---------------------------------------------------------------------------
-- 0096 — Roll up and discard API housekeeping in one statement each.
--
-- The daily sweep folds expiring rate-limit windows into api_usage_daily and
-- then discards them. Doing that arithmetic in application code — read the
-- current total, add, upsert, delete — is idempotent ONLY because the delete
-- removes the source rows: if the upsert landed and the delete failed, the next
-- run added the same windows again. It was also an N+1, one select plus one
-- upsert per key-day.
--
-- Adding inside the upsert makes the arithmetic atomic with the write, and both
-- deletes happen in the same transaction as the function body, so a partial
-- failure rolls the whole thing back rather than leaving a double count.
--
-- Called only by /api/cron/sweep-lead-pool. Additive; nothing else reads it.
-- ---------------------------------------------------------------------------

create or replace function public.sweep_api_tables(
  p_window_retention_hours integer default 24,
  p_log_retention_days     integer default 30
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_window_cutoff timestamptz;
  v_log_cutoff    timestamptz;
  v_rolled        integer := 0;
  v_windows       integer := 0;
  v_logs          integer := 0;
begin
  v_window_cutoff := now() - make_interval(hours => greatest(p_window_retention_hours, 1));
  v_log_cutoff    := now() - make_interval(days  => greatest(p_log_retention_days, 1));

  -- Fold the expiring per-key windows into the daily totals. `excluded` carries
  -- the summed value for that key and day, so re-running after a successful
  -- delete finds nothing left to add.
  with expiring as (
    select subject_id as key_id,
           (window_start at time zone 'utc')::date as day,
           sum(request_count)::integer as total
    from public.api_rate_limits
    where subject_kind = 'key'
      and window_start < v_window_cutoff
    group by subject_id, (window_start at time zone 'utc')::date
  ),
  -- Only keys that still exist: api_usage_daily carries an FK, and a key deleted
  -- outright rather than revoked would otherwise fail the whole sweep.
  rolled as (
    insert into public.api_usage_daily (key_id, day, request_count)
    select e.key_id, e.day, e.total
    from expiring e
    join public.customer_api_keys k on k.id = e.key_id
    on conflict (key_id, day)
      do update set request_count = api_usage_daily.request_count + excluded.request_count
    returning 1
  )
  select count(*)::integer into v_rolled from rolled;

  with gone as (
    delete from public.api_rate_limits
    where window_start < v_window_cutoff
    returning 1
  )
  select count(*)::integer into v_windows from gone;

  with gone_logs as (
    delete from public.api_request_log
    where created_at < v_log_cutoff
    returning 1
  )
  select count(*)::integer into v_logs from gone_logs;

  return jsonb_build_object(
    'rolled_up', v_rolled,
    'windows_deleted', v_windows,
    'log_rows_deleted', v_logs
  );
end;
$$;

-- 0028/0049: a create-or-replace discards the function's ACL, so both lines
-- must be re-asserted after every future edit to the body above.
revoke all on function public.sweep_api_tables(integer, integer)
  from public, anon, authenticated;
grant execute on function public.sweep_api_tables(integer, integer)
  to service_role;
