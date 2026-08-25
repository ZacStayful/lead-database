-- ============================================================================
-- Customer-owned leads — the database becomes the customer's own workspace.
--
-- Until now every row in `leads` was OURS: sourced from Monday, sold to up to
-- max_assignments operators, escalated when ignored, and finally pooled. This
-- migration adds a second kind of lead — one a CUSTOMER brought with them, by
-- uploading a spreadsheet or typing it in — which lives in the same table, is
-- worked through the same assignment/notes/stages machinery, and is visible to
-- exactly one customer plus admin.
--
-- THE ONE RULE: an owned lead is never given to anybody else. Not by ordinary
-- routing, not by escalation, not by the pool, not by an admin force-assign.
--
-- That rule is enforced in the two functions the codebase already treats as the
-- single expression of "may this lead be handed out" (CLAUDE.md invariant 11):
--
--   lead_retired_from_allocation()  — asserted in all three candidate
--                                     functions, in get_escalation_candidates,
--                                     and inside assign_lead_to_customer under
--                                     its row lock.
--   lead_pool_barred()              — asserted by get_pool_entry_candidates and
--                                     the daily sweep.
--
-- One added branch in each therefore covers five call sites without touching
-- them. Two paths do NOT consult either helper and so get their own guard here:
-- admin_assign_lead (§5) and find_duplicate_lead (§6).
--
-- Deliberately NOT in this migration: the marketplace aggregates that measure
-- operators against each other (engagement scores and benchmarks, operator
-- proof, the scoreboard, service capacity). Those are reporting, they are large
-- function bodies, and rewriting eight of them beside the safety-critical work
-- above would put a transcription slip in a reporting CTE next to the code that
-- stops a lead being sold twice. They land in 0103; both apply before the code
-- deploys.
--
-- Nothing here touches a balance, counter, pacing or capacity column, and every
-- new filter matches nothing until code starts writing owned leads — so this
-- migration is inert on its own and cannot affect lead allocation.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1 — Ownership on `leads`.
--
-- owner_customer_id is the whole feature: null means a marketplace lead and
-- everything behaves exactly as it did. owner_source records how it arrived,
-- which admin wants and which the two columns must agree about — hence the
-- paired CHECK, so a half-owned row (an owner with no source, or a source with
-- no owner) cannot exist.
--
-- ON DELETE CASCADE: a customer's own leads are their data, not ours. Deleting
-- the customer takes them, rather than orphaning rows no one can see.
-- ---------------------------------------------------------------------------
alter table public.leads
  add column if not exists owner_customer_id uuid references public.customers(id) on delete cascade,
  add column if not exists owner_source      text;

alter table public.leads drop constraint if exists leads_owner_source_check;
alter table public.leads
  add constraint leads_owner_source_check
  check (owner_source is null or owner_source in ('import', 'manual'));

alter table public.leads drop constraint if exists leads_owner_pair_check;
alter table public.leads
  add constraint leads_owner_pair_check
  check ((owner_customer_id is null) = (owner_source is null));

create index if not exists idx_leads_owner_customer
  on public.leads (owner_customer_id)
  where owner_customer_id is not null;

comment on column public.leads.owner_customer_id is
  'The customer who added this lead themselves (import or manual entry). NULL '
  'for every marketplace lead. Non-null retires the lead from all allocation, '
  'escalation and pooling — see lead_retired_from_allocation and '
  'lead_pool_barred. Visibility falls out of the existing leads_select_assigned '
  'RLS policy via the owner''s own lead_assignments row.';

comment on column public.leads.owner_source is
  'How an owned lead arrived: import (spreadsheet) or manual (form). Always '
  'NULL exactly when owner_customer_id is NULL.';


-- ---------------------------------------------------------------------------
-- 2 — monday_item_id becomes optional.
--
-- It has been `text unique not null` since 0001 and is the ingest idempotency
-- key (invariant 5). An owned lead has no Monday item and never will, so the
-- NOT NULL has to go — but every row must still carry SOME identity, which the
-- replacement CHECK states: a lead is either Monday's or a customer's.
--
-- The UNIQUE constraint STAYS. Postgres allows unlimited NULLs in a unique
-- index, so idempotency on real Monday ids is completely unaffected.
-- ---------------------------------------------------------------------------
alter table public.leads alter column monday_item_id drop not null;

