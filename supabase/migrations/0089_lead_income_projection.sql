-- ============================================================================
-- 0089 — Stayful's own gross income figure on a lead.
--
-- Every sellable item on the management leads board (18420117742) carries a
-- Stayful property-analysis PDF in the "Deal Analyser" file column, and that
-- PDF states the property's projected GROSS short-term-let revenue. Nothing in
-- the marketplace read it, so an operator deciding whether to work a lead saw a
-- name, an address and a bedroom count and no indication of what the property
-- is worth.
--
-- THIS IS NOT lead_assignments.income_estimate (0012). That column is the
-- OPERATOR'S own figure: self-entered, per customer, blank until somebody types
-- in it, and two operators holding the same lead can hold different numbers.
-- gross_annual_income is OURS: one figure per lead, identical for every holder,
-- present the moment the lead is delivered. They must never be merged, summed
-- or used as a fallback for one another — the analytics income totals count the
-- operator's figure precisely because it is the operator's.
--
-- ---------------------------------------------------------------------------
-- ONE STORED FIGURE, EVERYTHING ELSE DERIVED
-- ---------------------------------------------------------------------------
-- The product shows four ranges: gross per year, gross per month, and the
-- management company's revenue on each (gross / 6.667, a 15% management fee),
-- all 10% either side of the estimate. None of that is stored. Eight columns
-- that must stay in step with one another is eight chances to drift; one column
-- and a pure function (src/lib/incomeProjection.ts) cannot disagree with
-- itself. Monthly is annual / 12 for the same reason — the PDF prints its own
-- monthly line but it is only round(annual / 12), so a second column would buy
-- a second source of truth for nothing.
--
-- ---------------------------------------------------------------------------
-- THE REPORT ITSELF IS NOT PART OF THE PRODUCT
-- ---------------------------------------------------------------------------
-- No PDF is attached to a lead, no URL is stored, and nothing links to one.
-- Monday's public_url is a one-hour signed S3 link used transiently at parse
-- time and thrown away; a stored copy would be dead within the hour and a live
-- fetch would hand a customer the whole analysis, which is not what is being
-- sold. income_report_asset_id is an opaque id, never rendered and never a
-- link — it exists so the sweep can tell a replaced report from the one it has
-- already parsed, and skip the download when nothing has changed.
--
-- ---------------------------------------------------------------------------
-- WHY A STATUS COLUMN RATHER THAN "gross_annual_income IS NULL"
-- ---------------------------------------------------------------------------
-- Null means five different things and they need different handling. A lead
-- nobody has looked at yet must be retried; a lead whose item genuinely carries
-- no analysis must not be retried every night forever; a legacy third-party
-- valuation that will never parse is a permanent fact, not a failure; and a
-- download that timed out is a failure and must be retried. The sweep's whole
-- query is this column, hence the partial index.
--
--   pending    never attempted
--   parsed     gross_annual_income is set and trustworthy
--   no_report  the Monday item carries no analysis PDF
--   unparsed   a PDF was read but the gross figure could not be trusted
--   failed     transient (Monday unreachable, download or parse errored)
--
-- 'unparsed' is deliberately distinct from 'failed'. A mis-parse must fail
-- SILENT rather than publish: the parser cross-checks its monthly figure
-- against annual / 12 and, where the PDF states one, its own "Management Fees
-- (15%)" line against annual / 6.667, and returns nothing when either
-- disagrees. A wrong income figure on a lead is worse than no figure, because
-- an operator would price a call on it.
--
-- ---------------------------------------------------------------------------
-- leads.estimated_monthly_income IS NOT REUSED
-- ---------------------------------------------------------------------------
-- 0001 created that column and nothing has ever written or read it. It is text
-- where this is numeric, and its name reads as the operator's estimate rather
-- than ours, which is the exact confusion the block above exists to prevent.
-- Left alone rather than repurposed.
--
-- Nothing here touches a balance, counter, pacing or capacity column, so a
-- lagging deploy cannot affect lead allocation.
-- ============================================================================

alter table public.leads
  add column if not exists gross_annual_income      numeric,
  add column if not exists income_report_status     text not null default 'pending',
  add column if not exists income_report_asset_id   text,
  add column if not exists income_report_parsed_at  timestamptz,
  add column if not exists income_report_error      text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'leads_income_report_status_check'
  ) then
    alter table public.leads
      add constraint leads_income_report_status_check
      check (income_report_status in ('pending','parsed','no_report','unparsed','failed'));
  end if;
end $$;

comment on column public.leads.gross_annual_income is
  'Projected gross annual short-term-let revenue for this property, parsed from '
  'the Stayful property-analysis PDF on the Monday item. OURS, not the '
  'operator''s — lead_assignments.income_estimate is the operator''s own figure '
  'and the two must never be merged. Every range and the management-fee figure '
  'are derived from this one number in src/lib/incomeProjection.ts.';

comment on column public.leads.income_report_status is
  'pending | parsed | no_report | unparsed | failed. Drives '
  '/api/cron/parse-income-reports. ''unparsed'' is a permanent fact about the '
  'document, ''failed'' is transient and retried.';

comment on column public.leads.income_report_asset_id is
  'Monday asset id of the report the figure came from. Internal provenance: '
  'never rendered, never a URL, and no report is ever surfaced to a customer. '
  'It exists so the sweep can skip a report it has already parsed.';

-- The sweep's whole query. Partial, because 'parsed' rows are the overwhelming
-- majority once the backlog clears and they are never scanned again.
create index if not exists idx_leads_income_report_pending
  on public.leads (created_at)
  where income_report_status in ('pending', 'failed');

-- ---------------------------------------------------------------------------
-- The pool listing gains the figure.
--
-- A return-type change needs a DROP, and a drop DISCARDS the function's ACL —
-- the §11 gotcha that left get_next_customers_for_lead executable by anon after
-- 0038 recreated it. The revoke/grant below is therefore not boilerplate; it is
-- the whole reason this is safe.
--
-- Adding this to the pool row set does NOT breach the rule in 0075's header
-- that nothing about previous holders may be returned. That rule is about what
-- the people who held the lead did with it. This figure is Stayful's own, is
-- identical for every viewer, and says nothing about anybody who held the lead
-- before — it is exactly the kind of thing an operator deciding whether to ring
-- a pooled landlord should have.
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
