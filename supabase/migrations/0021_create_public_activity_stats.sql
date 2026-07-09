create table if not exists public_activity_stats (
  id integer primary key default 1,
  total_distributed integer not null default 0,
  since_date date not null default '2026-07-01',
  ledger jsonb not null default '[]'::jsonb,
  generated_at timestamptz,
  constraint public_activity_stats_singleton check (id = 1)
);

alter table public_activity_stats enable row level security;

create policy "Public can read activity stats"
  on public_activity_stats
  for select
  using (true);

-- No insert/update/delete policy is defined for anon or authenticated roles.
-- Writes only happen via the service role client in the cron route below,
-- which bypasses RLS by design — the same pattern used elsewhere in this project.
