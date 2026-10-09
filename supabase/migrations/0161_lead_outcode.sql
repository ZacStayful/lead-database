-- ============================================================================
-- A lead's outcode, derived from its postcode (Lead Brief, Phase 1).
--
-- The Lead Brief matches by OUTCODE ("YO10"), not by postcode area ("YO"):
-- a brief customer's service area, first-pick areas and distances are all
-- outcode lists. Nothing stored one. `leads.postcode` holds the canonical
-- "OUT IN" form written by extractPostcode() (src/lib/postcode.ts) at ingest
-- and by create_customer_leads for owned leads, so the outcode is the part
-- before the space.
--
-- ⚠️ A STORED GENERATED COLUMN, NOT A BACKFILL PLUS A TRIGGER. Every writer of
-- `postcode` (ingest, owned-lead creation, the analysis worker, an admin
-- edit) then gets the outcode for free, with no code change, and it can never
-- drift from the postcode it came from. Measured before this was written:
-- every insert and update of `leads` in src/ and in the live function bodies
-- names its columns explicitly, so nothing tries to write this column — a
-- generated column refuses an explicit value, which is the point.
--
-- ⚠️ SYNTACTIC, NOT parseOutcode(). parseOutcode (src/lib/outcodes.ts) only
-- returns an outcode present in the vendored centroid list, which is missing
-- real outcodes (M50, Salford Quays). Storing the syntactic outcode keeps
-- those; whether an outcode has a known centroid is a question for the code
-- that needs a distance, not for the column. A typo'd postcode that is
-- well-formed (B22 2AX) yields an outcode no service area will ever contain,
-- which is the harmless direction.
--
-- Measured on production, 2026-10-08, management leads since 2026-07-01 that
-- are not customer-owned: 328 leads, 311 with a postcode (94.8%), 309 of whose
-- outcodes are in the centroid list (94.2%). 239 distinct outcodes, none with
-- more than 4 leads.
--
-- INERT: nothing reads the column until the Lead Brief routing ships.
-- Adding a stored generated column rewrites the table once (about 600 rows).
-- ============================================================================

alter table public.leads
  add column if not exists outcode text
  generated always as (
    substring(upper(btrim(postcode)) from '^([A-Z]{1,2}[0-9][A-Z0-9]?) ?[0-9][A-Z]{2}$')
  ) stored;

comment on column public.leads.outcode is
  'Outward code of the lead''s postcode ("YO10"), generated from postcode '
  '(0161). Syntactic: present whenever the postcode is well-formed, whether or '
  'not the outcode has a known centroid. Read by Lead Brief routing.';

-- The brief routing and its supply loader look leads up by outcode within a
-- product; most rows carry one, so the index is partial on the rest.
create index if not exists idx_leads_lead_type_outcode
  on public.leads (lead_type, outcode)
  where outcode is not null;
