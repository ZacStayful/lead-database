-- 0108_owned_lead_resale.sql
--
-- Lets a customer's own lead be sold to exactly ONE other operator, once they
-- have paid to run it through the analyser and it came back with trustworthy
-- figures. 0107 closed every route by which such a lead could reach a second
-- buyer; this is the migration that opens one.
--
-- THE RULE
--
--   * A lead uploaded by a customer is sold to nobody, as before, UNTIL it
--     qualifies.
--   * It qualifies when a PAID analysis (§31) returns figures we trust. A run
--     rejected for `quality_ok = false` — the analyser's own tell-tale for a
--     synthetic estimate — never qualifies, and neither does one that failed for
--     any other reason. Those leads stay unsellable for ever.
--   * From that moment it is ordinary supply for ONE further operator, at the
--     ordinary price, through the ordinary routing. Uploader plus one. Never
--     more.
--   * Never back to the person who uploaded it, and never into the expired pool.
--
-- TWO COLUMNS, BECAUSE THEY ANSWER TWO QUESTIONS
--
-- `owner_resale_allowed` is consent, fixed at creation. It is the whole of the
-- new-uploads-only rule: leads added before this migration keep the default of
-- false and can never become sellable, however they are analysed later. Made a
-- property of the row rather than a cutoff timestamp compared against
-- created_at (the `reclaim_enabled_from` shape, §7) because a global clock is
-- one bad read away from enrolling the entire back catalogue at once, and does
-- not survive a restore into a different timeline. A per-row boolean defaulting
-- to false fails safe by construction.
--
-- `owner_resale_qualified_at` is the event. Non-null IS the sellable state, and
-- it is what `lead_retired_from_allocation` reads.
--
-- WHAT IS DELIBERATELY NOT RELAXED
--
--   * `lead_pool_barred()` keeps its `owner_customer_id is not null` clause,
--     untouched. Owned leads never pool, qualified or not: the cap is one
--     resale, and the pool is by definition unbounded. Until now that function
--     and lead_retired_from_allocation agreed by coincidence; from here they
--     mean different things, which is why only one of them moves.
--   * `find_duplicate_lead()` stays blind to owned leads (§30.1). A customer's
--     private copy of a landlord must never make a real Monday enquiry look
--     like a duplicate and get discarded. The consequence, which is accepted:
--     one landlord can be sold both as a resold owned lead and, separately, as
--     an ordinary marketplace lead.
--
-- Two bodies are redefined, each the verbatim text of 0102 with one clause
-- changed, copied programmatically and diffed against the source.
--
-- Applied BEFORE the code that reads these columns, as ever. On its own it is
-- inert: nothing writes `owner_resale_qualified_at` until the analysis worker
-- lands, so every lead stays exactly as retired as it is today.

alter table public.leads
  add column if not exists owner_resale_allowed boolean not null default false,
  add column if not exists owner_resale_qualified_at timestamptz;

comment on column public.leads.owner_resale_allowed is
  'Consent, stamped true by create_customer_leads from 0108 onward. False on every lead uploaded before this migration, which is the new-uploads-only rule.';

comment on column public.leads.owner_resale_qualified_at is
  'When a paid analysis returned trustworthy figures and the lead became sellable to one other operator. Non-null is the sellable state.';

-- Tiny population, and this is exactly the predicate the qualification RPC and
-- the resale reporting both filter on.
create index if not exists idx_leads_owner_resale_qualified
  on public.leads (owner_resale_qualified_at)
  where owner_customer_id is not null and owner_resale_qualified_at is not null;

-- ==========================================================================
-- create_customer_leads — from 0102, stamping consent on every new lead
-- ==========================================================================

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
      income_report_status,
      owner_resale_allowed
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
      'no_report',
      -- Stamped true here, and nowhere else. THIS is the new-uploads-only rule
      -- (§32): every lead that predates 0108 keeps the column default of false
      -- and can never become sellable, whatever is analysed later.
      --
      -- A property of the row rather than a clock. The obvious alternative is a
      -- cutoff timestamp in system_settings compared against created_at, on the
      -- `reclaim_enabled_from` precedent — but a global like that is one bad
      -- read away from enrolling the entire back catalogue at once, and it does
      -- not survive a restore into a different timeline. A per-row boolean
      -- defaulting to false fails in the safe direction by construction.
      true
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

