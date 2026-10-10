-- ============================================================================
-- 0170 — Batch 04 Phase 4: top-ups for Lead Brief customers
--
-- docs/build/04-area-changes-pause-topups.md (Phase 4) and the approved Phase 0
-- report, docs/build/04-phase0-report.md (§2, C3, C7). Lead Brief customers
-- only. Every other customer's top-up is exactly what it was.
--
-- Locked decision 6: a top-up costs credits and follows rollover. It delivers
-- from the closest matching outcodes BEYOND the service area, nearest first,
-- never beyond the plan maximum distance (40 or 75 miles), and it never adds
-- supply inside the area.
--
-- What it adds:
--
--   1. customers.brief_topup_credits: how many of a brief customer's credits
--      came from a top-up and are kept for leads beyond the service area. Part
--      of lead_balance, never on top of it. Zero for everyone else.
--   2. record_lead_topup_success: a Lead Brief customer's Management top-up
--      also adds to brief_topup_credits (0153's body plus that one line).
--   3. get_brief_candidates_for_lead: the in-area pool spends plan credits
--      only (0163's body with the balance test changed), so a top-up never
--      adds a lead inside the area.
--   4. get_brief_topup_candidates_for_lead: who may take a lead on a top-up
--      credit. Everything the in-area pool tests, except that the lead must be
--      OUTSIDE the service area and a top-up credit must be left.
--   5. assign_brief_topup_lead: assign_lead_to_customer, unchanged and called
--      first, then one top-up credit spent in the same transaction. Refused,
--      and the whole assignment rolled back, when no top-up credit is left or
--      the lead is inside the customer's service area.
--
-- ⚠️ THE DISTANCE IS DECIDED IN TYPESCRIPT, NOT HERE. The database holds no
-- outcode centroids, so "beyond the service area" is checked here and "within
-- the plan maximum, nearest first" by the morning release's top-up pass
-- (src/lib/leadBrief/topup.ts), the way the pace pass orders pace_outcodes.
--
-- ⚠️ C7, decided in the build: the reach is the plan maximum (40 or 75 miles
-- from the base), as locked decision 6 says, NOT the customer's travel limit
-- the pace ring stops at. Nearest first means leads inside the travel limit
-- still come first.
--
-- ⚠️ A CREDIT SPENT ELSEWHERE COMES OUT OF THE PLAN SHARE FIRST. An admin
-- assign, a pool claim or anything else that spends lead_balance leaves
-- brief_topup_credits alone, so the in-area test (lead_balance >
-- brief_topup_credits) closes before the top-up does. The top-up pool reads
-- least(brief_topup_credits, lead_balance), so it can never spend a credit
-- that is not there.
--
-- ⚠️ assign_lead_to_customer IS NOT CHANGED (Phase 4: "Do not change the body
-- of assign_lead_to_customer"). The wrapper calls it before touching the
-- customer row, so the lock order stays lead, then customer (§53.6).
--
-- ⚠️ NO SEMICOLONS IN COMMENTS INSIDE A FUNCTION BODY. The Supabase apply tool
-- splits on every semicolon, comments included, and holds a fragment that
-- reads as an UPDATE with no WHERE for a confirmation nobody can give (0169).
--
-- Function-overlap check: no other migration or open branch creates or
-- replaces any of the four functions below. promote_lead_brief, 0164 and 0169
-- are untouched.
--
-- Inert on apply: the new column defaults to 0 for every customer, no
-- briefs exist, and get_brief_candidates_for_lead answers exactly as before
-- for any customer with no top-up credits.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The top-up share of a brief customer's credits
-- ---------------------------------------------------------------------------
alter table public.customers
  add column if not exists brief_topup_credits integer not null default 0
    constraint customers_brief_topup_credits_nonneg check (brief_topup_credits >= 0);

comment on column public.customers.brief_topup_credits is
  'Batch 04 Phase 4 (0170). How many of a Lead Brief customer''s lead_balance credits came from a top-up and are kept for leads beyond the service area. Part of lead_balance, never added to it. Raised by record_lead_topup_success for a brief customer and spent only by assign_brief_topup_lead. Zero for every other customer.';

-- ---------------------------------------------------------------------------
-- 2. Crediting a top-up
-- ---------------------------------------------------------------------------
create or replace function public.record_lead_topup_success(
  p_token_id uuid,
  p_payment_intent_id text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tok public.lead_topup_tokens%rowtype;
  v_payment_id uuid;
begin
  select * into v_tok
    from public.lead_topup_tokens
    where id = p_token_id
    for update;

  if not found then return false; end if;
  -- Only an already-PAID token is a replay. A 'failed' token is promoted, so a
  -- charge that actually succeeded can still be credited after the fact.
  if v_tok.charge_status = 'paid' then return false; end if;

  insert into public.payments (
    customer_id, stripe_payment_intent_id, amount_pence, credits_added,
    payment_type, status, lead_type
  ) values (
    v_tok.customer_id, p_payment_intent_id, v_tok.amount_pence, v_tok.credits,
    'topup', 'paid', v_tok.lead_type
  )
  returning id into v_payment_id;

  if v_tok.lead_type = 'guaranteed_rent' then
    update public.customers
      set gr_lead_balance = gr_lead_balance + v_tok.credits,
          -- 0153 (§61): a top-up banks its share of replacements at once.
          replacement_balance = replacement_balance
            + greatest(round(v_tok.credits * coalesce(quality_allowance_pct, 0.10))::integer, 0),
          updated_at = now()
      where id = v_tok.customer_id;
  else
    update public.customers
      set lead_balance = lead_balance + v_tok.credits,
          -- 0153 (§61): a top-up banks its share of replacements at once.
          replacement_balance = replacement_balance
            + greatest(round(v_tok.credits * coalesce(quality_allowance_pct, 0.10))::integer, 0),
          -- 0170 (batch 04 Phase 4): a Lead Brief customer's top-up credits
          -- are kept for leads beyond their service area. Every other
          -- customer's top-up is exactly what it was.
          brief_topup_credits = brief_topup_credits
            + case when coalesce(lead_brief_required, false) then v_tok.credits else 0 end,
          updated_at = now()
      where id = v_tok.customer_id;
  end if;

  update public.lead_topup_tokens
    set charge_status = 'paid',
        payment_id = v_payment_id,
        used_at = coalesce(used_at, now())
    where id = v_tok.id;

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. The in-area pool: plan credits only
-- ---------------------------------------------------------------------------
create or replace function public.get_brief_candidates_for_lead(
  p_lead_id uuid,
  p_max integer,
  p_include_pace boolean
)
returns table (
  customer_id        uuid,
  brief_id           uuid,
  deficit            numeric,
  last_assignment_at timestamptz,
  in_service         boolean,
  in_first_pick      boolean,
  pace_only          boolean,
  allocation         integer,
  travel_limit_miles integer,
  base_outcode       text,
  priority_outcodes  text[],
  similar_areas      text[],
  priorities         jsonb
)
language sql
security definer
set search_path = public
as $$
  with l as (
    select
      id,
      lead_type,
      outcode,
      nullif(substring(coalesce(bedrooms, '') from '\d+'), '')::int as bed,
      gross_annual_income as gross,
      created_at,
      owner_customer_id
    from public.leads
    where id = p_lead_id
  ),
  pace_pct as (
    -- A malformed setting reads as the shipped 20, never as an error.
    select coalesce(
      (select case when trim(value) ~ '^[0-9]+(\.[0-9]+)?$' then trim(value)::numeric end
         from public.system_settings
        where key = 'lead_brief_pace_deficit_pct'),
      20
    ) as pct
  ),
  cand as (
    select
      c.id as customer_id,
      b.id as brief_id,
      -- The management deficit, exactly as the legacy pools compute it.
      round(
        (least(greatest(
          extract(day from now() - coalesce(c.billing_cycle_anchor, c.created_at::date)),
          0), 30) / 30.0)
        * public.effective_allocation(c.monthly_allocation, c.pool_debit)
      ) - c.leads_received_this_month as deficit,
      c.last_assignment_at,
      c.created_at as customer_created_at,
      c.monthly_allocation,
      l.outcode = any (b.service_outcodes) as in_service,
      l.outcode = any (b.first_pick_outcodes) as in_first_pick,
      l.outcode = any (b.pace_outcodes) as in_pace,
      b.allocation,
      b.travel_limit_miles,
      b.base_outcode,
      b.priority_outcodes,
      b.similar_areas,
      b.priorities
    from public.customers c
    join public.customer_lead_briefs b
      on b.customer_id = c.id and b.status = 'active'
    cross join l
    where not public.lead_retired_from_allocation(p_lead_id)
      and l.lead_type = 'management'
      and l.outcode is not null
      and c.is_active = true
      and c.account_status = 'active'
      and c.subscription_status = 'active'
      -- Batch 04 Phase 4: plan credits only. Top-up credits (0170) are kept
      -- for leads beyond the service area and are never spent inside it
      -- (locked decision 6). Zero for every customer who is not on a brief.
      and c.lead_balance > c.brief_topup_credits
      and c.paused_at is null
      and c.lead_brief_required
      and c.lead_brief_completed_at is not null
      and not exists (
        select 1 from public.lead_assignments la
        where la.lead_id = p_lead_id and la.customer_id = c.id
      )
      and c.id is distinct from l.owner_customer_id
      -- Essentials: the only hard exclusions besides the area (locked
      -- decision 6). No figure means not met — never a promise on a guess.
      and (b.min_bedrooms is null or (l.bed is not null and l.bed >= b.min_bedrooms))
      and (b.min_gross is null or (l.gross is not null and l.gross >= b.min_gross))
      -- 0148/0154: the release curve and daily cap apply exactly as to everyone.
      and public.customer_release_allows(c.id, 'management', l.created_at)
  )
  select
    cand.customer_id,
    cand.brief_id,
    cand.deficit,
    cand.last_assignment_at,
    cand.in_service,
    cand.in_first_pick,
    not (cand.in_service or cand.in_first_pick) as pace_only,
    cand.allocation,
    cand.travel_limit_miles,
    cand.base_outcode,
    cand.priority_outcodes,
    cand.similar_areas,
    cand.priorities
  from cand, pace_pct
  where cand.in_service
     or cand.in_first_pick
     or (
       p_include_pace
       and cand.in_pace
       and cand.deficit >= ceil(cand.monthly_allocation * pace_pct.pct / 100.0)
     )
  order by
    not (cand.in_service or cand.in_first_pick) asc,
    cand.deficit desc,
    cand.last_assignment_at asc nulls first,
    cand.customer_created_at asc
  limit greatest(p_max, 0);
$$;

-- ---------------------------------------------------------------------------
-- 4. Who may take a lead on a top-up credit
-- ---------------------------------------------------------------------------
-- The same tests as the in-area pool (0163), except:
--   - the lead must be OUTSIDE the active brief's service area (first picks
--     and the pace ring count as outside),
--   - a top-up credit must be left, and only as many as lead_balance holds,
--   - no pace test. A top-up is paid for, not a catch-up.
-- The release curve and the daily cap (0148/0154) apply exactly as to any
-- routed lead. The caller decides the distance and the order.
create or replace function public.get_brief_topup_candidates_for_lead(
  p_lead_id uuid,
  p_max integer
)
returns table (
  customer_id       uuid,
  brief_id          uuid,
  topup_credits     integer,
  allocation        integer,
  base_outcode      text,
  priority_outcodes text[]
)
language sql
security definer
set search_path = public
as $$
  with l as (
    select
      id,
      lead_type,
      outcode,
      nullif(substring(coalesce(bedrooms, '') from '\d+'), '')::int as bed,
      gross_annual_income as gross,
      created_at,
      owner_customer_id
    from public.leads
    where id = p_lead_id
  )
  select
    c.id as customer_id,
    b.id as brief_id,
    least(c.brief_topup_credits, c.lead_balance) as topup_credits,
    b.allocation,
    b.base_outcode,
    b.priority_outcodes
  from public.customers c
  join public.customer_lead_briefs b
    on b.customer_id = c.id and b.status = 'active'
  cross join l
  where not public.lead_retired_from_allocation(p_lead_id)
    and l.lead_type = 'management'
    and l.outcode is not null
    and c.is_active = true
    and c.account_status = 'active'
    and c.subscription_status = 'active'
    and c.brief_topup_credits > 0
    and c.lead_balance > 0
    and c.paused_at is null
    and c.lead_brief_required
    and c.lead_brief_completed_at is not null
    -- Never inside the area (locked decision 6).
    and not (l.outcode = any (coalesce(b.service_outcodes, '{}'::text[])))
    and not exists (
      select 1 from public.lead_assignments la
      where la.lead_id = p_lead_id and la.customer_id = c.id
    )
    and c.id is distinct from l.owner_customer_id
    -- The essentials, exactly as the in-area pool reads them.
    and (b.min_bedrooms is null or (l.bed is not null and l.bed >= b.min_bedrooms))
    and (b.min_gross is null or (l.gross is not null and l.gross >= b.min_gross))
    and public.customer_release_allows(c.id, 'management', l.created_at)
  order by
    c.last_assignment_at asc nulls first,
    c.created_at asc
  limit greatest(p_max, 0);
$$;

-- ---------------------------------------------------------------------------
-- 5. Spending a top-up credit
-- ---------------------------------------------------------------------------
-- assign_lead_to_customer does everything it always does (locks, capacity,
-- balance, the monthly counters, one credit off lead_balance). This then takes
-- one off brief_topup_credits in the same transaction, so the two can never
-- disagree. Any refusal raises, which rolls the assignment back with it.
create or replace function public.assign_brief_topup_lead(
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
  v_assignment_id uuid;
  v_outcode text;
  v_left integer;
begin
  -- First, so the lock order is the lead then the customer, as everywhere else.
  v_assignment_id := public.assign_lead_to_customer(
    p_lead_id, p_customer_id, p_price, 'management'::public.lead_type
  );

  -- Never inside the area, checked again under the lead lock just taken.
  select l.outcode into v_outcode from public.leads l where l.id = p_lead_id;
  if v_outcode is null or not exists (
    select 1
      from public.customer_lead_briefs b
     where b.customer_id = p_customer_id
       and b.status = 'active'
       and not (v_outcode = any (coalesce(b.service_outcodes, '{}'::text[])))
  ) then
    raise exception 'assign_brief_topup_lead: lead % is not beyond the service area of customer %',
      p_lead_id, p_customer_id;
  end if;

  update public.customers
     set brief_topup_credits = brief_topup_credits - 1,
         updated_at = now()
   where id = p_customer_id
     and brief_topup_credits > 0
  returning brief_topup_credits into v_left;
  if v_left is null then
    raise exception 'assign_brief_topup_lead: customer % has no top-up credit left', p_customer_id;
  end if;

  return v_assignment_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Service role only (the replaced functions keep their grants, re-asserted)
-- ---------------------------------------------------------------------------
revoke execute on function public.record_lead_topup_success(uuid, text)
  from public, anon, authenticated;
grant execute on function public.record_lead_topup_success(uuid, text) to service_role;

revoke execute on function public.get_brief_candidates_for_lead(uuid, integer, boolean)
  from public, anon, authenticated;
grant execute on function public.get_brief_candidates_for_lead(uuid, integer, boolean) to service_role;

revoke execute on function public.get_brief_topup_candidates_for_lead(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.get_brief_topup_candidates_for_lead(uuid, integer) to service_role;

revoke execute on function public.assign_brief_topup_lead(uuid, uuid, numeric)
  from public, anon, authenticated;
grant execute on function public.assign_brief_topup_lead(uuid, uuid, numeric) to service_role;
