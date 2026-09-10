-- ============================================================================
-- Stayful Lead Marketplace — full database setup (consolidated)
-- Paste this entire file into the Supabase SQL editor and run it once.
-- Idempotent: safe to re-run.
--
-- This is a consolidated snapshot of the ordered migrations in
-- supabase/migrations (0001 → 0027) and reflects the current build. The
-- migrations remain the source of truth: when you change the schema, add a new
-- migration and regenerate this file. Function bodies here are copied verbatim
-- from the migration that last defines each one.
--
-- Requires the pgcrypto (gen_random_uuid) and pg_cron extensions, both enabled
-- by default on Supabase.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'lead_type') then
    create type public.lead_type as enum ('management', 'guaranteed_rent');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.customers (
  id                           uuid primary key default gen_random_uuid(),
  user_id                      uuid references auth.users(id) on delete cascade,
  business_name                text not null,
  contact_name                 text not null,
  email                        text not null unique,
  phone                        text,
  stripe_customer_id           text unique,
  stripe_subscription_id       text,
  subscription_status          text default 'inactive',
  monthly_allocation           integer default 20,
  leads_received_this_month    integer default 0,
  lead_balance                 integer not null default 0,
  account_status               text not null default 'waitlisted'
    check (account_status in ('waitlisted', 'invited', 'active', 'cancelled')),
  is_active                    boolean default true,
  first_login_at               timestamptz,
  last_assignment_at           timestamptz,
  billing_cycle_anchor         date,
  -- Guaranteed Rent subscription (independent of the management subscription).
  gr_subscription_status       text not null default 'inactive',
  gr_stripe_subscription_id    text,
  gr_stripe_price_id           text,
  gr_monthly_allocation        integer not null default 10,
  gr_leads_received_this_month integer not null default 0,
  gr_billing_cycle_anchor      date,
  gr_last_assignment_at        timestamptz,
  gr_lead_balance              integer not null default 0,
  -- Lead-quality allowance (0027). Never shown to the customer: the budget is
  -- a share of the plan plus credits earned by taking leads without claiming.
  quality_allowance_pct        numeric not null default 0.10,
  quality_claims_this_cycle    integer not null default 0,
  clean_leads_streak           integer not null default 0,
  quality_review_required      boolean not null default false,
  replacement_filter           jsonb,
  -- Enquiry-form fields captured on the landing page.
  website_url                  text,
  properties_managed           text,
  created_at                   timestamptz default now(),
  updated_at                   timestamptz default now()
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
  -- 3 since 0027 (was 2). Admin can override per lead, 1-4.
  max_assignments          integer default 3,
  -- Set once operators report the lead dead (0027). A 'dead' lead is never
  -- assigned again; 'suspect' means at least one operator wrote it off.
  quality_flag             text check (quality_flag in ('suspect', 'dead')),
  created_at               timestamptz default now(),
  lead_type                public.lead_type not null default 'management',
  -- Guaranteed Rent lead fields (null for management leads).
  last_contact             date,
  desired_rent             text,
  pmi_analysis             text,
  tenancy_agreement        text,
  sourcing_agreement       text,
  formula                  text
);

create table if not exists public.lead_assignments (
  id                        uuid primary key default gen_random_uuid(),
  lead_id                   uuid references public.leads(id) on delete cascade,
  customer_id               uuid references public.customers(id) on delete cascade,
  price_paid                numeric not null default 15.00,
  notification_sent         boolean default false,
  email_sent                boolean default false,
  viewed_at                 timestamptz,
  status                    text default 'new'
    check (status in (
      'new',
      'contacted',
      'no_answer',
      'in_discussion',
      'gone_elsewhere',
      'won',
      'not_relevant',
      'rejected'
    )),
  pipeline_stage            text not null default 'cold'
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
    )),
  due_to_call_date          date,
  income_estimate           numeric,
  rejection_reason          text
    check (rejection_reason is null or rejection_reason in (
      'not_a_fit',
      'invalid_contact',
      'already_with_operator',
      'no_longer_interested',
      'unreachable'
    )),
  contact_validation_result jsonb,
  claim_denied              boolean not null default false,
  rejected_at               timestamptz,
  quality_claim_id          uuid,
  assigned_at               timestamptz default now(),
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

