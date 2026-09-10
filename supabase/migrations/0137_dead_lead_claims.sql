-- ============================================================================
-- 0137 — Dead-lead quality claims (CLAUDE.md §51)
--
-- ⚠️ THIS MIGRATION AMENDS INVARIANT 4. Read §51 before changing anything here.
--
-- Invariant 4 has been "every delivered lead is chargeable; reject does not
-- refund", with ONE exception since 0114 (§39): an UNDELIVERED lead — untouched,
-- released back to the pool when a filter excludes it. `releasable_filter_
-- assignments` guards that with an untouched predicate which "must never be
-- loosened", precisely so it stays distinct from a refund on worked-for value.
--
-- This adds a SECOND exception, and it is deliberately the mirror image:
--
--   §39 (0114)  refunds because NO value was delivered — the lead was never
--               touched, so charging for it was charging for nothing.
--   §51 (0137)  refunds because the value delivered was VOID — the landlord had
--               already appointed another operator, or withdrawn, BEFORE the
--               operator reached them. The lead was spent when we sold it.
--
-- Neither is "the operator worked it and disliked the outcome". That case is
-- still `reject_lead_assignment`, still chargeable, and this migration does not
-- touch it.
--
-- The predicate here is the INVERSE of 0114's. A filter release requires the
-- lead to be untouched; a dead-lead claim requires it to have been WORKED,
-- proven by operator-generated lead_events (CLAUDE.md §3). That table has no
-- browser insert policy — writes go through /api/customer/events on the service
-- role — so the effort gate cannot be manufactured by the customer it gates.
--
-- What bounds the cost is a HIDDEN, EARNED allowance: a per-cycle budget worth a
-- share of the plan plus credits earned by taking leads without claiming, reset
-- to zero whenever a claim is upheld. It is never surfaced to the customer, and
-- a claim beyond it is sent to admin review rather than declined.
--
-- Additive and inert: every column is nullable or defaulted, no existing
-- function changes behaviour except reset_monthly_counts (which gains one more
-- column to zero), and no existing row is rewritten. Production runs the current
-- code against this schema unchanged.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 — Allowance state on the customer
--
-- None of this is ever shown to the customer. §51 states the reasoning: a
-- published number is a number to play against, and the mechanism only works
-- while the budget is discovered rather than announced.
-- ---------------------------------------------------------------------------
alter table public.customers
  add column if not exists quality_allowance_pct numeric not null default 0.10;

alter table public.customers
  add column if not exists quality_claims_this_cycle integer not null default 0;

-- Chargeable leads received since the last UPHELD claim. Drives the earned half
-- of the budget, and resets to 0 on an uphold — so the budget shrinks exactly as
-- it is spent, and an operator who rarely claims accrues headroom.
alter table public.customers
  add column if not exists clean_leads_streak integer not null default 0;

-- Admin kill-switch: every claim from this customer goes to review.
alter table public.customers
  add column if not exists quality_review_required boolean not null default false;

-- ---------------------------------------------------------------------------
-- 2 — The lead flag
--
-- 'suspect' once one operator writes a lead off; 'dead' only when EVERY
-- assigned operator has. One agreeing pair is not enough when a lead sits with
-- three operators and the third is still working it.
--
-- ⚠️ Deliberately NOT wired into any candidate function in this migration.
-- Invariant 11 lists exactly which predicates retire a lead from allocation and
-- names lead_retired_from_allocation() as their single expression; adding a
-- fourth basis belongs in its own change with its own verification, not
-- smuggled in here. For now the flag is a reporting column only.
-- ---------------------------------------------------------------------------
alter table public.leads
  add column if not exists quality_flag text
    check (quality_flag is null or quality_flag in ('suspect', 'dead'));

-- ---------------------------------------------------------------------------
-- 3 — The claims table
-- ---------------------------------------------------------------------------
create table if not exists public.lead_quality_claims (
  id                  uuid primary key default gen_random_uuid(),
  -- One claim per assignment. The unique constraint IS the idempotency guard:
  -- a duplicate submit collides on 23505 rather than double-refunding.
  lead_assignment_id  uuid not null unique
                        references public.lead_assignments(id) on delete cascade,
  lead_id             uuid not null references public.leads(id) on delete cascade,
  customer_id         uuid not null references public.customers(id) on delete cascade,

  reason              text not null
    check (reason in ('already_with_operator', 'no_longer_interested', 'unreachable')),
  -- What the landlord actually said. This is the whole basis for tracing a dead
  -- lead back to its source, so it is NOT NULL and length-checked in the RPC.
  detail              text not null,
  contacted_on        date,

  status              text not null
    check (status in ('auto_upheld', 'under_review', 'upheld', 'declined')),
  -- 'none' until an upheld claim settles. There is no 'replacement' value:
  -- §39.1 is explicit that a release is not a lead-for-lead swap and there is no
  -- synchronous re-offer, and this follows that precedent exactly. The credit
  -- goes back and ordinary routing (§4) delivers the next lead.
  resolution          text not null default 'none'
    check (resolution in ('none', 'credit')),

  corroboration       text not null default 'none'
    check (corroboration in ('none', 'peer_agrees', 'peer_contradicts')),
  -- False when a peer's own upheld claim corroborated this one: agreeing with a
  -- settled claim is free, so telling the truth costs an operator less than
  -- fishing does.
  allowance_consumed  boolean not null default false,

  reviewed_by         uuid references auth.users(id),
  reviewed_at         timestamptz,
  review_note         text,
  created_at          timestamptz not null default now()
);

