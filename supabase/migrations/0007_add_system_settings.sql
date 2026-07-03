-- ============================================================================
-- System settings — a tiny key/value store for admin-tunable configuration.
-- Currently holds max_active_customers, the capacity cap that controls how
-- many customers can be 'active' at once.
-- ============================================================================

create table if not exists public.system_settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

-- Seed the default capacity (idempotent).
insert into public.system_settings (key, value)
  values ('max_active_customers', '10')
  on conflict (key) do nothing;

-- RLS on, with no policies: the table is only ever read/written by the service
-- role (admin routes), never by the browser client.
alter table public.system_settings enable row level security;