create table if not exists public.lead_notes (
  id                 uuid primary key default gen_random_uuid(),
  lead_assignment_id uuid references public.lead_assignments(id) on delete cascade,
  customer_id        uuid references public.customers(id) on delete cascade,
  body               text not null,
  created_at         timestamptz not null default now()
);

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

create table if not exists public.system_settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.lead_quality_claims (
  id                       uuid primary key default gen_random_uuid(),
  lead_assignment_id       uuid not null unique
                             references public.lead_assignments(id) on delete cascade,
  lead_id                  uuid not null references public.leads(id) on delete cascade,
  customer_id              uuid not null references public.customers(id) on delete cascade,
  reason                   text not null
    check (reason in ('already_with_operator', 'no_longer_interested', 'unreachable')),
  detail                   text not null,
  contacted_on             date,
  attempts                 integer,
  -- ineligible: recorded as feedback only; the assignment is left untouched so
  -- the customer can claim properly once they have worked the lead.
  status                   text not null
    check (status in ('ineligible', 'auto_upheld', 'under_review', 'upheld', 'declined')),
  resolution               text not null default 'none'
    check (resolution in ('none', 'credit', 'replacement')),
  corroboration            text not null default 'none'
    check (corroboration in ('none', 'peer_agrees', 'peer_contradicts')),
  -- False for corroborated claims: agreeing with a peer is free, so honest
  -- claims cost less than dishonest ones.
  allowance_consumed       boolean not null default false,
  replacement_assignment_id uuid references public.lead_assignments(id) on delete set null,
  reviewed_by              uuid references auth.users(id),
  reviewed_at              timestamptz,
  review_note              text,
  created_at               timestamptz not null default now()
);

create index if not exists idx_quality_claims_status
  on public.lead_quality_claims (status)
  where status = 'under_review';

create index if not exists idx_quality_claims_customer
  on public.lead_quality_claims (customer_id, created_at desc);

create index if not exists idx_quality_claims_lead
  on public.lead_quality_claims (lead_id);

create table if not exists public.cycle_quality_surveys (
  id                    uuid primary key default gen_random_uuid(),
  customer_id           uuid not null references public.customers(id) on delete cascade,
  cycle_start           date not null,
  cycle_end             date,
  leads_in_cycle        integer,
  overall_rating        integer check (overall_rating between 1 and 5),
  contactability_rating integer check (contactability_rating between 1 and 5),
  fit_rating            integer check (fit_rating between 1 and 5),
  what_would_improve    text,
  submitted_at          timestamptz,
  created_at            timestamptz not null default now(),
  unique (customer_id, cycle_start)
);

-- lead_assignments.quality_claim_id points at the claim that rejected it. Added
-- after both tables exist because the two reference each other.
alter table public.lead_assignments
  drop constraint if exists lead_assignments_quality_claim_id_fkey;
alter table public.lead_assignments
  add constraint lead_assignments_quality_claim_id_fkey
  foreign key (quality_claim_id)
  references public.lead_quality_claims(id) on delete set null;