create index if not exists idx_quality_claims_review
  on public.lead_quality_claims (created_at desc)
  where status = 'under_review';

create index if not exists idx_quality_claims_customer
  on public.lead_quality_claims (customer_id, created_at desc);

create index if not exists idx_quality_claims_lead
  on public.lead_quality_claims (lead_id);

-- RLS on with no policies: service role only, through server routes.
-- Invariant 7 — all privileged writes go through server routes.
alter table public.lead_quality_claims enable row level security;

alter table public.lead_assignments
  add column if not exists quality_claim_id uuid
    references public.lead_quality_claims(id) on delete set null;

-- ---------------------------------------------------------------------------
-- 4 — claimable_dead_lead_assignments
--
-- The mirror of releasable_filter_assignments (0114). Where that one demands
-- the lead be untouched, this one demands it was WORKED — and every clause is
-- load-bearing in the same way.
--
-- p_window_days is passed rather than baked in so the policy module and this
-- function cannot disagree about the claim window.
-- ---------------------------------------------------------------------------
create or replace function public.claimable_dead_lead_assignments(
  p_customer_id  uuid,
  p_window_days  integer default 14
)
returns table (
  assignment_id uuid,
  lead_id       uuid,
  assigned_at   timestamptz,
  price_paid    numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select la.id, la.lead_id, la.assigned_at, la.price_paid
  from public.lead_assignments la
  where la.customer_id = p_customer_id

    -- Timely. A lead reported three months on cannot be traced to a source and
    -- the landlord's state then is unknowable now.
    and la.assigned_at >= now() - make_interval(days => greatest(p_window_days, 1))

    -- One claim per assignment, ever.
    and la.quality_claim_id is null

    -- ⚠️ WORKED. The inverse of 0114's untouched predicate, and the reason this
    -- refund is an admission the lead was void rather than a refund on
    -- worked-for value the operator simply disliked.
    --
    -- Operator-generated telemetry ONLY. nudge_sent is excluded for the reason
    -- CLAUDE.md §3 gives — it is something WE did to the operator, and counting
    -- it would let our own nudges qualify the least engaged customers.
    and exists (
      select 1 from public.lead_events e
      where e.assignment_id = la.id
        and e.event_type in ('detail_opened', 'tel_click', 'mailto_click', 'whatsapp_click')
    )

    -- A lead already settled as won cannot also have been dead on arrival.
    and la.status <> 'won'

    -- §19.6 and invariant 11: a pool claim is a lead the operator chose to take
    -- knowing its age, and it never reopens its slot. It is not sold supply.
    and la.claimed_from_pool_at is null
$$;

-- ---------------------------------------------------------------------------
-- 5 — uphold_dead_lead_claim: the effects of an upheld claim, in one place
--
-- Called by both apply_dead_lead_claim (auto) and resolve_dead_lead_claim
-- (admin), so the two can never drift.
--
-- ⚠️ Does NOT decrement leads.assignment_count. §19.6 sets the precedent:
-- discard_lead_assignment stamps pool_expired_at rather than decrementing so a
-- claimed lead never reopens its slot. Same reasoning — a lead one operator has
-- shown to be dead is the last lead that should be sold to another.
-- ---------------------------------------------------------------------------
create or replace function public.uphold_dead_lead_claim(p_claim_id uuid)
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

  -- Invariant 6: both products, never a management-only column to gate GR.
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

  update public.lead_quality_claims
    set resolution = 'credit'
    where id = p_claim_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6 — apply_dead_lead_claim
--
-- The DECISION is made in TypeScript (src/lib/quality/deadLeadPolicy.ts) so the
-- allowance arithmetic and the corroboration rules can be unit-tested directly
-- rather than through a route. This commits it, and re-asserts eligibility here
-- so route and function cannot disagree — the same discipline §5E imposes on
-- reject_lead_assignment.
--
-- p_decision is 'auto_uphold' or 'review'. An ineligible claim never reaches
-- this function; the route answers it without writing anything, so the operator
-- can claim properly once they have actually worked the lead.
-- ---------------------------------------------------------------------------
create or replace function public.apply_dead_lead_claim(
  p_assignment_id      uuid,
  p_customer_id        uuid,
  p_reason             text,
  p_detail             text,
  p_contacted_on       date,
  p_decision           text,
  p_consumes_allowance boolean,
  p_corroboration      text,
  p_window_days        integer default 14
)
returns table (claim_id uuid, claim_status text, upheld boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead_id  uuid;
  v_upheld   boolean;
  v_status   text;
  v_claim_id uuid;
begin
  if p_decision not in ('auto_uphold', 'review') then
    raise exception 'Unknown decision %', p_decision;
  end if;

  if length(coalesce(btrim(p_detail), '')) < 20 then
    raise exception 'A dead-lead claim needs the landlord''s own words';
  end if;

  -- Eligibility re-asserted here, not merely trusted from the caller.
  select c.lead_id into v_lead_id
    from public.claimable_dead_lead_assignments(p_customer_id, p_window_days) c
    where c.assignment_id = p_assignment_id;

  if v_lead_id is null then
    raise exception 'Assignment % is not claimable by customer %',
      p_assignment_id, p_customer_id;
  end if;

  -- Lock the assignment for the rest of the transaction, so two submits cannot
  -- both pass the check above.
  perform 1 from public.lead_assignments
    where id = p_assignment_id and customer_id = p_customer_id
    for update;

  v_upheld := p_decision = 'auto_uphold';
  v_status := case when v_upheld then 'auto_upheld' else 'under_review' end;

  insert into public.lead_quality_claims (
    lead_assignment_id, lead_id, customer_id, reason, detail,
    contacted_on, status, corroboration, allowance_consumed
  ) values (
    p_assignment_id, v_lead_id, p_customer_id, p_reason, btrim(p_detail),
    p_contacted_on, v_status, coalesce(p_corroboration, 'none'),
    v_upheld and coalesce(p_consumes_allowance, false)
  )
  returning id into v_claim_id;

  update public.lead_assignments
    set quality_claim_id = v_claim_id
    where id = p_assignment_id;

  if v_upheld then
    perform public.uphold_dead_lead_claim(v_claim_id);
  end if;

  return query select v_claim_id, v_status, v_upheld;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7 — resolve_dead_lead_claim: the admin decision
--
-- Returns false rather than raising when the claim is already settled, so a
-- double-click in admin cannot refund twice.
-- ---------------------------------------------------------------------------
create or replace function public.resolve_dead_lead_claim(
  p_claim_id           uuid,
  p_upheld             boolean,
  p_reviewer           uuid,
  p_review_note        text,
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
    perform public.uphold_dead_lead_claim(p_claim_id);
  end if;

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8 — flag_lead_dead_if_unanimous
--
-- 'dead' only when every assigned operator has an upheld claim. Reporting only
-- for now; see the note on the column above.
-- ---------------------------------------------------------------------------
create or replace function public.flag_lead_dead_if_unanimous(p_lead_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total integer;
  v_dead  integer;
  v_flag  text;
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

-- ---------------------------------------------------------------------------
-- 9 — reset_monthly_counts
--
-- 0018's body carried forward verbatim, with quality_claims_this_cycle added to
-- the MANAGEMENT branch so the allowance resets on the customer's own billing
-- anchor day rather than the calendar 1st. One budget spans both products,
-- because the allowance bounds a customer's claiming behaviour rather than a
-- product's economics.
-- ---------------------------------------------------------------------------
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
  -- Management counter — unchanged from 0014.
  update public.customers
    set leads_received_this_month = 0,
        quality_claims_this_cycle = 0,
        updated_at = now()
    where
      extract(day from coalesce(billing_cycle_anchor, created_at::date)) = v_dom
      or (v_dom = v_last_dom
          and extract(day from coalesce(billing_cycle_anchor, created_at::date)) > v_last_dom);

  -- GR counter — same anchor-day logic on the GR billing anchor.
  update public.customers
    set gr_leads_received_this_month = 0
    where
      extract(day from coalesce(gr_billing_cycle_anchor, created_at::date)) = v_dom
      or (v_dom = v_last_dom
          and extract(day from coalesce(gr_billing_cycle_anchor, created_at::date)) > v_last_dom);
end;
$$;

-- ---------------------------------------------------------------------------
-- 10 — Grants. Invariant 7: service role only.
-- ---------------------------------------------------------------------------
revoke execute on function public.claimable_dead_lead_assignments(uuid, integer)
  from public, anon, authenticated;
revoke execute on function public.uphold_dead_lead_claim(uuid)
  from public, anon, authenticated;
revoke execute on function public.apply_dead_lead_claim(uuid, uuid, text, text, date, text, boolean, text, integer)
  from public, anon, authenticated;
revoke execute on function public.resolve_dead_lead_claim(uuid, boolean, uuid, text, boolean)
  from public, anon, authenticated;
revoke execute on function public.flag_lead_dead_if_unanimous(uuid)
  from public, anon, authenticated;

grant execute on function public.claimable_dead_lead_assignments(uuid, integer) to service_role;
grant execute on function public.uphold_dead_lead_claim(uuid) to service_role;
grant execute on function public.apply_dead_lead_claim(uuid, uuid, text, text, date, text, boolean, text, integer) to service_role;
grant execute on function public.resolve_dead_lead_claim(uuid, boolean, uuid, text, boolean) to service_role;
grant execute on function public.flag_lead_dead_if_unanimous(uuid) to service_role;
