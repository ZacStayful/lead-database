-- ============================================================================
-- The filter volume guarantee.
--
-- Applying a lead filter used to VOID the volume guarantee: the customer
-- narrowed their leads, got nothing back, and paid the same. This replaces that
-- with a priced commitment — a reduced but real guarantee, the cost per lead it
-- implies, and the likelihood of meeting it — which the customer accepts before
-- the filter applies. src/lib/filterGuarantee.ts is the only place the numbers
-- are derived; nothing here recomputes them.
--
-- WHAT LIVES WHERE
-- ---------------------------------------------------------------------------
-- Live state on `customers` (the 0088 pattern): the accepted guarantee is read
-- on every dashboard render by getCurrentCustomer(), which already selects the
-- row on the service role, so a column costs nothing a join would not.
--
-- `filter_guarantee_acceptances` is HISTORY and BEST-EFFORT — a failed insert
-- must never fail the customer's apply. Nothing reads it to decide anything; if
-- settlement read it, it would stop being best-effort and the pattern would
-- break. It exists so a guarantee disputed in six months can be traced to what
-- was actually shown and agreed.
--
-- `filter_guarantee_settlements` is THE MECHANISM, not a log. Its unique key IS
-- the idempotency claim, exactly as payments.stripe_invoice_id is for
-- credit_invoice() — see §5 below.
--
-- WHY filter_guarantee_credit EXISTS SEPARATELY FROM lead_balance
-- ---------------------------------------------------------------------------
-- Applying a filter from `off` clamps lead_balance down to the allocation
-- (src/app/api/customer/filter/route.ts) — the customer forfeits carried
-- surplus by choice. That was harmless when the surplus was unspent plan
-- credit. It is not harmless once part of the balance is compensation we OWED
-- for missing a guarantee: lifting a filter and re-applying it would silently
-- confiscate it. This column tracks the owed portion so the clamp can exclude
-- it. It only ever counts up, like management_lifetime_leads_received.
--
-- NO EXISTING PRIVILEGED FUNCTION IS TOUCHED
-- ---------------------------------------------------------------------------
-- Not credit_invoice, not execute_filter_lift, not reset_monthly_counts. That
-- is deliberate, not incidental (§11 ACL trap): a create-or-replace discards a
-- function's grants, and re-asserting them correctly is the kind of thing that
-- is right until one day it is not. The settlement is a NEW sibling RPC called
-- beside credit_invoice instead, so the two idempotency claims stay
-- independent.
--
-- Additive throughout: new nullable columns, new tables, one new function.
-- Nothing is dropped or renamed. Re-runnable.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 — customers: the accepted guarantee (management), plus the gr_ mirror
--     (invariant 6).
--
-- Read ONLY while (gr_)filter_status is 'active' or 'pending_lift'. A lifted
-- filter's values are stale by design and are overwritten by the next apply —
-- the same rule 0094 set for the selection-mode columns, and for the same
-- reason: clearing them in execute_filter_lift would mean a create-or-replace
-- of a privileged function for a tidiness gain.
-- ---------------------------------------------------------------------------
alter table public.customers
  add column if not exists filter_guaranteed_leads              integer,
  add column if not exists filter_guarantee_estimate            integer,
  add column if not exists filter_guarantee_likelihood_pct      integer,
  add column if not exists filter_guarantee_cost_per_lead_pence integer,
  add column if not exists filter_guarantee_plan_price_pence    integer,
  add column if not exists filter_guarantee_accepted_at         timestamptz,
  add column if not exists filter_guarantee_credit              integer not null default 0;

alter table public.customers
  add column if not exists gr_filter_guaranteed_leads              integer,
  add column if not exists gr_filter_guarantee_estimate            integer,
  add column if not exists gr_filter_guarantee_likelihood_pct      integer,
  add column if not exists gr_filter_guarantee_cost_per_lead_pence integer,
  add column if not exists gr_filter_guarantee_plan_price_pence    integer,
  add column if not exists gr_filter_guarantee_accepted_at         timestamptz,
  add column if not exists gr_filter_guarantee_credit              integer not null default 0;

do $$
declare
  p text;
