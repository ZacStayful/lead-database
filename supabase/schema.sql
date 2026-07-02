-- ============================================================================
-- Stayful Lead Marketplace — full database setup (consolidated)
-- Paste this entire file into the Supabase SQL editor and run it once.
-- Idempotent: safe to re-run. Combines migrations 0001 + 0002 + 0003.
-- ============================================================================

-- >>> 0001_init.sql >>>
-- ============================================================================
-- Stayful Lead Marketplace — initial schema
-- Tables, functions, RLS policies.
-- Run this in the Supabase SQL editor (or via the Supabase CLI) before
-- deploying application code.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.customers (
  id                        uuid primary key default gen_random_uuid(),
  user_id                   uuid references auth.users(id) on delete cascade,
  business_name             text not null,
  contact_name              text not null,
  email                     text not null unique,
  phone                     text,
  stripe_customer_id        text unique,
  stripe_subscription_id    text,
  subscription_status       text default 'inactive',
  monthly_allocation        integer default 20,
  leads_received_this_month integer default 0,
  overflow_enabled          boolean default false,
  is_active                 boolean default true,
  last_assignment_at        timestamptz,
  created_at                timestamptz default now(),
  updated_at                timestamptz default now()
);

create table if not exists public.leads (
  id                       uuid primary key default gen_random_uuid(),
  monday_item_id           text unique not null,
  lead_name                text not null,
  address                  text,
  phone                    text,
  email                    text,
  lead_profile             text,
  bedrooms                 text,
  enquiry_date             text,
  estimated_monthly_income text,
  assignment_count         integer default 0,
  max_assignments          integer default 2,
  created_at               timestamptz default now()
);

create table if not exists public.lead_assignments (
  id                uuid primary key default gen_random_uuid(),
  lead_id           uuid references public.leads(id) on delete cascade,
  customer_id       uuid references public.customers(id) on delete cascade,
  price_paid        numeric not null default 15.00,
  notification_sent boolean default false,
  email_sent        boolean default false,
  viewed_at         timestamptz,
  status            text default 'active',
  assigned_at       timestamptz default now(),
  unique (lead_id, customer_id)
);

create table if not exists public.payments (
  id                       uuid primary key default gen_random_uuid(),
  customer_id              uuid references public.customers(id),
  stripe_payment_intent_id text,
  stripe_invoice_id        text,
  amount_pence             integer not null,
  credits_added            integer,
  payment_type             text,
  status                   text,
  created_at               timestamptz default now()
);

create table if not exists public.notifications (
  id                 uuid primary key default gen_random_uuid(),
  customer_id        uuid references public.customers(id) on delete cascade,
  lead_assignment_id uuid references public.lead_assignments(id),
  notification_type  text,
  message            text,
  read_at            timestamptz,
  email_sent         boolean default false,
  created_at         timestamptz default now()
);

-- Helpful indexes
create index if not exists idx_customers_user_id on public.customers(user_id);
create index if not exists idx_lead_assignments_customer on public.lead_assignments(customer_id);
create index if not exists idx_lead_assignments_lead on public.lead_assignments(lead_id);
create index if not exists idx_notifications_customer on public.notifications(customer_id);
create index if not exists idx_leads_created_at on public.leads(created_at desc);

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------

