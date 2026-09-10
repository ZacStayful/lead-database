-- ============================================================================
-- Lead quality claims, outcome capture and distribution changes.
--
-- Problem: customers receive leads where the landlord has already appointed
-- another operator, or has gone off the idea. The reject flow from 0019/0021
-- has no reason that fits — 'not_a_fit' is chargeable by design and
-- 'invalid_contact' only refunds because Twilio/ZeroBounce can verify it. A
-- dead lead has no external verifier, so opening a refund path invites lead
-- fishing: rejecting workable leads to keep drawing fresh ones.
--
-- The anti-fishing mechanism is a HIDDEN, EARNED allowance rather than a
-- policy check. Each customer has a per-cycle budget of upheld claims equal to
-- a share of their plan plus credits earned by taking leads WITHOUT claiming.
-- Claiming resets the earned streak, so a fisher's budget shrinks exactly as
-- they spend it. Claims beyond the budget are never silently declined — they
-- go to admin review. None of the numbers are ever shown to the customer.
--
-- Two distribution rules change with it:
--
--   * leads.max_assignments defaults to 3 (was 2).
--   * A slot vacated by a rejection is NEVER resold. apply_quality_claim does
--     not decrement leads.assignment_count, so a lead one operator claims dead
--     stays with the operators who kept it, and the backfill job can still tell
--     a rejected slot from one that was never filled. apply_lead_rejection is
--     redefined to match: the invalid_contact path previously reopened the slot
--     and the route handed a lead with a VERIFIED-BAD phone or email to another
--     operator, which manufactured the next complaint.
--
-- The claimant is made whole with a different lead (find_replacement_lead) or,
-- when the pool has nothing, with a credit that flows through normal pacing.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Customer-level allowance state
-- ---------------------------------------------------------------------------
alter table public.customers
  add column if not exists quality_allowance_pct numeric not null default 0.10;

alter table public.customers
  add column if not exists quality_claims_this_cycle integer not null default 0;

-- Chargeable leads received since the last upheld claim. Drives the earned
-- portion of the allowance; reset to 0 whenever a claim is upheld.
alter table public.customers
  add column if not exists clean_leads_streak integer not null default 0;

-- Admin kill-switch: route every claim from this customer to manual review.
alter table public.customers
  add column if not exists quality_review_required boolean not null default false;

-- Optional, admin-set criteria used ONLY to pick replacement leads. There is no
-- customer-facing targeting system; this is deliberately narrow.
--   { "cities": ["Leeds","York"], "min_bedrooms": 2 }
alter table public.customers
  add column if not exists replacement_filter jsonb;

-- ---------------------------------------------------------------------------
-- 2. Lead-level quality flag + the move to three operators per lead
-- ---------------------------------------------------------------------------
alter table public.leads
  add column if not exists quality_flag text
    check (quality_flag in ('suspect', 'dead'));

-- Only NEW leads pick this up; existing rows keep whatever they were given.
alter table public.leads
  alter column max_assignments set default 3;

create index if not exists idx_leads_open_slots
  on public.leads (created_at)
  where quality_flag is null;

-- ---------------------------------------------------------------------------
-- 3. The claims table
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 4. Assignment columns
-- ---------------------------------------------------------------------------
alter table public.lead_assignments
  add column if not exists rejected_at timestamptz;

alter table public.lead_assignments
  add column if not exists quality_claim_id uuid
    references public.lead_quality_claims(id) on delete set null;

-- Widen rejection_reason for the three dead-lead reasons.
alter table public.lead_assignments
  drop constraint if exists lead_assignments_rejection_reason_check;
alter table public.lead_assignments
  add constraint lead_assignments_rejection_reason_check
  check (rejection_reason is null or rejection_reason in (
    'not_a_fit',
    'invalid_contact',
    'already_with_operator',
    'no_longer_interested',
    'unreachable'
  ));

-- Widen status. 'no_answer' and 'gone_elsewhere' make the outcome axis complete
-- so the inline survey has somewhere to land; 'won'/'in_discussion' already
-- existed in the constraint but were unreachable through the API.
alter table public.lead_assignments
  drop constraint if exists lead_assignments_status_check;