begin
  foreach p in array array['', 'gr_'] loop
    execute format(
      'alter table public.customers drop constraint if exists customers_%sfilter_guarantee_check',
      p
    );
    execute format($f$
      alter table public.customers add constraint customers_%sfilter_guarantee_check check (
        (%1$sfilter_guaranteed_leads is null or %1$sfilter_guaranteed_leads >= 0)
        and (%1$sfilter_guarantee_estimate is null or %1$sfilter_guarantee_estimate >= 0)
        and (%1$sfilter_guarantee_likelihood_pct is null
             or %1$sfilter_guarantee_likelihood_pct between 0 and 100)
        and (%1$sfilter_guarantee_cost_per_lead_pence is null
             or %1$sfilter_guarantee_cost_per_lead_pence > 0)
        and (%1$sfilter_guarantee_plan_price_pence is null
             or %1$sfilter_guarantee_plan_price_pence > 0)
        and %1$sfilter_guarantee_credit >= 0
      )
    $f$, p);
  end loop;
end $$;

comment on column public.customers.filter_guaranteed_leads is
  'Leads/month accepted under the filter volume guarantee. NULL = none in force. Read only while filter_status is active or pending_lift.';
comment on column public.customers.filter_guarantee_credit is
  'Cumulative shortfall leads credited for a missed guarantee. Counts up only. Excluded from the re-apply clamp so compensation cannot be confiscated.';

-- ---------------------------------------------------------------------------
-- 2 — Acceptance history. Best-effort; nothing gates on it.
-- ---------------------------------------------------------------------------
create table if not exists public.filter_guarantee_acceptances (
  id                    uuid primary key default gen_random_uuid(),
  customer_id           uuid not null references public.customers(id) on delete cascade,
  lead_type             public.lead_type not null,
  guaranteed_leads      integer not null,
  estimate              integer not null,
  likelihood_pct        integer,
  cost_per_lead_pence   integer not null,
  plan_price_pence      integer not null,
  monthly_allocation    integer not null,
  areas                 text[],
  min_bedrooms          integer,
  max_bedrooms          integer,
  selection_mode        text,
  accepted_by_user_id   uuid,
  accepted_at           timestamptz not null default now()
);

create index if not exists idx_filter_guarantee_acceptances_customer
  on public.filter_guarantee_acceptances(customer_id, accepted_at desc);

alter table public.filter_guarantee_acceptances enable row level security;

comment on table public.filter_guarantee_acceptances is
  'Audit trail of accepted filter guarantees. Best-effort: LIVE state is customers.(gr_)filter_guaranteed_leads, never this table.';

-- ---------------------------------------------------------------------------
-- 3 — Settlements. The unique key is the idempotency claim.
-- ---------------------------------------------------------------------------
create table if not exists public.filter_guarantee_settlements (
  id                uuid primary key default gen_random_uuid(),
  customer_id       uuid not null references public.customers(id) on delete cascade,
  lead_type         public.lead_type not null,
  period_start      date not null,
  period_end        date not null,
  guaranteed        integer not null,
  delivered         integer not null,
  credited          integer not null,
  stripe_invoice_id text,
  settled_at        timestamptz not null default now(),
  unique (customer_id, lead_type, period_start)
);

create index if not exists idx_filter_guarantee_settlements_customer
  on public.filter_guarantee_settlements(customer_id, period_start desc);

alter table public.filter_guarantee_settlements enable row level security;

comment on table public.filter_guarantee_settlements is
  'One row per settled billing cycle per product. The unique (customer_id, lead_type, period_start) IS the idempotency claim — a re-run inserts nothing and credits nothing.';

