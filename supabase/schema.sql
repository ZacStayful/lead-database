-- ============================================================================
-- Stayful Lead Marketplace — full database setup (consolidated)
-- Paste this entire file into the Supabase SQL editor and run it once.
-- Idempotent: safe to re-run. Reflects migrations 0001 → 0006.
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
  lead_balance              integer not null default 0,
  account_status            text not null default 'waitlisted'
    check (account_status in ('waitlisted', 'invited', 'active', 'cancelled')),
  is_active                 boolean default true,
  last_assignment_at        timestamptz,
  billing_cycle_anchor      date,
  website_url               text,
  properties_managed        text,
  sms_alerts_enabled        boolean not null default true,
  notification_preferences  jsonb not null default
    '{"new_lead": true, "credit_warnings": true, "inactivity_nudge": true, "progress_report": true}'::jsonb,
  last_nudge_sent_at        timestamptz,
  last_report_sent_at       timestamptz,
  created_at                timestamptz default now(),
  updated_at                timestamptz default now()
);

-- Older databases: bring the customers table up to the current shape.
alter table public.customers
  add column if not exists lead_balance integer not null default 0;
alter table public.customers
  add column if not exists billing_cycle_anchor date;
alter table public.customers
  add column if not exists account_status text not null default 'waitlisted';
-- Ensure the account_status check exists on upgraded databases (the create
-- table above is skipped when the table already exists).
alter table public.customers
  drop constraint if exists customers_account_status_check;
alter table public.customers
  add constraint customers_account_status_check
  check (account_status in ('waitlisted', 'invited', 'active', 'cancelled'));
alter table public.customers
  add column if not exists website_url text;
alter table public.customers
  add column if not exists properties_managed text;
alter table public.customers
  add column if not exists sms_alerts_enabled boolean not null default true;
alter table public.customers
  add column if not exists notification_preferences jsonb not null default
    '{"new_lead": true, "credit_warnings": true, "inactivity_nudge": true, "progress_report": true}'::jsonb;
alter table public.customers
  add column if not exists last_nudge_sent_at timestamptz;
alter table public.customers
  add column if not exists last_report_sent_at timestamptz;
alter table public.customers
  drop column if exists overflow_enabled;
-- Existing customers predate capacity management — treat live rows as active.
update public.customers set account_status = 'active'
  where is_active = true and account_status = 'waitlisted';

-- System settings: admin-tunable key/value store (capacity cap lives here).
create table if not exists public.system_settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);
insert into public.system_settings (key, value)
  values ('max_active_customers', '10')
  on conflict (key) do nothing;
alter table public.system_settings enable row level security;

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
  first_contacted_at timestamptz,
  status            text default 'new',
  assigned_at       timestamptz default now(),
  last_status_change_at timestamptz not null default now(),
  unique (lead_id, customer_id)
);

-- Older databases: speed-to-lead first-contact timestamp.
alter table public.lead_assignments
  add column if not exists first_contacted_at timestamptz;

-- Older databases: last status-change timestamp for the inactivity nudge.
alter table public.lead_assignments
  add column if not exists last_status_change_at timestamptz not null default now();
update public.lead_assignments
  set last_status_change_at = coalesce(first_contacted_at, assigned_at);

-- Canonical assignment status set (adds 'rejected'). Normalise legacy 'active'
-- rows to 'new' before applying the constraint.
update public.lead_assignments
  set status = 'new'
  where status is null
     or status not in
        ('new', 'contacted', 'in_discussion', 'won', 'not_relevant', 'rejected');
alter table public.lead_assignments
  alter column status set default 'new';
alter table public.lead_assignments
  drop constraint if exists lead_assignments_status_check;
alter table public.lead_assignments
  add constraint lead_assignments_status_check
  check (status in ('new', 'contacted', 'in_discussion', 'won', 'not_relevant', 'rejected'));

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

