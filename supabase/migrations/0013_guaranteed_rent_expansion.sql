-- ============================================================================
-- Guaranteed Rent (GR) product expansion.
--
-- Adds a second lead product alongside the existing "management" leads:
--   * a lead_type discriminator on leads (management | guaranteed_rent)
--   * GR-specific subscription/allocation columns on customers
--   * GR-specific lead detail columns on leads (sourced from the GR Monday
--     board 18396542480 "Guaranteed rent leads")
--   * three new pipeline stages for the GR sales flow
--   * lead-type-aware routing/assignment/reset functions
--
-- SCHEMA-CONVENTION NOTE (conflict with the task's ALTER TYPE instruction):
-- pipeline_stage in this codebase is NOT a native enum — it is a TEXT column
-- with a CHECK constraint on lead_assignments (see 0010_pipeline_and_discard).
-- The new stages are therefore added by extending that CHECK constraint, not by
-- `ALTER TYPE pipeline_stage ADD VALUE` (which would fail — no such type exists).
--
-- Two GR board columns are permanently excluded and never stored:
--   text_mkzxkfns  ("Rent offered")
--   text_mkztftwn  ("Profit after guaranteed rent")
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 2a — lead_type enum + column on leads
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'lead_type') then
    create type public.lead_type as enum ('management', 'guaranteed_rent');
  end if;
end $$;

alter table public.leads
  add column if not exists lead_type public.lead_type not null default 'management';

create index if not exists idx_leads_lead_type on public.leads(lead_type);

-- ---------------------------------------------------------------------------
-- 2b — extend the pipeline_stage CHECK constraint with GR-specific stages.
--
-- Existing values (0010): cold, interested_in_the_future, web_meeting_booked,
-- web_meeting_no_show, web_meeting_attended, abandoned.
-- Added below: viewing_booked, contract_sent, contract_signed.
-- ---------------------------------------------------------------------------
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
    'abandoned',
    'viewing_booked',
    'contract_sent',
    'contract_signed'
  ));

-- ---------------------------------------------------------------------------
-- 2c — GR subscription columns on customers
-- ---------------------------------------------------------------------------
alter table public.customers
  add column if not exists gr_subscription_status text not null default 'inactive',
  add column if not exists gr_stripe_subscription_id text,
  add column if not exists gr_stripe_price_id text,
  add column if not exists gr_monthly_allocation integer not null default 10,
  add column if not exists gr_leads_received_this_month integer not null default 0,
  add column if not exists gr_billing_cycle_anchor date,
  add column if not exists gr_last_assignment_at timestamptz,
  add column if not exists gr_lead_balance integer not null default 0;

-- ---------------------------------------------------------------------------
-- 2d — GR-specific lead fields.
--
-- The shared identity/contact fields on the GR board (Name, Address, Email,
-- Phone, Number of bedrooms, Date) reuse the existing generic leads columns
-- (lead_name, address, email, phone, bedrooms, enquiry_date), so no duplicate
-- columns are created for them. New columns are added only for the GR-unique
-- board fields, named snake_case from their Monday title. DATE for date-typed
-- Monday columns, TEXT for everything else (files store their URL as text).
-- The two banned columns are omitted.
-- ---------------------------------------------------------------------------
alter table public.leads
  add column if not exists last_contact date,           -- "Last contact"      (date)
  add column if not exists desired_rent text,           -- "Desired rent"      (text)
  add column if not exists pmi_analysis text,           -- "PMI analysis"      (file url)
  add column if not exists tenancy_agreement text,      -- "Tenancy Agreement" (file url)
  add column if not exists sourcing_agreement text,     -- "Sourcing agreement"(file url)
  add column if not exists formula text;                -- "Formula"           (formula)

