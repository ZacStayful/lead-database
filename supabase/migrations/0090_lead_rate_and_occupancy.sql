-- ============================================================================
-- 0090 — The two figures the gross number is built from.
--
-- 0089 reads the projected GROSS revenue out of the Stayful property-analysis
-- PDF. The same headline block states the property's average nightly rate and
-- its occupancy rate, and an operator deciding whether to ring a landlord wants
-- both: they are the two inputs behind the number, and they are the two things
-- an experienced operator will sanity-check for themselves.
--
-- They are also literally the gross figure's own arithmetic:
--
--     avg_nightly_rate x 365 x (occupancy_rate / 100) = gross_annual_income
--
-- measured within 1% on every report checked. That identity is not decoration
-- either — the parser uses it as a third cross-check (see below).
--
-- ---------------------------------------------------------------------------
-- NO NEW STATUS COLUMN
-- ---------------------------------------------------------------------------
-- These ride on income_report_status. They come out of the same document in
-- the same pass, so a second status column would be a second source of truth
-- about one parse, and the two would eventually disagree.
--
-- ---------------------------------------------------------------------------
-- THEY FAIL ALONE, AND THAT IS THE POINT
-- ---------------------------------------------------------------------------
-- gross_annual_income is live on 149 leads. A report that stops stating a
-- nightly rate must cost us the nightly rate and nothing else — so the parser
-- publishes gross with these two null rather than failing the whole lead. The
-- reverse would trade a working figure for a missing one, on a column
-- customers are already reading.
--
-- The identity above is what stops the WRONG pair being stored. The report's
-- "Comparable Properties" page carries its own Avg Nightly Rate and Avg
-- Occupancy for the comp set — different numbers for a different thing — and
-- they miss the identity by around 12%, well outside the parser's 2% tolerance.
--
-- occupancy_rate is stored as the percentage the report prints (63, not 0.63),
-- because that is what is rendered and a stored fraction would invite exactly
-- one off-by-100 bug.
--
-- Nothing here touches a balance, counter, pacing or capacity column.
-- ============================================================================

alter table public.leads
  add column if not exists avg_nightly_rate numeric,
  add column if not exists occupancy_rate   numeric;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'leads_occupancy_rate_check'
  ) then
    alter table public.leads
      add constraint leads_occupancy_rate_check
      check (occupancy_rate is null or (occupancy_rate >= 0 and occupancy_rate <= 100));
  end if;
end $$;

comment on column public.leads.avg_nightly_rate is
  'Average nightly rate for this property from the Stayful property-analysis '
  'PDF, whole pounds. Null unless corroborated: rate x 365 x occupancy must '
  'reproduce gross_annual_income within 2%.';

comment on column public.leads.occupancy_rate is
  'Occupancy rate from the same report, as the percentage printed (63, not '
  '0.63). Null under the same corroboration rule as avg_nightly_rate. This is '
  'the PROPERTY''S own figure, not the market average the report prints beside '
  'it.';

-- ---------------------------------------------------------------------------
-- The pool listing carries both.
--
-- Third drop/recreate of this function (0075, 0089, here). A drop DISCARDS the
-- ACL every time, so the revoke/grant below is the whole reason this is safe —
-- the §11 trap that left get_next_customers_for_lead executable by anon.
--
-- As with gross_annual_income, this is not a breach of 0075's rule that nothing
-- about previous holders may be returned: these are our own figures for the
-- property, identical for every viewer.
-- ---------------------------------------------------------------------------

drop function if exists public.get_customer_pool_leads(uuid, public.lead_type);

create function public.get_customer_pool_leads(
  p_customer_id uuid,
  p_lead_type   public.lead_type
)
returns table (
  lead_id             uuid,
  lead_type           public.lead_type,
  lead_name           text,
  address             text,
  phone               text,
  email               text,
  lead_profile        text,
  bedrooms            text,
  postcode            text,
  desired_rent        text,
  gross_annual_income numeric,
  avg_nightly_rate    numeric,
  occupancy_rate      numeric,
  enquiry_date        date,
  enquiry_date_known  boolean,
  lead_age_days       integer,
  days_in_pool        integer,
  pool_entered_at     timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    l.id,
    l.lead_type,
    l.lead_name,
    l.address,
    l.phone,
    l.email,
    l.lead_profile,
    l.bedrooms,
    l.postcode,
    l.desired_rent,
    l.gross_annual_income,
    l.avg_nightly_rate,
    l.occupancy_rate,
    public.safe_enquiry_date(l.enquiry_date),
    (public.safe_enquiry_date(l.enquiry_date) is not null),
    (current_date - coalesce(public.safe_enquiry_date(l.enquiry_date), l.created_at::date)),
    (extract(epoch from now() - l.pool_entered_at) / 86400)::integer,
    l.pool_entered_at
  from public.leads l
  where l.lead_type = p_lead_type
    and public.customer_can_see_pool_lead(l.id, p_customer_id)
  -- Freshest into the pool first. A lead that went cold yesterday is a better
  -- call than one that went cold six weeks ago, and the operator scanning the
  -- list should meet the live ones before the dregs.
  order by l.pool_entered_at desc, l.created_at desc;
$$;

revoke execute on function public.get_customer_pool_leads(uuid, public.lead_type)
  from public, anon, authenticated;
grant execute on function public.get_customer_pool_leads(uuid, public.lead_type)
  to service_role;
