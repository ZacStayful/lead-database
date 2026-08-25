-- ============================================================================
-- 0106 — Reporting on the leads customers bring in themselves.
--
-- 0102 let a customer import their own leads and 0104/0105 let them pay to have
-- those leads analysed. Neither gave admin any way to see the population: the
-- leads are deliberately absent from every marketplace counter (§30.8), which
-- is right — they are not our supply — and left them invisible rather than
-- merely uncounted. Nobody could answer "how many leads have customers brought
-- in", let alone "how many this month".
--
-- Two functions: one row per month, and one row for all time.
--
-- ── Why SQL rather than counting rows in the page ───────────────────────────
--
-- One import is capped at 2,000 rows and a customer may run many. The admin
-- leads page already reads every lead with no limit and gets away with it at
-- ~430; this population is the one that grows in thousand-row steps, so it is
-- aggregated in the database from the start rather than after the page gets
-- slow. `idx_leads_owner_customer` is a partial index on exactly these rows.
--
-- ── Reporting only ──────────────────────────────────────────────────────────
--
-- Nothing here gates anything, and nothing here is exposed to a customer. These
-- read `leads` across every owner, so they are service-role only — the same
-- posture as get_service_capacity and get_customer_scoreboard.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 — One row per calendar month, newest first.
--
-- ⚠️ Months are cut in EUROPE/LONDON, not UTC. Half the year they differ by an
-- hour, so a lead added at half past midnight on the 1st of August would
-- otherwise be reported in July — a figure that disagrees with the date printed
-- beside it in the lead list, which is rendered in local time everywhere else
-- in this app (businessTime.ts, and every email). One convention, and this is
-- the one the business actually works in.
-- ---------------------------------------------------------------------------
create or replace function public.get_imported_lead_months()
returns table (
  month           date,
  total           integer,
  from_import     integer,
  from_manual     integer,
  management      integer,
  guaranteed_rent integer,
  analysed        integer,
  customers       integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    (date_trunc('month', l.created_at at time zone 'Europe/London'))::date as month,
    count(*)::integer,
    count(*) filter (where l.owner_source = 'import')::integer,
    count(*) filter (where l.owner_source = 'manual')::integer,
    count(*) filter (where l.lead_type = 'management')::integer,
    count(*) filter (where l.lead_type = 'guaranteed_rent')::integer,
    -- "Analysed" is the paid upsell having landed (§31): a gross figure is the
    -- one thing every successful run produces, and the only one a customer
    -- reads. Deliberately not income_report_status = 'parsed', which is also
    -- true of a marketplace lead read off Monday and would quietly start
    -- counting something else if these two populations ever met.
    count(*) filter (where l.gross_annual_income is not null)::integer,
    count(distinct l.owner_customer_id)::integer
  from public.leads l
  where l.owner_customer_id is not null
  group by 1
  order by 1 desc;
$$;

comment on function public.get_imported_lead_months() is
  'Customer-imported leads, one row per calendar month (Europe/London). '
  'Reporting only — nothing gates on it. service_role only.';


-- ---------------------------------------------------------------------------
-- 2 — All time.
--
-- Computed over every row rather than summed from the months above, so a
-- capped or filtered month list can never make the lifetime figure disagree
-- with itself. The two are read together on one page and would be compared.
-- ---------------------------------------------------------------------------
create or replace function public.get_imported_lead_totals()
returns table (
  total           integer,
  from_import     integer,
  from_manual     integer,
  management      integer,
  guaranteed_rent integer,
  analysed        integer,
  customers       integer,
  first_added     timestamptz,
  last_added      timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    count(*)::integer,
    count(*) filter (where l.owner_source = 'import')::integer,
    count(*) filter (where l.owner_source = 'manual')::integer,
    count(*) filter (where l.lead_type = 'management')::integer,
    count(*) filter (where l.lead_type = 'guaranteed_rent')::integer,
    count(*) filter (where l.gross_annual_income is not null)::integer,
    count(distinct l.owner_customer_id)::integer,
    min(l.created_at),
    max(l.created_at)
  from public.leads l
  where l.owner_customer_id is not null;
$$;

comment on function public.get_imported_lead_totals() is
  'Customer-imported leads, all time. Computed over every row rather than '
  'summed from get_imported_lead_months, so the two cannot disagree.';


-- ---------------------------------------------------------------------------
-- 3 — One row per customer who has brought leads in.
--
-- "Leads imported from users" is a question about users as much as about
-- volume, and this is the answer the monthly view raises rather than settles:
-- one customer importing four hundred and everyone else importing none is a
-- very different business than forty customers importing ten.
-- ---------------------------------------------------------------------------
create or replace function public.get_imported_lead_customers()
returns table (
  customer_id     uuid,
  business_name   text,
  total           integer,
  from_import     integer,
  from_manual     integer,
  analysed        integer,
  first_added     timestamptz,
  last_added      timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.id,
    c.business_name,
    count(*)::integer,
    count(*) filter (where l.owner_source = 'import')::integer,
    count(*) filter (where l.owner_source = 'manual')::integer,
    count(*) filter (where l.gross_annual_income is not null)::integer,
    min(l.created_at),
    max(l.created_at)
  from public.leads l
  join public.customers c on c.id = l.owner_customer_id
  where l.owner_customer_id is not null
  group by c.id, c.business_name
  order by count(*) desc, c.business_name;
$$;

comment on function public.get_imported_lead_customers() is
  'Customer-imported leads, one row per owning customer. Reporting only.';


-- ---------------------------------------------------------------------------
-- 4 — Access.
--
-- SECURITY DEFINER because they read `leads` across every owner, and Supabase
-- exposes public functions at /rest/v1/rpc/<name> with EXECUTE defaulting to
-- PUBLIC — so without these revokes any customer holding the publishable key
-- could read how many leads every other operator has imported, and which of
-- them are buying analysis. §11 records that a `create or replace` discards the
-- ACL, which is why these run unconditionally rather than only on first install.
-- ---------------------------------------------------------------------------
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.get_imported_lead_months()',
    'public.get_imported_lead_totals()',
    'public.get_imported_lead_customers()'
  ] loop
    execute format('revoke all on function %s from public', fn);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on function %s from anon', fn);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on function %s from authenticated', fn);
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', fn);
    end if;
  end loop;
end $$;