-- ---------------------------------------------------------------------------
-- 2c(bis) — GR lead-credit increment, keyed on Stripe customer id, mirroring
-- increment_lead_balance (0005) so the Stripe webhook can top up GR credit
-- without a prior lookup.
-- ---------------------------------------------------------------------------
create or replace function public.increment_gr_lead_balance(
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
    set gr_lead_balance = gr_lead_balance + p_amount,
        updated_at = now()
    where stripe_customer_id = p_stripe_customer_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2e — assign_lead_to_customer, now lead-type aware.
--
-- p_lead_type defaults to 'management' so existing 3-arg callers are unchanged.
-- The old 3-arg signature is dropped first so a single overload remains and
-- named 3-arg calls resolve to the new function via the default.
--
--   management     : existing behaviour — gate on lead_balance, decrement it,
--                    increment leads_received_this_month.
--   guaranteed_rent: gate on gr_lead_balance, decrement it, increment the GR
--                    monthly counter and stamp gr_last_assignment_at. The
--                    management counters (leads_received_this_month, lead_balance)
--                    are never touched, and no overflow logic applies.
-- ---------------------------------------------------------------------------
drop function if exists public.assign_lead_to_customer(uuid, uuid, numeric);
create or replace function public.assign_lead_to_customer(
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

  -- Lead capacity check (applies to both product types).
  if v_lead.assignment_count >= v_lead.max_assignments then
    raise exception 'Lead % is at max assignments (%/%)',
      p_lead_id, v_lead.assignment_count, v_lead.max_assignments;
  end if;

  -- Allocation gate, per product type.
  if p_lead_type = 'guaranteed_rent' then
    if v_customer.gr_lead_balance <= 0 then
      raise exception 'Customer % has no remaining GR lead balance', p_customer_id;
    end if;
  else
    if v_customer.lead_balance <= 0 then
      raise exception 'Customer % has no remaining lead balance', p_customer_id;
    end if;
  end if;

  -- Insert the assignment (unique constraint guards against duplicates).
  insert into public.lead_assignments (lead_id, customer_id, price_paid)
    values (p_lead_id, p_customer_id, p_price)
    returning id into v_assignment_id;

  -- Increment lead capacity counter (both product types).
  update public.leads
    set assignment_count = assignment_count + 1
    where id = p_lead_id;

  -- Spend one credit and bump the relevant monthly counter.
  if p_lead_type = 'guaranteed_rent' then
    update public.customers
      set gr_lead_balance = gr_lead_balance - 1,
          gr_leads_received_this_month = gr_leads_received_this_month + 1,
          gr_last_assignment_at = now(),
          updated_at = now()
      where id = p_customer_id;
  else
    update public.customers
      set leads_received_this_month = leads_received_this_month + 1,
          lead_balance = lead_balance - 1,
          last_assignment_at = now(),
          updated_at = now()
      where id = p_customer_id;
  end if;

  return v_assignment_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2f — get_next_customers_for_lead, now lead-type aware.
--
-- p_lead_type defaults to 'management' so existing callers (2- and 3-arg) are
-- unchanged. The old signature is dropped first for a single clean overload.
--
--   management     : is_active AND account_status='active' AND
--                    subscription_status='active' AND lead_balance>0
--                    (account_status gate preserved from 0008).
--   guaranteed_rent: is_active AND gr_subscription_status='active' AND
--                    gr_lead_balance>0.
--
-- Deficit-first ordering mirrors management but on the GR pacing columns for
-- GR leads. The per-lead invariants (not already assigned, exclusion list)
-- apply to both types.
-- ---------------------------------------------------------------------------
drop function if exists public.get_next_customers_for_lead(uuid, integer, uuid[]);
create or replace function public.get_next_customers_for_lead(
  p_lead_id uuid,
  p_max integer,
  p_exclude_customer_ids uuid[] default '{}'::uuid[],
  p_lead_type public.lead_type default 'management'
)
returns table (customer_id uuid)
language sql
security definer
set search_path = public
as $$
  select c.id
  from public.customers c
  where c.is_active = true
    and not (c.id = any (coalesce(p_exclude_customer_ids, '{}'::uuid[])))
    and not exists (
      select 1 from public.lead_assignments la
      where la.lead_id = p_lead_id
        and la.customer_id = c.id
    )
    and (
      (
        p_lead_type = 'management'
        and c.account_status = 'active'
        and c.subscription_status = 'active'
        and c.lead_balance > 0
      )
      or (
        p_lead_type = 'guaranteed_rent'
        and c.gr_subscription_status = 'active'
        and c.gr_lead_balance > 0
      )
    )
  order by
    case
      when p_lead_type = 'guaranteed_rent' then
        round(
          (least(greatest(
            extract(day from now() - coalesce(c.gr_billing_cycle_anchor, c.created_at::date)),
            0), 30) / 30.0)
          * c.gr_monthly_allocation
        ) - c.gr_leads_received_this_month
      else
        round(
          (least(greatest(
            extract(day from now() - coalesce(c.billing_cycle_anchor, c.created_at::date)),
            0), 30) / 30.0)
          * c.monthly_allocation
        ) - c.leads_received_this_month
    end desc,
    case
      when p_lead_type = 'guaranteed_rent' then c.gr_last_assignment_at
      else c.last_assignment_at
    end asc nulls first,
    c.created_at asc
  limit p_max;
$$;

-- ---------------------------------------------------------------------------
-- 2g — reset_monthly_counts: also reset the GR monthly counter for active GR
-- subscribers (management reset unchanged).
-- ---------------------------------------------------------------------------
create or replace function public.reset_monthly_counts()
returns void
language sql
security definer
set search_path = public
as $$
  update public.customers
    set leads_received_this_month = 0,
        updated_at = now();
  update public.customers
    set gr_leads_received_this_month = 0
    where gr_subscription_status = 'active';
$$;
