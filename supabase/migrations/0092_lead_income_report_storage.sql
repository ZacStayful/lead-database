-- ---------------------------------------------------------------------------
-- 0092 — Keep the property-analysis PDF, and let operators read it.
--
-- SUPERSEDES 0089'S HEADER. That migration stated, correctly for the time, that
-- "the report itself is never stored and never surfaced ... fetched, read for
-- one number and discarded". That was a deliberate product constraint and it
-- has been reversed: an operator deciding whether to ring a landlord should be
-- able to read the analysis the figures come from, not just the two lines
-- derived from it. 0089's prose is left in place as the record of what was true
-- then; this file is where the rule now lives.
--
-- Two audiences, both deliberate:
--   * the operators the lead is assigned to;
--   * everybody who can see it in the expired-leads pool — which means a pooled
--     lead's full analysis can be read WITHOUT CLAIMING IT. That is a knowing
--     extension of §19.7's "calling is free, keeping is not", agreed as a
--     commercial decision rather than an oversight.
--
-- ONE FILE PER LEAD, REPLACED IN PLACE. The stored PDF always matches the
-- figures shown beside it; there is no history and nothing to garbage-collect,
-- because a fixed object path per lead makes replacement an overwrite.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1 — The bucket.
--
-- A NEW BUCKET RATHER THAN lead-files. That one is customer-owned: every one of
-- its storage.objects policies keys on
-- (storage.foldername(name))[1] = auth.uid()::text, because each object belongs
-- to exactly one customer. A report belongs to a LEAD — read by up to three
-- holders plus every pool viewer, owned by none of them — so it does not fit
-- that shape and must not be forced into it.
--
-- NO storage.objects POLICY AT ALL, which is the state training-media ends in
-- after 0061 drops its read policy: deny-all to the browser. The service role
-- writes, and every read is a signed URL minted by a route that has already
-- decided the caller may see this lead. A signed URL is authorised by its
-- signature, not by a policy.
--
-- The mime allowlist is a real guard rather than decoration: the only writer
-- uploads bytes it has just downloaded from Monday, and pinning the type stops
-- a change there quietly turning this into a general-purpose file store. The
-- size limit matches MAX_REPORT_BYTES in incomeReport.ts.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('lead-reports', 'lead-reports', false, 26214400, array['application/pdf'])
on conflict (id) do update
  set public             = false,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- 2 — Where the file is.
--
-- income_report_path is THE flag for whether a report is stored; there is no
-- separate boolean, because two sources of truth about one file is how a link
-- comes to point at nothing.
--
-- These columns are deliberately NOT written by incomeReportPatch(). That
-- function clears every figure on every outcome so a replaced report cannot
-- leave stale numbers behind — the right rule for figures and the wrong one for
-- a file, because a transient Monday outage ('failed') would then wipe an
-- operator's link to a PDF still sitting in the bucket, perfectly good. See
-- syncStoredReport() in src/lib/incomeReportStorage.ts for the four-way rule.
-- ---------------------------------------------------------------------------
alter table public.leads
  add column if not exists income_report_path       text,
  add column if not exists income_report_size_bytes bigint;

comment on column public.leads.income_report_path is
  'Object key in the lead-reports bucket for this lead''s stored analysis PDF, '
  'or null when none is stored. One file per lead at a fixed path, so a '
  'replacement is an overwrite and no orphan can exist. Never returned to the '
  'browser: the download route resolves it server-side and redirects to a '
  'short-lived signed URL.';

comment on column public.leads.income_report_size_bytes is
  'Size of the stored report, for the download link''s label. Null exactly when '
  'income_report_path is null.';

-- The 0089 comment said this id was "never rendered and never a link". Still
-- true of the id itself — it is Monday's asset id, used only to tell whether we
-- have already read this exact document — but the sentence read as a statement
-- about the report, which is no longer the rule. Corrected here rather than by
-- editing 0089, the same way 0091 corrected 0090's column comments.
comment on column public.leads.income_report_asset_id is
  'Monday asset id of the analysis PDF this row''s figures were read from. An '
  'opaque key used to skip a document already read and to decide whether a '
  'stored report needs replacing. Never rendered and never a link — the PDF '
  'itself is reached through /api/leads/[id]/report, not through this.';

-- ---------------------------------------------------------------------------
-- 3 — The pool listing says whether a report is there.
--
-- FOURTH drop/recreate of this function (0075, 0089, 0090, here), and this body
-- is copied from 0090's — the one that added avg_nightly_rate and
-- occupancy_rate. Rebuilding it from 0089's would silently drop both.
--
-- A drop DISCARDS the ACL every time, so the revoke/grant at the end is not
-- boilerplate; it is the whole reason this is safe (§11, the trap that left
-- get_next_customers_for_lead executable by anon after 0038).
--
-- has_income_report rather than the path: the pool card links to the route by
-- lead id and never needs the storage key, and 0075's rule is that this row set
-- carries the minimum. Nothing here says anything about who held the lead
-- before — it is our own document, identical for every viewer.
-- ---------------------------------------------------------------------------
drop function if exists public.get_customer_pool_leads(uuid, public.lead_type);

create function public.get_customer_pool_leads(
  p_customer_id uuid,
  p_lead_type   public.lead_type
)
returns table (
  lead_id                  uuid,
  lead_type                public.lead_type,
  lead_name                text,
  address                  text,
  phone                    text,
  email                    text,
  lead_profile             text,
  bedrooms                 text,
  postcode                 text,
  desired_rent             text,
  gross_annual_income      numeric,
  avg_nightly_rate         numeric,
  occupancy_rate           numeric,
  has_income_report        boolean,
  income_report_size_bytes bigint,
  enquiry_date             date,
  enquiry_date_known       boolean,
  lead_age_days            integer,
  days_in_pool             integer,
  pool_entered_at          timestamptz
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
    (l.income_report_path is not null),
    l.income_report_size_bytes,
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