-- Atomically assign a lead to a customer with all invariant checks.
-- Runs with security definer so the webhook (service role) and admin routes
-- share a single, race-safe code path. Row locks prevent double-assignment
-- when two leads/webhooks race.
create or replace function public.assign_lead_to_customer(
  p_lead_id uuid,
  p_customer_id uuid,
  p_price numeric
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead     public.leads%rowtype;
  v_customer public.customers%rowtype;
  v_assignment_id uuid;
begin
  -- Lock the lead and customer rows for the duration of the transaction.
  select * into v_lead from public.leads
    where id = p_lead_id for update;
  if not found then
    raise exception 'Lead % not found', p_lead_id;
  end if;

  select * into v_customer from public.customers
    where id = p_customer_id for update;
  if not found then
    raise exception 'Customer % not found', p_customer_id;
  end if;

  -- Lead capacity check.
  if v_lead.assignment_count >= v_lead.max_assignments then
    raise exception 'Lead % is at max assignments (%/%)',
      p_lead_id, v_lead.assignment_count, v_lead.max_assignments;
  end if;

  -- Customer allocation check: must have remaining allocation OR overflow enabled.
  if v_customer.leads_received_this_month >= v_customer.monthly_allocation
     and not v_customer.overflow_enabled then
    raise exception 'Customer % has no remaining allocation and overflow disabled',
      p_customer_id;
  end if;

  -- Insert the assignment (unique constraint guards against duplicates).
  insert into public.lead_assignments (lead_id, customer_id, price_paid)
    values (p_lead_id, p_customer_id, p_price)
    returning id into v_assignment_id;

  -- Increment counters.
  update public.leads
    set assignment_count = assignment_count + 1
    where id = p_lead_id;

  update public.customers
    set leads_received_this_month = leads_received_this_month + 1,
        last_assignment_at = now(),
        updated_at = now()
    where id = p_customer_id;

  return v_assignment_id;
end;
$$;

-- Return up to p_max eligible customers for a lead, ordered for round-robin
-- fairness (least-recently-assigned first, nulls first so brand-new customers
-- get served promptly).
create or replace function public.get_next_customers_for_lead(
  p_lead_id uuid,
  p_max integer
)
returns table (customer_id uuid)
language sql
security definer
set search_path = public
as $$
  select c.id
  from public.customers c
  where c.is_active = true
    and c.subscription_status = 'active'
    -- not already assigned this lead
    and not exists (
      select 1 from public.lead_assignments la
      where la.lead_id = p_lead_id
        and la.customer_id = c.id
    )
    -- has remaining allocation, or overflow enabled
    and (
      c.leads_received_this_month < c.monthly_allocation
      or c.overflow_enabled = true
    )
  order by c.last_assignment_at asc nulls first, c.created_at asc
  limit p_max;
$$;

-- Reset monthly lead counters. Wire to Supabase cron on the 1st of the month.
create or replace function public.reset_monthly_counts()
returns void
language sql
security definer
set search_path = public
as $$
  update public.customers
    set leads_received_this_month = 0,
        updated_at = now();
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.customers        enable row level security;
alter table public.leads            enable row level security;
alter table public.lead_assignments enable row level security;
alter table public.notifications    enable row level security;
alter table public.payments         enable row level security;

-- Customers: a user can read only their own row. Writes (overflow toggle,
-- allocation changes) are intentionally NOT exposed to the browser client —
-- they go through server routes using the service role so a customer cannot
-- self-grant allocation or flip billing flags.
drop policy if exists "customers_select_own" on public.customers;
create policy "customers_select_own" on public.customers
  for select using (auth.uid() = user_id);

-- Leads: readable by any authenticated user.
drop policy if exists "leads_select_authenticated" on public.leads;
create policy "leads_select_authenticated" on public.leads
  for select using (auth.role() = 'authenticated');

-- Lead assignments: readable only where the customer_id belongs to the user.
drop policy if exists "lead_assignments_select_own" on public.lead_assignments;
create policy "lead_assignments_select_own" on public.lead_assignments
  for select using (
    exists (
      select 1 from public.customers c
      where c.id = lead_assignments.customer_id
        and c.user_id = auth.uid()
    )
  );

-- Lead assignments are updated (viewed_at, status) via server routes using
-- the service role, so no browser-facing update policy is exposed — this
-- prevents a customer from editing price_paid on their own assignment.

-- Notifications: readable and updatable only by the owning customer.
drop policy if exists "notifications_select_own" on public.notifications;
create policy "notifications_select_own" on public.notifications
  for select using (
    exists (
      select 1 from public.customers c
      where c.id = notifications.customer_id
        and c.user_id = auth.uid()
    )
  );

drop policy if exists "notifications_update_own" on public.notifications;
create policy "notifications_update_own" on public.notifications
  for update using (
    exists (
      select 1 from public.customers c
      where c.id = notifications.customer_id
        and c.user_id = auth.uid()
    )
  );

-- Payments: readable only by the owning customer.
drop policy if exists "payments_select_own" on public.payments;
create policy "payments_select_own" on public.payments
  for select using (
    exists (
      select 1 from public.customers c
      where c.id = payments.customer_id
        and c.user_id = auth.uid()
    )
  );

-- NOTE: All writes from the webhook, admin routes, and background jobs use the
-- Supabase service role key, which bypasses RLS. The policies above only gate
-- the browser-facing anon/authenticated client.

-- ---------------------------------------------------------------------------
-- Realtime
-- The customer portal subscribes to INSERTs on notifications and
-- lead_assignments. Add both tables to the realtime publication. (Realtime
-- still enforces the RLS SELECT policies above, so a customer only receives
-- events for their own rows.)
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'notifications'
  ) then
    alter publication supabase_realtime add table public.notifications;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'lead_assignments'
  ) then
    alter publication supabase_realtime add table public.lead_assignments;
  end if;
end $$;

-- >>> 0003_pacing.sql >>>
-- ============================================================================
-- Lead pacing system.
-- Adds billing_cycle_anchor and switches lead assignment from round-robin to
-- deficit-first ordering so leads are distributed proportionally across the
-- billing cycle. Customers behind pace are served first.
-- ============================================================================

alter table public.customers
  add column if not exists billing_cycle_anchor date;

-- Deficit-first assignment. Still returns just customer_id so the webhook
-- contract is unchanged; the pacing deficit is used only for ordering.
--
--   days_elapsed = today - billing_cycle_anchor   (clamped 0..30)
--   expected     = ROUND((days_elapsed / 30) * monthly_allocation)
--   deficit      = expected - leads_received_this_month
--
-- Highest deficit (most behind pace) wins; ties fall back to
-- last_assignment_at ascending for fairness. billing_cycle_anchor falls back to
-- created_at for customers whose subscription webhook hasn't landed yet.
create or replace function public.get_next_customers_for_lead(
  p_lead_id uuid,
  p_max integer
)
returns table (customer_id uuid)
language sql
security definer
set search_path = public
as $$
  select c.id
  from public.customers c
  where c.is_active = true
    and c.subscription_status = 'active'
    and not exists (
      select 1 from public.lead_assignments la
      where la.lead_id = p_lead_id
        and la.customer_id = c.id
    )
    and (
      c.leads_received_this_month < c.monthly_allocation
      or c.overflow_enabled = true
    )
  order by
    round(
      (least(greatest(
        extract(day from now() - coalesce(c.billing_cycle_anchor, c.created_at::date)),
        0), 30) / 30.0)
      * c.monthly_allocation
    ) - c.leads_received_this_month desc,
    c.last_assignment_at asc nulls first,
    c.created_at asc
  limit p_max;
$$;

-- >>> 0002_cron.sql (requires pg_cron; run last) >>>
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