create table if not exists public.stripe_events (
  id           text primary key,          -- Stripe event id (evt_...)
  type         text,
  processed_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
create index if not exists idx_customers_user_id on public.customers(user_id);
create index if not exists idx_lead_assignments_customer on public.lead_assignments(customer_id);
create index if not exists idx_lead_assignments_lead on public.lead_assignments(lead_id);
create index if not exists idx_leads_lead_type on public.leads(lead_type);
create index if not exists idx_notifications_customer on public.notifications(customer_id);
create index if not exists idx_lead_notes_assignment on public.lead_notes(lead_assignment_id);
create index if not exists idx_lead_notes_customer on public.lead_notes(customer_id);
create index if not exists idx_lead_files_assignment on public.lead_files(lead_assignment_id);
create index if not exists idx_lead_files_customer on public.lead_files(customer_id);
create index if not exists idx_leads_open_slots
  on public.leads (created_at)
  where quality_flag is null;
create index if not exists idx_lead_assignments_claim_denied
  on public.lead_assignments (claim_denied)
  where claim_denied = true;
-- One 'paid' payment per invoice: the idempotency key for invoice crediting.
create unique index if not exists uq_payments_paid_invoice
  on public.payments (stripe_invoice_id)
  where status = 'paid' and stripe_invoice_id is not null;

-- ---------------------------------------------------------------------------
-- Functions (copied verbatim from the migration that last defines each)
-- ---------------------------------------------------------------------------

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

create or replace function public.credit_invoice(
  p_customer_id uuid,
  p_amount integer,
  p_invoice_id text,
  p_payment_intent_id text,
  p_amount_pence integer,
  p_payment_type text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Claim the invoice by inserting its 'paid' payment row. A duplicate means we
  -- already credited it on an earlier delivery of this event — bail without
  -- touching the balance.
  begin
    insert into public.payments (
      customer_id, stripe_invoice_id, stripe_payment_intent_id,
      amount_pence, credits_added, payment_type, status
    ) values (
      p_customer_id, p_invoice_id, p_payment_intent_id,
      p_amount_pence, p_amount, p_payment_type, 'paid'
    );
  exception when unique_violation then
    return false;
  end;

  if p_payment_type = 'gr_subscription' then
    update public.customers
      set gr_lead_balance = gr_lead_balance + p_amount,
          updated_at = now()
      where id = p_customer_id;
  else
    update public.customers
      set lead_balance = lead_balance + p_amount,
          updated_at = now()
      where id = p_customer_id;
  end if;

  return true;
end;
$$;

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
  select * into v_lead from public.leads
    where id = p_lead_id for update;
  if not found then
    raise exception 'Lead % not found', p_lead_id;
  end if;

  if v_lead.quality_flag = 'dead' then
    raise exception 'Lead % is flagged dead and cannot be assigned', p_lead_id;
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

  if p_lead_type = 'guaranteed_rent' then
    if v_customer.gr_lead_balance <= 0 then
      raise exception 'Customer % has no remaining GR lead balance', p_customer_id;
    end if;
  else
    if v_customer.lead_balance <= 0 then
      raise exception 'Customer % has no remaining lead balance', p_customer_id;
    end if;
  end if;

  insert into public.lead_assignments (lead_id, customer_id, price_paid)
    values (p_lead_id, p_customer_id, p_price)
    returning id into v_assignment_id;

  update public.leads
    set assignment_count = assignment_count + 1
    where id = p_lead_id;

  if p_lead_type = 'guaranteed_rent' then
    update public.customers
      set gr_lead_balance = gr_lead_balance - 1,
          gr_leads_received_this_month = gr_leads_received_this_month + 1,
          gr_last_assignment_at = now(),
          clean_leads_streak = clean_leads_streak + 1,
          updated_at = now()
      where id = p_customer_id;
  else
    update public.customers
      set leads_received_this_month = leads_received_this_month + 1,
          lead_balance = lead_balance - 1,
          last_assignment_at = now(),
          clean_leads_streak = clean_leads_streak + 1,
          updated_at = now()
      where id = p_customer_id;
  end if;

  return v_assignment_id;
end;
$$;

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

create or replace function public.reject_lead_assignment(
  p_assignment_id uuid,
  p_customer_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.lead_assignments
    set status = 'rejected'
    where id = p_assignment_id
      and customer_id = p_customer_id
      and status = 'new';

  if not found then
    raise exception 'Assignment not found, not owned by this customer, or not rejectable';
  end if;
end;
$$;

create or replace function public.apply_lead_rejection(
  p_assignment_id uuid,
  p_customer_id uuid,
  p_lead_type public.lead_type,
  p_reason text,
  p_validation_result jsonb,
  p_restore boolean,
  p_claim_denied boolean
)
returns table (applied boolean, denied boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead_id          uuid;
  v_status           text;
  v_existing_reason  text;
  v_existing_denied  boolean;
begin
  select lead_id, status, rejection_reason, claim_denied
    into v_lead_id, v_status, v_existing_reason, v_existing_denied
    from public.lead_assignments
    where id = p_assignment_id
      and customer_id = p_customer_id
    for update;

  if not found then
    raise exception 'Assignment not found or not owned by this customer';
  end if;

  -- Already processed: idempotent no-op — EXCEPT a not_a_fit rejection is
  -- allowed to supersede a denied invalid_contact claim (still 'new').
  if v_existing_reason is not null then
    if not (
      v_existing_denied
      and v_status = 'new'
      and p_reason = 'not_a_fit'
      and not p_restore
    ) then
      return query select false, v_existing_denied;
      return;
    end if;
  end if;

  if v_status <> 'new' then
    raise exception 'Assignment is not rejectable (status = %)', v_status;
  end if;

  update public.lead_assignments
    set rejection_reason = p_reason,
        contact_validation_result = p_validation_result,
        claim_denied = p_claim_denied,
        rejected_at = case when p_claim_denied then rejected_at else now() end,
        status = case when p_claim_denied then status else 'rejected' end
    where id = p_assignment_id;

  if p_restore then
    if p_lead_type = 'guaranteed_rent' then
      update public.customers
        set gr_lead_balance = gr_lead_balance + 1,
            gr_leads_received_this_month = greatest(gr_leads_received_this_month - 1, 0),
            updated_at = now()
        where id = p_customer_id;
    else
      update public.customers
        set lead_balance = lead_balance + 1,
            leads_received_this_month = greatest(leads_received_this_month - 1, 0),
            updated_at = now()
        where id = p_customer_id;
    end if;

    -- Deliberately NOT decrementing leads.assignment_count. The slot stays
    -- consumed so this lead is never offered to another operator.
  end if;

  return query select true, p_claim_denied;
end;
$$;

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
  v_reason  text;
  v_notes   integer;
begin
  select lead_id, status, rejection_reason
    into v_lead_id, v_status, v_reason
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

  if v_reason is not null then
    raise exception 'Assignment % has a recorded rejection and cannot be discarded',
      p_lead_assignment_id;
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
        quality_claims_this_cycle = 0,
        updated_at = now()
    where
      extract(day from coalesce(billing_cycle_anchor, created_at::date)) = v_dom
      or (v_dom = v_last_dom
          and extract(day from coalesce(billing_cycle_anchor, created_at::date)) > v_last_dom);

  update public.customers
    set gr_leads_received_this_month = 0
    where
      extract(day from coalesce(gr_billing_cycle_anchor, created_at::date)) = v_dom
      or (v_dom = v_last_dom
          and extract(day from coalesce(gr_billing_cycle_anchor, created_at::date)) > v_last_dom);
end;
$$;


create or replace function public.uphold_quality_claim(p_claim_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim     public.lead_quality_claims%rowtype;
  v_lead_type public.lead_type;
begin
  select * into v_claim
    from public.lead_quality_claims
    where id = p_claim_id
    for update;

  if not found then
    raise exception 'Quality claim % not found', p_claim_id;
  end if;

  select lead_type into v_lead_type from public.leads where id = v_claim.lead_id;

  if v_lead_type = 'guaranteed_rent' then
    update public.customers
      set gr_lead_balance = gr_lead_balance + 1,
          gr_leads_received_this_month = greatest(gr_leads_received_this_month - 1, 0),
          quality_claims_this_cycle = quality_claims_this_cycle
            + case when v_claim.allowance_consumed then 1 else 0 end,
          clean_leads_streak = 0,
          updated_at = now()
      where id = v_claim.customer_id;
  else
    update public.customers
      set lead_balance = lead_balance + 1,
          leads_received_this_month = greatest(leads_received_this_month - 1, 0),
          quality_claims_this_cycle = quality_claims_this_cycle
            + case when v_claim.allowance_consumed then 1 else 0 end,
          clean_leads_streak = 0,
          updated_at = now()
      where id = v_claim.customer_id;
  end if;

  update public.lead_assignments
    set status = 'rejected'
    where id = v_claim.lead_assignment_id;
end;
$$;

create or replace function public.apply_quality_claim(
  p_assignment_id uuid,
  p_customer_id uuid,
  p_reason text,
  p_detail text,
  p_contacted_on date,
  p_attempts integer,
  p_decision text,
  p_consumes_allowance boolean,
  p_corroboration text
)
returns table (applied boolean, claim_id uuid, claim_status text, upheld boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead_id         uuid;
  v_existing_reason text;
  v_existing_claim  uuid;
  v_claim_status    text;
  v_claim_id        uuid;
  v_upheld          boolean;
begin
  select lead_id, rejection_reason, quality_claim_id
    into v_lead_id, v_existing_reason, v_existing_claim
    from public.lead_assignments
    where id = p_assignment_id
      and customer_id = p_customer_id
    for update;

  if not found then
    raise exception 'Assignment not found or not owned by this customer';
  end if;

  -- An ineligible report never blocks a later, proper claim, so it is stored
  -- without consulting or setting the assignment's rejection state.
  if p_decision = 'ineligible' then
    insert into public.lead_quality_claims (
      lead_assignment_id, lead_id, customer_id, reason, detail,
      contacted_on, attempts, status, corroboration
    ) values (
      p_assignment_id, v_lead_id, p_customer_id, p_reason, p_detail,
      p_contacted_on, p_attempts, 'ineligible', coalesce(p_corroboration, 'none')
    )
    on conflict (lead_assignment_id) do nothing
    returning id into v_claim_id;

    return query select true, v_claim_id, 'ineligible'::text, false;
    return;
  end if;

  if v_existing_reason is not null then
    select status into v_claim_status
      from public.lead_quality_claims where id = v_existing_claim;
    return query
      select false, v_existing_claim, coalesce(v_claim_status, 'under_review'),
             coalesce(v_claim_status, '') in ('auto_upheld', 'upheld');
    return;
  end if;

  v_upheld := p_decision = 'auto_uphold';
  v_claim_status := case when v_upheld then 'auto_upheld' else 'under_review' end;

  -- A prior ineligible report on this assignment is replaced by the real claim.
  delete from public.lead_quality_claims
    where lead_assignment_id = p_assignment_id and status = 'ineligible';

  insert into public.lead_quality_claims (
    lead_assignment_id, lead_id, customer_id, reason, detail,
    contacted_on, attempts, status, corroboration, allowance_consumed
  ) values (
    p_assignment_id, v_lead_id, p_customer_id, p_reason, p_detail,
    p_contacted_on, p_attempts, v_claim_status, coalesce(p_corroboration, 'none'),
    v_upheld and coalesce(p_consumes_allowance, false)
  )
  returning id into v_claim_id;

  update public.lead_assignments
    set rejection_reason = p_reason,
        rejected_at = now(),
        quality_claim_id = v_claim_id
    where id = p_assignment_id;

  if v_upheld then
    perform public.uphold_quality_claim(v_claim_id);
  end if;

  return query select true, v_claim_id, v_claim_status, v_upheld;
end;
$$;

create or replace function public.resolve_quality_claim(
  p_claim_id uuid,
  p_upheld boolean,
  p_reviewer uuid,
  p_review_note text,
  p_consumes_allowance boolean default true
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  select status into v_status
    from public.lead_quality_claims
    where id = p_claim_id
    for update;

  if not found then
    raise exception 'Quality claim % not found', p_claim_id;
  end if;

  -- Only a pending claim can be adjudicated; anything else is a no-op so a
  -- double-click in admin cannot refund twice.
  if v_status <> 'under_review' then
    return false;
  end if;

  update public.lead_quality_claims
    set status = case when p_upheld then 'upheld' else 'declined' end,
        allowance_consumed = p_upheld and coalesce(p_consumes_allowance, true),
        reviewed_by = p_reviewer,
        reviewed_at = now(),
        review_note = p_review_note
    where id = p_claim_id;

  if p_upheld then
    perform public.uphold_quality_claim(p_claim_id);
  end if;

  return true;
end;
$$;

create or replace function public.flag_lead_dead_if_unanimous(p_lead_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total  integer;
  v_dead   integer;
  v_flag   text;
begin
  select count(*) into v_total
    from public.lead_assignments where lead_id = p_lead_id;

  select count(*) into v_dead
    from public.lead_assignments la
    join public.lead_quality_claims c on c.lead_assignment_id = la.id
    where la.lead_id = p_lead_id
      and c.status in ('auto_upheld', 'upheld');

  if v_total = 0 or v_dead = 0 then
    return null;
  end if;

  v_flag := case when v_dead >= v_total then 'dead' else 'suspect' end;

  update public.leads set quality_flag = v_flag where id = p_lead_id;

  return v_flag;
end;
$$;

create or replace function public.find_replacement_lead(
  p_customer_id uuid,
  p_lead_type public.lead_type default 'management',
  p_filter jsonb default null
)
returns uuid
language sql
security definer
set search_path = public
as $$
  select l.id
  from public.leads l
  where l.lead_type = p_lead_type
    and l.quality_flag is null
    and l.assignment_count < l.max_assignments
    and not exists (
      select 1 from public.lead_assignments la
      where la.lead_id = l.id and la.customer_id = p_customer_id
    )
    and (
      p_filter is null
      or p_filter->'cities' is null
      or jsonb_array_length(p_filter->'cities') = 0
      or exists (
        select 1 from jsonb_array_elements_text(p_filter->'cities') city
        where l.address ilike '%' || city || '%'
      )
    )
    and (
      p_filter is null
      or p_filter->>'min_bedrooms' is null
      or coalesce(
           nullif(regexp_replace(coalesce(l.bedrooms, ''), '\D', '', 'g'), '')::int,
           0
         ) >= (p_filter->>'min_bedrooms')::int
    )
  order by l.created_at desc
  limit 1;
$$;

create or replace function public.leads_with_open_slots(p_limit integer default 50)
returns table (lead_id uuid, lead_type public.lead_type, open_slots integer)
language sql
security definer
set search_path = public
as $$
  select l.id, l.lead_type, (l.max_assignments - l.assignment_count)
  from public.leads l
  where l.quality_flag is null
    and l.assignment_count < l.max_assignments
  order by l.created_at asc
  limit greatest(coalesce(p_limit, 50), 1);
$$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.customers        enable row level security;
alter table public.leads            enable row level security;
alter table public.lead_assignments enable row level security;
alter table public.notifications    enable row level security;
alter table public.payments         enable row level security;
alter table public.system_settings  enable row level security;
alter table public.lead_notes       enable row level security;
alter table public.lead_files       enable row level security;
alter table public.stripe_events    enable row level security;
-- RLS on with no policies: service role only, through server routes.
alter table public.lead_quality_claims   enable row level security;
alter table public.cycle_quality_surveys enable row level security;

-- Customers: a user can read only their own row. Writes (allocation changes,
-- billing flags) are never exposed to the browser client — they go through
-- server routes using the service role so a customer cannot self-grant.
drop policy if exists "customers_select_own" on public.customers;
create policy "customers_select_own" on public.customers
  for select using (auth.uid() = user_id);

-- Leads: readable only where the current user holds an assignment for the lead.
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
-- Updates (viewed_at, status, price_paid) go through the service role only.
drop policy if exists "lead_assignments_select_own" on public.lead_assignments;
create policy "lead_assignments_select_own" on public.lead_assignments
  for select using (
    exists (
      select 1 from public.customers c
      where c.id = lead_assignments.customer_id
        and c.user_id = auth.uid()
    )
  );

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

-- Lead notes: customers may read their own; inserts go through the service role.
drop policy if exists "lead_notes_select_own" on public.lead_notes;
create policy "lead_notes_select_own" on public.lead_notes
  for select using (
    exists (
      select 1 from public.customers c
      where c.id = lead_notes.customer_id
        and c.user_id = auth.uid()
    )
  );

-- Lead files: customers may read their own metadata; writes via the service role.
drop policy if exists "lead_files_select_own" on public.lead_files;
create policy "lead_files_select_own" on public.lead_files
  for select using (
    exists (
      select 1 from public.customers c
      where c.id = lead_files.customer_id
        and c.user_id = auth.uid()
    )
  );

-- system_settings and stripe_events have RLS enabled with no policy: deny-all to
-- the browser; only the service role (which bypasses RLS) ever touches them.

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

-- ---------------------------------------------------------------------------
-- Seed data
-- ---------------------------------------------------------------------------
insert into public.system_settings (key, value)
  values ('max_active_customers', '10')
  on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Privileged function lockdown (0024).
-- These SECURITY DEFINER functions are only ever called by the server via the
-- service-role client. Strip the default PUBLIC execute grant so the browser
-- anon/authenticated roles cannot call them via PostgREST, and lock the default
-- for future functions too.
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
alter default privileges in schema public
  revoke execute on functions from public, anon, authenticated;
alter default privileges in schema public
  grant execute on functions to service_role;

-- ---------------------------------------------------------------------------
-- Post-call discount offers (0026). Single-use 24h 10%-off Stripe Promotion
-- Code per prospect, generated after a web meeting (manual admin button or
-- automatic Monday.com → n8n door). Independent of lead allocation / pacing /
-- GR logic. A prospect may have no customers row yet, so prospect_email is the
-- handle; matched_customer_id is backfilled at redemption.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- Scheduled jobs (requires pg_cron). Runs daily; reset_monthly_counts decides
-- which customers reset today based on their billing anchor.
-- ---------------------------------------------------------------------------
select cron.unschedule('reset-monthly-lead-counts')
where exists (
  select 1 from cron.job where jobname = 'reset-monthly-lead-counts'
);
select cron.schedule(
  'reset-monthly-lead-counts',
  '5 0 * * *',
  $$ select public.reset_monthly_counts(); $$
);