-- ---------------------------------------------------------------------------
-- 5 — settle_filter_guarantee()
--
-- Called from the Stripe invoice.paid handler, once per product, for the cycle
-- that just ENDED. Returns the number of leads credited (0 when nothing is
-- owed, when no guarantee was in force, or when this period was already
-- settled).
--
-- THE ORDER OF THE TWO CALL SITES MATTERS. This must run BEFORE
-- maybeExecuteFilterLift(): execute_filter_lift sets filter_status to 'off',
-- and the guard below requires 'active' or 'pending_lift'. A customer who
-- lifted their filter is still owed the cycle they were filtered for, and
-- settling second would silently lose it for every one of them.
--
-- WHY delivered IS COUNTED HERE RATHER THAN PASSED IN
-- Keeping the trust surface to (customer, product, period) means a caller
-- cannot over- or under-state delivery, deliberately or by drift.
-- leads_received_this_month would have been the easy source and is the wrong
-- one: 0006 decrements it on reject, while invariant 4 says a rejected lead was
-- still delivered and is still chargeable.
--
-- Pool claims COUNT as delivered. A customer who claimed three leads from the
-- expired pool has taken three of the leads they are owed; effective_allocation
-- already reduces their plan expectation by pool_debit for the same reason.
-- Reaching for pool_debit here instead would violate invariant 12.
--
-- A guarantee accepted mid-cycle does NOT owe that cycle: accepted_at must
-- precede the period start. Pro-rating a partial month is harder to explain and
-- harder to defend than "your guarantee starts at your next billing cycle".
-- ---------------------------------------------------------------------------
create or replace function public.settle_filter_guarantee(
  p_customer_id   uuid,
  p_lead_type     public.lead_type,
  p_period_start  date,
  p_period_end    date,
  p_invoice_id    text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_gr       boolean := p_lead_type = 'guaranteed_rent';
  v_status      text;
  v_guaranteed  integer;
  v_accepted    timestamptz;
  v_delivered   integer;
  v_shortfall   integer;
begin
  if p_period_start is null or p_period_end is null then
    return 0;
  end if;

  -- A period shorter than a month is a signup stub or a mid-cycle plan move,
  -- not a month we promised anything for. Makes the first invoice after signup
  -- a no-op without a special case.
  if p_period_end - p_period_start < 20 then
    return 0;
  end if;

  -- Lock first, as credit_invoice does: the balance write below must not race
  -- a concurrent assignment spending a credit.
  if v_is_gr then
    select gr_filter_status, gr_filter_guaranteed_leads, gr_filter_guarantee_accepted_at
      into v_status, v_guaranteed, v_accepted
      from public.customers where id = p_customer_id for update;
  else
    select filter_status, filter_guaranteed_leads, filter_guarantee_accepted_at
      into v_status, v_guaranteed, v_accepted
      from public.customers where id = p_customer_id for update;
  end if;

  if not found then
    raise exception 'Customer % not found', p_customer_id;
  end if;

  if v_status is null or v_status not in ('active', 'pending_lift') then
    return 0;
  end if;
  if coalesce(v_guaranteed, 0) <= 0 then
    return 0;
  end if;
  if v_accepted is null or v_accepted > p_period_start::timestamptz then
    return 0;
  end if;

  select count(*)
    into v_delivered
    from public.lead_assignments la
    join public.leads l on l.id = la.lead_id
   where la.customer_id = p_customer_id
     and l.lead_type = p_lead_type
     and la.assigned_at >= p_period_start::timestamptz
     and la.assigned_at <  p_period_end::timestamptz;

  v_shortfall := greatest(v_guaranteed - coalesce(v_delivered, 0), 0);

  -- Claim the period. A duplicate means an earlier delivery of this event
  -- already settled it — bail without touching the balance. The row is written
  -- even when the shortfall is zero, so "we checked and you were fully served"
  -- is recorded rather than merely implied by absence.
  begin
    insert into public.filter_guarantee_settlements (
      customer_id, lead_type, period_start, period_end,
      guaranteed, delivered, credited, stripe_invoice_id
    ) values (
      p_customer_id, p_lead_type, p_period_start, p_period_end,
      v_guaranteed, coalesce(v_delivered, 0), v_shortfall, p_invoice_id
    );
  exception when unique_violation then
    return 0;
  end;

  if v_shortfall = 0 then
    return 0;
  end if;

  if v_is_gr then
    update public.customers
       set gr_lead_balance          = gr_lead_balance + v_shortfall,
           gr_filter_guarantee_credit = gr_filter_guarantee_credit + v_shortfall,
           updated_at               = now()
     where id = p_customer_id;
  else
    update public.customers
       set lead_balance            = lead_balance + v_shortfall,
           filter_guarantee_credit = filter_guarantee_credit + v_shortfall,
           updated_at              = now()
     where id = p_customer_id;
  end if;

  return v_shortfall;
end;
$$;

-- Privileged: the service role only. 0028's alter default privileges already
-- covers this, but every migration since writes the pair explicitly because a
-- future create-or-replace discards the ACL (§11).
revoke execute on function public.settle_filter_guarantee(uuid, public.lead_type, date, date, text)
  from public, anon, authenticated;
grant execute on function public.settle_filter_guarantee(uuid, public.lead_type, date, date, text)
  to service_role;