revoke execute on function public.create_customer_leads(uuid, public.lead_type, text, jsonb) from public, anon, authenticated;
grant execute on function public.create_customer_leads(uuid, public.lead_type, text, jsonb) to service_role;

-- ==========================================================================
-- lead_retired_from_allocation — from 0102, the one relaxation
-- ==========================================================================

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
          -- An owned lead is retired UNTIL it qualifies. Qualification means a
          -- paid analysis came back with trustworthy figures (§32), and from
          -- that moment the lead is ordinary supply for exactly one more
          -- operator — so it has to leave this predicate, which is what every
          -- candidate function and the money path consult.
          --
          -- The pool is NOT relaxed with it: lead_pool_barred keeps its own
          -- `owner_customer_id is not null` clause, unchanged and deliberately
          -- so. The two functions used to agree by coincidence; from here they
          -- mean different things.
          or (
            l.owner_customer_id is not null
            and l.owner_resale_qualified_at is null
          )
        )
    );
$$;

revoke execute on function public.lead_retired_from_allocation(uuid) from public, anon, authenticated;
grant execute on function public.lead_retired_from_allocation(uuid) to service_role;

-- ==========================================================================
-- Qualification
-- ==========================================================================
--
-- Claim-by-write, the discipline `credit_invoice()` uses against Stripe
-- redelivery (§19.5) and `announcement_deliveries` uses against a double-clicked
-- send (§22.2): the state change and the guard are one statement, so there is no
-- window between checking and acting. Returns whether a row actually moved.
--
-- EVERY CLAUSE IN THE WHERE IS LOAD-BEARING:
--
--   owner_customer_id is not null    only a customer's own lead is in scope
--   owner_resale_allowed             the new-uploads-only cutoff
--   owner_resale_qualified_at is null  idempotent. The analysis worker retries
--                                    on a failed write, and a customer may buy
--                                    a re-run of a lead already analysed
--                                    (`already_analysed` is offered, not
--                                    refused) — neither may raise the cap twice
--   max_assignments = 1              refuses to overwrite a cap an admin has
--                                    moved by hand. Better to leave a lead
--                                    unsellable than to silently rewrite a
--                                    figure somebody set deliberately
--   gross_annual_income is not null  the analysis actually produced a figure.
--                                    Same test /admin/imported-leads uses for
--                                    "analysed" (§31.11), rather than
--                                    income_report_status = 'parsed', which is
--                                    also true of a marketplace lead read off
--                                    Monday
--   postcode_area is not null        ⚠️ NOT redundant. postcode_area is what
--                                    get_filtered_candidates_for_lead matches
--                                    on, so a lead without one reaches
--                                    unfiltered customers only — it would be
--                                    sold, quietly, to the wrong half of the
--                                    book. analysability() already refuses a
--                                    lead with no clear postcode, so this
--                                    should never bite; if it ever does, the
--                                    lead stays unsellable rather than
--                                    mis-routed
--
-- The cap goes to 2 in the same statement that stamps the timestamp, so the
-- sellable state and the room to sell into can never disagree.

create or replace function public.qualify_owned_lead_for_resale(p_lead_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated integer;
begin
  update public.leads
     set owner_resale_qualified_at = now(),
         max_assignments = 2
   where id = p_lead_id
     and owner_customer_id is not null
     and owner_resale_allowed = true
     and owner_resale_qualified_at is null
     and max_assignments = 1
     and gross_annual_income is not null
     and postcode_area is not null;

  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

revoke execute on function public.qualify_owned_lead_for_resale(uuid) from public, anon, authenticated;
grant execute on function public.qualify_owned_lead_for_resale(uuid) to service_role;