-- Add lead credit for a customer, keyed on their Stripe customer id. Called by
-- the Stripe webhook on every successful subscription payment.
create or replace function public.increment_lead_balance(
  p_stripe_customer_id text,
  p_amount integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.customers
    set lead_balance = lead_balance + p_amount,
        updated_at = now()
    where stripe_customer_id = p_stripe_customer_id;
end;
$$;

-- Atomically assign a lead to a customer with all invariant checks.
-- Runs with security definer so the webhook (service role) and admin routes
-- share a single, race-safe code path. Row locks prevent double-assignment
-- when two leads/webhooks race. Lead balance is the sole allocation gate and is
-- decremented in the same transaction as the assignment insert.
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

  if v_lead.assignment_count >= v_lead.max_assignments then
    raise exception 'Lead % is at max assignments (%/%)',
      p_lead_id, v_lead.assignment_count, v_lead.max_assignments;
  end if;

  if v_customer.lead_balance <= 0 then
    raise exception 'Customer % has no remaining lead balance', p_customer_id;
  end if;

  insert into public.lead_assignments (lead_id, customer_id, price_paid)
    values (p_lead_id, p_customer_id, p_price)
    returning id into v_assignment_id;

  update public.leads
    set assignment_count = assignment_count + 1
    where id = p_lead_id;

  update public.customers
    set leads_received_this_month = leads_received_this_month + 1,
        lead_balance = lead_balance - 1,
        last_assignment_at = now(),
        updated_at = now()
    where id = p_customer_id;

  return v_assignment_id;
end;
$$;

-- Admin override: place a lead with a customer IGNORING the credit/subscription
-- gate that assign_lead_to_customer enforces. Capacity (max_assignments), the
-- MANAGEMENT pause block, and the (lead_id, customer_id) unique constraint still
-- apply. Spends a credit only when one exists so an override never drives a
-- balance negative. Service-role only. (See migration 0040.)
create or replace function public.admin_assign_lead(
  p_lead_id uuid,
  p_customer_id uuid,
  p_price numeric,
  p_lead_type public.lead_type default 'management'
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

  if v_lead.assignment_count >= v_lead.max_assignments then
    raise exception 'Lead % is at max assignments (%/%)',
      p_lead_id, v_lead.assignment_count, v_lead.max_assignments;
  end if;

  if p_lead_type <> 'guaranteed_rent' and v_customer.paused_at is not null then
    raise exception 'Customer % is paused and cannot receive management leads', p_customer_id;
  end if;

  insert into public.lead_assignments (lead_id, customer_id, price_paid)
    values (p_lead_id, p_customer_id, p_price)
    returning id into v_assignment_id;

  update public.leads
    set assignment_count = assignment_count + 1
    where id = p_lead_id;

  if p_lead_type = 'guaranteed_rent' then
    update public.customers
      set gr_lead_balance = greatest(gr_lead_balance - 1, 0),
          gr_leads_received_this_month = gr_leads_received_this_month + 1,
          gr_last_assignment_at = now(),
          updated_at = now()
      where id = p_customer_id;
  else
    update public.customers
      set lead_balance = greatest(lead_balance - 1, 0),
          leads_received_this_month = leads_received_this_month + 1,
          last_assignment_at = now(),
          updated_at = now()
      where id = p_customer_id;
  end if;

  return v_assignment_id;
end;
$$;

revoke execute on function public.admin_assign_lead(uuid, uuid, numeric, public.lead_type)
  from public, anon, authenticated;
grant execute on function public.admin_assign_lead(uuid, uuid, numeric, public.lead_type)
  to service_role;

-- Return up to p_max eligible customers for a lead, ordered deficit-first
-- (customers behind pace served first). Eligibility requires an active
-- subscription and a positive lead_balance, and excludes customers already
-- assigned this lead or listed in p_exclude_customer_ids.
--
--   days_elapsed = today - billing_cycle_anchor   (clamped 0..30)
--   expected     = ROUND((days_elapsed / 30) * monthly_allocation)
--   deficit      = expected - leads_received_this_month
--
-- billing_cycle_anchor falls back to created_at when the subscription webhook
-- hasn't landed yet.
drop function if exists public.get_next_customers_for_lead(uuid, integer);
create or replace function public.get_next_customers_for_lead(
  p_lead_id uuid,
  p_max integer,
  p_exclude_customer_ids uuid[] default '{}'::uuid[]
)
returns table (customer_id uuid)
language sql
security definer
set search_path = public
as $$
  select c.id
  from public.customers c
  where c.is_active = true
    and c.account_status = 'active'
    and c.subscription_status = 'active'
    and c.lead_balance > 0
    and not (c.id = any (coalesce(p_exclude_customer_ids, '{}'::uuid[])))
    and not exists (
      select 1 from public.lead_assignments la
      where la.lead_id = p_lead_id
        and la.customer_id = c.id
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

-- Atomic rejection: flip a 'new' assignment to 'rejected', restore one lead
-- credit, decrement the monthly counter, and reopen the lead's assignment slot.
create or replace function public.reject_lead_assignment(
  p_assignment_id uuid,
  p_customer_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead_id uuid;
begin
  select lead_id into v_lead_id
  from public.lead_assignments
  where id = p_assignment_id
    and customer_id = p_customer_id
    and status = 'new';

  if not found then
    raise exception 'Assignment not found, not owned by this customer, or not rejectable';
  end if;

  update public.lead_assignments
    set status = 'rejected'
    where id = p_assignment_id;

  update public.customers
    set lead_balance = lead_balance + 1,
        leads_received_this_month = greatest(leads_received_this_month - 1, 0),
        updated_at = now()
    where id = p_customer_id;

  update public.leads
    set assignment_count = greatest(assignment_count - 1, 0)
    where id = v_lead_id;
end;
$$;

-- Reset monthly lead counters on each customer's billing-anchor day, so the
-- counter window matches the pacing window (which counts days since the anchor).
-- Wired to a DAILY cron; the function decides who resets today. Only touches
-- leads_received_this_month; lead_balance is independent and never reset here.
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

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.customers        enable row level security;
alter table public.leads            enable row level security;
alter table public.lead_assignments enable row level security;
alter table public.notifications    enable row level security;
alter table public.payments         enable row level security;

-- Customers: a user can read only their own row. Writes (allocation changes,
-- billing flags) are intentionally NOT exposed to the browser client — they go
-- through server routes using the service role so a customer cannot self-grant
-- allocation or flip billing flags.
drop policy if exists "customers_select_own" on public.customers;
create policy "customers_select_own" on public.customers
  for select using (auth.uid() = user_id);

-- Leads: readable only where the lead is assigned to the caller. The app reads
-- leads via the service role (joined through lead_assignments), so this policy
-- exists purely to prevent a customer using the anon client to scrape the whole
-- lead inventory.
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

-- ---------------------------------------------------------------------------
-- Monthly reset cron (requires pg_cron; run last).
-- Runs reset_monthly_counts() daily at 00:05; the function resets only the
-- customers whose billing-anchor day is today.
-- ---------------------------------------------------------------------------
create extension if not exists pg_cron;

select cron.unschedule('reset-monthly-lead-counts')
where exists (
  select 1 from cron.job where jobname = 'reset-monthly-lead-counts'
);

select cron.schedule(
  'reset-monthly-lead-counts',
  '5 0 * * *',
  $$ select public.reset_monthly_counts(); $$
);

-- >>> 0009_add_lead_notes.sql >>>
-- ============================================================================
-- Lead notes — timestamped, customer-private notes attached to a lead the
-- customer has been assigned. Lets an operator keep a running contact history
-- (calls, emails, next steps) against each lead.
--
-- Keyed on lead_assignment_id (unique per customer/lead pair). customer_id is
-- denormalised so RLS and the export can filter without a join.
-- ============================================================================

create table if not exists public.lead_notes (
  id                 uuid primary key default gen_random_uuid(),
  lead_assignment_id uuid references public.lead_assignments(id) on delete cascade,
  customer_id        uuid references public.customers(id) on delete cascade,
  body               text not null,
  created_at         timestamptz not null default now()
);

create index if not exists idx_lead_notes_assignment
  on public.lead_notes(lead_assignment_id);
create index if not exists idx_lead_notes_customer
  on public.lead_notes(customer_id);

alter table public.lead_notes enable row level security;

-- Customers may read their own notes. Inserts go through a server route using
-- the service role, so no insert policy is exposed to the browser client.
drop policy if exists "lead_notes_select_own" on public.lead_notes;
create policy "lead_notes_select_own" on public.lead_notes
  for select using (
    exists (
      select 1 from public.customers c
      where c.id = lead_notes.customer_id
        and c.user_id = auth.uid()
    )
  );

-- >>> 0010_pipeline_and_discard.sql >>>
-- ============================================================================
-- Pipeline tracking + discard.
--
-- Adds a pipeline_stage and a due_to_call_date to lead_assignments, and a
-- discard_lead_assignment() function. The status column and its constraint are
-- left untouched — pipeline_stage is an independent axis.
--
-- NOTE: lead_notes already exists (migration 0009) with its own RLS policy, so
-- no notes table is created here.
-- ============================================================================

-- pipeline_stage: text + check constraint, matching the status column pattern
-- (this schema uses text+check rather than native enums). Independent of status.
alter table public.lead_assignments
  add column if not exists pipeline_stage text not null default 'cold';

alter table public.lead_assignments
  drop constraint if exists lead_assignments_pipeline_stage_check;
alter table public.lead_assignments
  add constraint lead_assignments_pipeline_stage_check
  check (pipeline_stage in (
    'cold',
    'interested_in_the_future',
    'web_meeting_booked',
    'web_meeting_no_show',
    'web_meeting_attended',
    'abandoned'
  ));

alter table public.lead_assignments
  add column if not exists due_to_call_date date;

-- ---------------------------------------------------------------------------
-- discard_lead_assignment — atomic, mirroring assign_lead_to_customer's
-- lock-then-check-then-mutate pattern.
--
--   1. Assignment must be status = 'new' AND have no lead_notes rows.
--   2. Delete the lead_assignments row.
--   3. Decrement leads.assignment_count (so the lead is eligible again,
--      respecting max_assignments).
--   4. Do NOT touch customers.leads_received_this_month or lead_balance —
--      a discarded lead still counts toward the monthly allocation.
-- Any failed check raises and rolls back with no changes.
-- ---------------------------------------------------------------------------
create or replace function public.discard_lead_assignment(
  p_lead_assignment_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead_id uuid;
  v_status  text;
  v_notes   integer;
begin
  select lead_id, status
    into v_lead_id, v_status
    from public.lead_assignments
    where id = p_lead_assignment_id
    for update;

  if not found then
    raise exception 'Assignment % not found', p_lead_assignment_id;
  end if;

  if v_status <> 'new' then
    raise exception 'Assignment % is not discardable (status = %)',
      p_lead_assignment_id, v_status;
  end if;

  select count(*) into v_notes
    from public.lead_notes
    where lead_assignment_id = p_lead_assignment_id;

  if v_notes > 0 then
    raise exception 'Assignment % has notes and cannot be discarded',
      p_lead_assignment_id;
  end if;

  delete from public.lead_assignments where id = p_lead_assignment_id;

  update public.leads
    set assignment_count = greatest(assignment_count - 1, 0)
    where id = v_lead_id;
end;
$$;

-- >>> 0011_lead_files.sql >>>
-- ============================================================================
-- Lead file attachments — customers can attach files (e.g. an STR Analyser
-- PDF) to a lead they've been assigned, and retrieve them later.
--
-- Files live in a private Storage bucket 'lead-files'; this table holds the
-- metadata. Storage objects are laid out as  <user_id>/<assignment_id>/<file>
-- so a single path-prefix check secures both upload and read.
-- ============================================================================

create table if not exists public.lead_files (
  id                 uuid primary key default gen_random_uuid(),
  lead_assignment_id uuid references public.lead_assignments(id) on delete cascade,
  customer_id        uuid references public.customers(id) on delete cascade,
  file_name          text not null,
  storage_path       text not null,
  size_bytes         bigint,
  mime_type          text,
  created_at         timestamptz not null default now()
);

create index if not exists idx_lead_files_assignment
  on public.lead_files(lead_assignment_id);
create index if not exists idx_lead_files_customer
  on public.lead_files(customer_id);

alter table public.lead_files enable row level security;

-- Customers may read their own file metadata. Inserts/deletes go through server
-- routes using the service role, so no write policy is exposed to the browser.
drop policy if exists "lead_files_select_own" on public.lead_files;
create policy "lead_files_select_own" on public.lead_files
  for select using (
    exists (
      select 1 from public.customers c
      where c.id = lead_files.customer_id
        and c.user_id = auth.uid()
    )
  );

-- ============================================================================
-- Testimonials — a one-line quote a customer can leave at the moment they mark
-- a lead as signed. With consent_to_publish they become landing-page proof.
-- ============================================================================
create table if not exists public.testimonials (
  id                 uuid primary key default gen_random_uuid(),
  customer_id        uuid not null references public.customers(id) on delete cascade,
  lead_assignment_id uuid references public.lead_assignments(id) on delete set null,
  body               text not null,
  rating             smallint check (rating between 1 and 5),
  consent_to_publish boolean not null default false,
  created_at         timestamptz not null default now()
);

create index if not exists idx_testimonials_customer
  on public.testimonials(customer_id);

alter table public.testimonials enable row level security;

-- Customers may read their own testimonials. Inserts go through a server route
-- using the service role, so no insert policy is exposed to the browser client.
drop policy if exists "testimonials_select_own" on public.testimonials;
create policy "testimonials_select_own" on public.testimonials
  for select using (
    exists (
      select 1 from public.customers c
      where c.id = testimonials.customer_id
        and c.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- Storage bucket + object policies.
-- Private bucket, 25 MB per file. Path convention: <user_id>/<assignment_id>/…
-- so (storage.foldername(name))[1] is the owner's auth uid.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('lead-files', 'lead-files', false, 26214400)
on conflict (id) do update set file_size_limit = excluded.file_size_limit;

drop policy if exists "lead_files_object_insert" on storage.objects;
create policy "lead_files_object_insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'lead-files'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "lead_files_object_select" on storage.objects;
create policy "lead_files_object_select" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'lead-files'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "lead_files_object_delete" on storage.objects;
create policy "lead_files_object_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'lead-files'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- >>> 0012_income_estimate.sql >>>
-- ============================================================================
-- Per-lead income estimate.
-- The customer's own estimated monthly income for a lead/property, entered in
-- their portal. Lives on lead_assignments (per customer/lead), independent of
-- anything pulled from Monday. Feeds the analytics income totals.
-- ============================================================================

alter table public.lead_assignments
  add column if not exists income_estimate numeric;

-- >>> 0037_post_call_offers.sql >>>
-- ============================================================================
-- Post-call discount offers (0037). Single-use 24h 10%-off Stripe Promotion
-- Code per prospect, generated after a web meeting (manual admin button or
-- automatic Monday.com → n8n door). Independent of lead allocation / pacing /
-- GR logic. A prospect may have no customers row yet, so prospect_email is the
-- handle; matched_customer_id is backfilled at redemption.
-- ============================================================================
create table if not exists public.post_call_offers (
  id                    uuid primary key default gen_random_uuid(),
  prospect_email        text not null,
  prospect_phone        text,
  prospect_name         text,
  stripe_promo_code_id  text not null,
  promo_code_string     text not null,
  offer_created_at      timestamptz not null default now(),
  expires_at            timestamptz not null,
  redeemed_at           timestamptz,
  redeemed_plan         text check (redeemed_plan in ('10', '20')),
  source                text not null check (source in ('manual', 'auto_monday')),
  reminder_12h_sent_at  timestamptz,
  reminder_4h_sent_at   timestamptz,
  reminder_1h_sent_at   timestamptz,
  created_by            uuid references auth.users(id),
  matched_customer_id   uuid references public.customers(id),
  created_at            timestamptz not null default now()
);

create unique index if not exists uq_post_call_offers_unredeemed_email
  on public.post_call_offers (lower(prospect_email))
  where redeemed_at is null;

create index if not exists idx_post_call_offers_active
  on public.post_call_offers (expires_at)
  where redeemed_at is null;

create index if not exists idx_post_call_offers_promo_code_id
  on public.post_call_offers (stripe_promo_code_id);

create index if not exists idx_post_call_offers_matched_customer
  on public.post_call_offers (matched_customer_id);

alter table public.post_call_offers enable row level security;