alter table public.leads drop constraint if exists leads_monday_or_owner_check;
alter table public.leads
  add constraint leads_monday_or_owner_check
  check (monday_item_id is not null or owner_customer_id is not null);


-- ---------------------------------------------------------------------------
-- 3 — lead_pool_barred honours ownership.
--
-- Definition verbatim from 0076 with owner_customer_id added to the final
-- clause, alongside withdrawn_at / pool_expired_at / pool_excluded_at — the
-- "out of the pool by decision, not by measurement" cases. An owned lead has
-- never been sold to anybody, so there is nothing to recycle and nobody to
-- offer it to; putting one in the pool would hand a customer's private contact
-- to every subscriber of that product.
-- ---------------------------------------------------------------------------
create or replace function public.lead_pool_barred(p_lead_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    exists (
      select 1 from public.lead_notes n
      join public.lead_assignments la on la.id = n.lead_assignment_id
      where la.lead_id = p_lead_id
    )
    or exists (
      select 1 from public.lead_assignments la
      where la.lead_id = p_lead_id and la.status in ('in_discussion', 'won')
    )
    or exists (
      select 1 from public.lead_assignments la
      where la.lead_id = p_lead_id and la.closed_at is not null
    )
    or exists (
      select 1 from public.lead_assignments la
      where la.lead_id = p_lead_id
        and (
          (la.due_to_call_date is not null and la.due_to_call_date_set_at is null)
          or (la.income_estimate is not null and la.income_estimate_set_at is null)
        )
    )
    or exists (
      select 1 from public.leads l
      where l.id = p_lead_id
        and (
          l.withdrawn_at is not null
          or l.pool_expired_at is not null
          or l.pool_excluded_at is not null
          or l.owner_customer_id is not null
        )
    );
$$;

revoke execute on function public.lead_pool_barred(uuid) from public, anon, authenticated;
grant execute on function public.lead_pool_barred(uuid) to service_role;


-- ---------------------------------------------------------------------------
-- 4 — lead_retired_from_allocation honours ownership.
--
-- Definition verbatim from 0073 with the owner branch added to the existing
-- `leads` EXISTS. This is the single edit that keeps owned leads out of:
--
--   get_filtered_candidates_for_lead / get_unfiltered_candidates_for_lead /
--   get_next_customers_for_lead   (they assert it per candidate)
--   get_escalation_candidates     (0073 — so neither rung ever fires)
--   assign_lead_to_customer       (under the row lock, so even a direct call
--                                  by some future caller cannot place one)
--
-- Note the asymmetry with §1 of 0073: a lead pooled 'unassigned' is
-- deliberately NOT retired because it is still live stock. An owned lead is the
-- opposite case — it was never stock at all.
-- ---------------------------------------------------------------------------
create or replace function public.lead_retired_from_allocation(p_lead_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    exists (
      select 1 from public.lead_assignments la
      where la.lead_id = p_lead_id
        and la.claimed_from_pool_at is not null
    )
    or exists (
      select 1 from public.leads l
      where l.id = p_lead_id
        and (
          l.pool_expired_at is not null
          or (l.pool_entered_at is not null and l.pool_entry_basis = 'ignored')
          or l.owner_customer_id is not null
        )
    );
$$;

revoke execute on function public.lead_retired_from_allocation(uuid) from public, anon, authenticated;
grant execute on function public.lead_retired_from_allocation(uuid) to service_role;


-- ---------------------------------------------------------------------------
-- 5 — admin_assign_lead refuses an owned lead.
--
-- Definition verbatim from 0053 plus one guard. This function consults NEITHER
-- helper above — it checks the duplicate, the capacity and the pause, and then
-- assigns — so without this an admin could hand one customer's private lead to
-- another customer from the admin UI. The UI hides the control; this is what
-- makes it true.
--
-- Placed after the duplicate guard and before capacity, so the error names the
-- real reason rather than "at max assignments" (an owned lead is seeded 1/1 and
-- would otherwise trip the capacity check with a misleading message).
-- ---------------------------------------------------------------------------
create or replace function public.admin_assign_lead(
  p_lead_id uuid,
  p_customer_id uuid,
  p_price numeric,
  p_lead_type lead_type default 'management'::lead_type
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
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

  -- Same guard, same reason. An override may bypass the credit gate but it must
  -- not be able to give one customer the same lead twice.
  if exists (
    select 1 from public.lead_assignments
    where lead_id = p_lead_id and customer_id = p_customer_id
  ) then
    raise exception 'Customer already has this lead'
      using detail = format('customer=%s lead=%s', p_customer_id, p_lead_id);
  end if;

  -- A customer's own lead belongs to them. There is no override for this: it
  -- was never ours to sell, and handing it to a competitor is the one outcome
  -- the whole feature must make impossible.
  if v_lead.owner_customer_id is not null then
    raise exception 'Lead % was added by a customer and cannot be assigned to anyone else',
      p_lead_id
      using detail = format('owner=%s source=%s', v_lead.owner_customer_id, v_lead.owner_source);
  end if;

  -- Capacity still applies. Raise max_assignments to add more recipients.
  if v_lead.assignment_count >= v_lead.max_assignments then
    raise exception 'Lead % is at max assignments (%/%)',
      p_lead_id, v_lead.assignment_count, v_lead.max_assignments;
  end if;

  -- Pause is management-only and airtight: even an override must not place a
  -- management lead with a paused customer (mirrors 0039).
  if p_lead_type <> 'guaranteed_rent' and v_customer.paused_at is not null then
    raise exception 'Customer % is paused and cannot receive management leads', p_customer_id;
  end if;

  -- NB: no balance / subscription gate here — this is the admin override path.

  insert into public.lead_assignments (lead_id, customer_id, price_paid)
    values (p_lead_id, p_customer_id, p_price)
    returning id into v_assignment_id;

  update public.leads
    set assignment_count = assignment_count + 1
    where id = p_lead_id;

  -- Spend a credit only if one is available, so an override never goes negative.
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
          management_lifetime_leads_received =
            management_lifetime_leads_received + 1,
          last_assignment_at = now(),
          updated_at = now()
      where id = p_customer_id;
  end if;

  return v_assignment_id;
end;
$function$;

revoke all on function public.admin_assign_lead(uuid, uuid, numeric, lead_type) from public, anon, authenticated;
grant execute on function public.admin_assign_lead(uuid, uuid, numeric, lead_type) to service_role;


-- ---------------------------------------------------------------------------
-- 6 — find_duplicate_lead ignores owned leads. THE DANGEROUS ONE.
--
-- Definition verbatim from 0070 plus `owner_customer_id is null`.
--
-- This function matches a landlord across every lead of a product, and
-- ingestLead() treats a hit as "duplicate — skip". Without this filter, a
-- customer importing their own contact list would silently POISON INGEST: if
-- landlord X is in somebody's spreadsheet and X later enquires through Monday,
-- the real, sellable enquiry would be discarded as a duplicate of one
-- customer's private copy. Nobody would see an error; the lead simply would
-- never arrive, and the loss would be invisible on both sides.
--
-- The two populations must not see each other at all here. A customer's private
-- copy of a landlord says nothing about whether we may sell that landlord.
--
-- get_duplicate_leads() (the admin duplicate REPORT) is deliberately left
-- inclusive — a customer holding a private copy of a lead we also sell is worth
-- an admin being able to see.
-- ---------------------------------------------------------------------------
create or replace function public.find_duplicate_lead(
  p_name      text,
  p_email     text,
  p_phone     text,
  p_lead_type public.lead_type
)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select l.id
  from public.leads l
  where public.lead_identity_key(l.lead_name, l.email, l.phone)
        = public.lead_identity_key(p_name, p_email, p_phone)
    and public.lead_identity_key(p_name, p_email, p_phone) is not null
    and l.lead_type = p_lead_type
    and l.owner_customer_id is null
  order by l.created_at
  limit 1;
$$;

revoke execute on function public.find_duplicate_lead(text, text, text, public.lead_type)
  from public, anon, authenticated;
grant execute on function public.find_duplicate_lead(text, text, text, public.lead_type)
  to service_role;


-- ---------------------------------------------------------------------------
-- 7 — lead_imports: one row per spreadsheet upload.
--
-- The import is two requests — parse-and-propose, then confirm-and-commit — so
-- the parsed rows have to live somewhere in between. Staging them here rather
-- than making the browser re-upload means the commit works from exactly the
-- bytes we parsed, and it gives the mapping confirmation an idempotency anchor:
-- a batch is `pending_mapping` once, so a double-clicked Import or a stale tab
-- collides on status rather than importing twice.
--
-- RLS ON WITH NO POLICIES — deny-all to the browser, the same shape as
-- subscription_pauses and operator_proof_snapshots. Everything here is reached
-- through a server route on the service role. row_payload holds the customer's
-- raw spreadsheet cells, which is exactly the sort of thing that must never be
-- one missing policy away from another customer.
-- ---------------------------------------------------------------------------
create table if not exists public.lead_imports (
  id               uuid primary key default gen_random_uuid(),
  customer_id      uuid not null references public.customers(id) on delete cascade,
  lead_type        public.lead_type not null,
  file_name        text,
  status           text not null default 'pending_mapping',
  headers          jsonb,
  row_payload      jsonb not null,
  proposed_mapping jsonb,
  final_mapping    jsonb,
  mapping_source   text,
  row_count        integer not null default 0,
  imported_count   integer,
  duplicate_count  integer,
  empty_count      integer,
  error            text,
  created_at       timestamptz not null default now(),
  committed_at     timestamptz
);

alter table public.lead_imports drop constraint if exists lead_imports_status_check;
alter table public.lead_imports
  add constraint lead_imports_status_check
  check (status in ('pending_mapping', 'imported', 'cancelled', 'failed'));

alter table public.lead_imports drop constraint if exists lead_imports_mapping_source_check;
alter table public.lead_imports
  add constraint lead_imports_mapping_source_check
  check (mapping_source is null or mapping_source in ('claude', 'heuristic'));

create index if not exists idx_lead_imports_customer
  on public.lead_imports (customer_id, created_at desc);

alter table public.lead_imports enable row level security;

comment on table public.lead_imports is
  'One row per spreadsheet upload: the staged rows between the mapping preview '
  'and the commit, plus the audit of what was imported. RLS is on with no '
  'policies — service-role only.';


-- ---------------------------------------------------------------------------
-- 8 — create_customer_leads: the only way an owned lead is created.
--
-- One transaction per batch. A lead and its assignment MUST be created
-- together: the assignment row is what makes the lead visible to its owner
-- (leads_select_assigned, 0014), so a lead inserted without one is invisible to
-- the person who just added it while still being a row admin and every sweep
-- can see. Doing this in two TypeScript statements would make that state
-- reachable on any mid-batch failure.
--
-- THREE THINGS THIS DELIBERATELY DOES NOT DO:
--
--   * It spends no credit and bumps no counter. Not lead_balance, not
--     leads_received_this_month, not management_lifetime_leads_received. The
--     odometer means "leads Stayful delivered" (§13) and these were not
--     delivered by us; charging for a customer's own contact list would be
--     absurd, and quietly advancing their pacing counters would starve them of
--     the marketplace leads they actually pay for.
--   * It does not call assign_lead_to_customer. That function is the single
--     money path and gates on balance, subscription and pause — none of which
--     should stand between a customer and their own data. It would also refuse
--     these outright now, via lead_retired_from_allocation.
--   * It writes price_paid = 0, breaking the "every delivered lead is
--     chargeable" reading of invariant 4. That invariant is about leads WE
--     deliver; nothing was sold here.
--
-- Leads are seeded max_assignments = 1, assignment_count = 1 — full, so even a
-- caller that never consults lead_retired_from_allocation computes no free
-- slots — and income_report_status = 'no_report', which is true (there is no
-- Monday item to carry an analysis) and keeps them out of the income-report
-- sweep's backlog by construction rather than by a query filter.
--
-- Postcode is passed in rather than derived: extractPostcode/postcodeArea live
-- in TypeScript (src/lib/postcode.ts) and have no SQL twin, and a second
-- implementation here would be a second answer to "what area is this lead in".
-- ---------------------------------------------------------------------------
create or replace function public.create_customer_leads(
  p_customer_id uuid,
  p_lead_type   public.lead_type,
  p_source      text,
  p_rows        jsonb
)
returns table (row_index integer, outcome text, created_lead_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_elem      jsonb;
  v_ord       bigint;
  v_name      text;
  v_email     text;
  v_phone     text;
  v_address   text;
  v_key       text;
  v_existing  uuid;
  v_new_id    uuid;
begin
  if p_source not in ('import', 'manual') then
    raise exception 'Unknown owned-lead source %', p_source;
  end if;

  if not exists (select 1 from public.customers where id = p_customer_id) then
    raise exception 'Customer % not found', p_customer_id;
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'create_customer_leads expects a JSON array of rows';
  end if;

  -- Bounded so one upload cannot hold a transaction open indefinitely. The
  -- route rejects an over-cap file before it reaches here with a message
  -- telling the customer to split it — truncating would silently lose leads.
  if jsonb_array_length(p_rows) > 2000 then
    raise exception 'Too many rows in one import (% > 2000)', jsonb_array_length(p_rows);
  end if;

  for v_elem, v_ord in
    select value, ordinality from jsonb_array_elements(p_rows) with ordinality
  loop
    v_name    := nullif(btrim(coalesce(v_elem->>'name', '')), '');
    v_email   := nullif(btrim(coalesce(v_elem->>'email', '')), '');
    v_phone   := nullif(btrim(coalesce(v_elem->>'phone', '')), '');
    v_address := nullif(btrim(coalesce(v_elem->>'address', '')), '');

    row_index       := (v_ord - 1)::integer;
    created_lead_id := null;

    -- A row with no way to reach or identify anybody is a spreadsheet artefact
    -- (a spacer, a totals line, a stray note), not a lead.
    if v_name is null and v_email is null and v_phone is null and v_address is null then
      outcome := 'empty';
      return next;
      continue;
    end if;

    -- Same landlord, same owner, same product. lead_identity_key (0070) is
    -- reused rather than reimplemented so "the same landlord" has ONE
    -- definition repo-wide; it requires all three of name, email and phone, so
    -- a partial row has a null key and never matches — under-matching costs a
    -- duplicate, over-matching would silently discard a real lead.
    --
    -- Scoped to this owner: a customer's private copy is unrelated to whether
    -- WE hold the same landlord, and must not be suppressed by one.
    v_key := public.lead_identity_key(v_name, v_email, v_phone);

    if v_key is not null then
      select l.id into v_existing
      from public.leads l
      where l.owner_customer_id = p_customer_id
        and l.lead_type = p_lead_type
        and public.lead_identity_key(l.lead_name, l.email, l.phone) = v_key
      order by l.created_at
      limit 1;

      if v_existing is not null then
        outcome         := 'duplicate';
        created_lead_id := v_existing;
        return next;
        continue;
      end if;
    end if;

    -- lead_name is NOT NULL and always has been. Rather than weaken the column
    -- for a form that promises no required fields, fall back through whatever
    -- the customer DID give us, so the lead is identifiable in a list.
    insert into public.leads (
      monday_item_id,
      lead_name,
      address,
      phone,
      email,
      lead_profile,
      bedrooms,
      postcode,
      postcode_area,
      lead_type,
      owner_customer_id,
      owner_source,
      max_assignments,
      assignment_count,
      income_report_status
    ) values (
      null,
      coalesce(v_name, v_email, v_phone, v_address, 'Untitled lead'),
      v_address,
      v_phone,
      v_email,
      nullif(btrim(coalesce(v_elem->>'profile', '')), ''),
      nullif(btrim(coalesce(v_elem->>'bedrooms', '')), ''),
      nullif(btrim(coalesce(v_elem->>'postcode', '')), ''),
      nullif(btrim(coalesce(v_elem->>'postcode_area', '')), ''),
      p_lead_type,
      p_customer_id,
      p_source,
      1,
      1,
      'no_report'
    )
    returning id into v_new_id;

    insert into public.lead_assignments (lead_id, customer_id, price_paid, status, pipeline_stage)
      values (v_new_id, p_customer_id, 0, 'new', 'cold');

    outcome         := 'created';
    created_lead_id := v_new_id;
    return next;
  end loop;

  return;
end;
$$;

revoke all on function public.create_customer_leads(uuid, public.lead_type, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.create_customer_leads(uuid, public.lead_type, text, jsonb)
  to service_role;

comment on function public.create_customer_leads(uuid, public.lead_type, text, jsonb) is
  'Creates customer-owned leads and their owner assignments atomically. Spends '
  'no credit and touches no customer counter. Returns one row per input row '
  'with outcome in (created, duplicate, empty).';