alter table public.lead_assignments
  add constraint lead_assignments_status_check
  check (status in (
    'new',
    'contacted',
    'no_answer',
    'in_discussion',
    'gone_elsewhere',
    'won',
    'not_relevant',
    'rejected'
  ));

-- ---------------------------------------------------------------------------
-- 5. Cycle-end quality survey
-- ---------------------------------------------------------------------------
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

-- RLS on with no policies, matching system_settings (0007): these tables are
-- only ever read or written by the service role through server routes.
alter table public.lead_quality_claims   enable row level security;
alter table public.cycle_quality_surveys enable row level security;

-- ---------------------------------------------------------------------------
-- 6. reset_monthly_counts — also zero the per-cycle claim counter.
--
-- Carries 0018 forward verbatim and adds quality_claims_this_cycle to the
-- MANAGEMENT branch, so the allowance resets on the customer's own billing
-- anchor day rather than the calendar 1st.
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

-- ---------------------------------------------------------------------------
-- 7. assign_lead_to_customer — refuse dead leads, grow the clean streak.
--
-- Carries the 0015 body forward with two additions:
--   * a lead flagged 'dead' is never assigned to anyone again
--   * clean_leads_streak increments alongside the existing counters, which is
--     what earns a customer extra allowance for taking leads without claiming
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 8. apply_lead_rejection — stop reopening the slot.
--
-- Identical to 0025 except that p_restore no longer decrements
-- leads.assignment_count. A lead whose phone AND email failed verification is
-- the LAST lead that should be passed to another operator; the route now hands
-- the claimant a different lead through find_replacement_lead instead. Also
-- stamps rejected_at, which never had a column before 0027 (rejection time was
-- only recoverable from contact_validation_result->>'checkedAt').
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 9. uphold_quality_claim — the effects of an upheld claim, in one place.
--
-- Called both by apply_quality_claim (auto-upheld) and by the admin review path
-- (resolve_quality_claim), so the two can never drift apart. Restores one
-- credit on the right product, rolls back the monthly counter, spends allowance
-- if this claim consumes it, resets the clean streak and marks the assignment
-- rejected. Never touches leads.assignment_count.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 10. apply_quality_claim — atomic claim capture.
--
-- The decision itself is made in TypeScript (src/lib/quality/claimPolicy.ts) so
-- it can be unit-tested in isolation; this function commits it. Outcomes:
--
--   'ineligible'  -> store the report as feedback ONLY. The assignment is left
--                    completely untouched so the customer can claim again once
--                    they have actually worked the lead.
--   'review'      -> record the claim and stamp the assignment's rejection
--                    reason (so it cannot be claimed twice), but leave the
--                    status alone until a human adjudicates.
--   'auto_uphold' -> as review, plus the full uphold effects.
--
-- Idempotency mirrors apply_lead_rejection: the row is locked FOR UPDATE and a
-- non-null rejection_reason means someone got here first.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 11. resolve_quality_claim — the admin review decision.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 12. flag_lead_dead_if_unanimous — write off a lead only when everyone agrees.
--
-- One agreeing pair is not enough when a lead sits with three operators: the
-- third may still be working it. Flags 'dead' only once every assignment on the
-- lead carries an upheld dead-lead claim, and 'suspect' as soon as one does.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 13. find_replacement_lead — a DIFFERENT lead to make the claimant whole.
--
-- Draws from the pool of leads that still have an open slot, freshest first.
-- Never returns a lead the customer already holds, and never a flagged one.
-- p_filter is the optional admin-set replacement_filter; a null filter matches
-- everything. Bedrooms is stored as free text, so the numeric comparison digs
-- the digits out and simply ignores rows it cannot parse.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 14. leads_with_open_slots — the backfill job's work queue.
--
-- Oldest first, because stale inventory is what produces "they already went
-- with someone else". Only leads that still have room and are not flagged.
-- ---------------------------------------------------------------------------
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
-- 15. Lock down the new functions (0024's rule, restated for these signatures
-- in case the default privileges do not apply to the running role).
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
