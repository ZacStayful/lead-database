-- ============================================================================
-- Duplicate landlords.
--
-- Ingest has been idempotent on monday_item_id since 0001, which stops the SAME
-- Monday item being inserted twice. It has never stopped the same LANDLORD
-- arriving as several different Monday items, and that is what has happened:
--
--   31 duplicate groups · 66 leads · 35 redundant copies · 30 assignments
--
-- One landlord, Derek Howard, was ingested six times. Anthony Taylor was
-- ingested twice with byte-identical name, email and phone, and each copy was
-- sold to two operators — so four customers paid for one landlord, and two of
-- them wrote notes saying they had already contacted him.
--
-- That is the most direct lead-quality problem in the data: it charges twice for
-- one enquiry and it has operators ringing landlords who have already been rung.
--
-- THE RULE
-- --------
-- Name AND email AND phone must all match, after normalisation. All three, not
-- any two — a strict rule cannot produce a false positive, and a false positive
-- here silently deletes a real enquiry that a customer would have been sold.
-- Under-matching costs a duplicate; over-matching costs a lead. They are not
-- symmetric, so the rule errs toward letting a duplicate through.
--
-- ALL THREE MUST BE PRESENT
-- -------------------------
-- The management ingest path writes "" for any field Monday did not supply
-- (buildManagementInsert), so blank is common. Two leads sharing a name with
-- blank email and blank phone would otherwise match as duplicates and the
-- second real enquiry would be dropped. A key with any part missing is
-- therefore NULL, and NULL never matches anything.
--
-- WHAT THE RULE CATCHES, AND WHAT IT DOES NOT
-- -------------------------------------------
-- It collapses 35 of the redundant copies. It does NOT fully collapse Derek
-- Howard, whose six rows carry two different email addresses
-- (lettings7@protonmail.com and Lettings@tutamail.com) against one phone and
-- one name — the strict rule reduces him from six leads to two, not one. Rows
-- like that are reported by get_duplicate_leads() as PROBABLE duplicates for a
-- human to decide, and never blocked automatically. Deciding two email
-- addresses belong to one person is a judgement, not a match.
--
-- SCOPED WITHIN A PRODUCT
-- -----------------------
-- Three of the 31 groups span management AND guaranteed rent. Those are not
-- blocked: a landlord may genuinely enquire about both services, the two
-- products sell to different pools of customers, so nobody is charged twice for
-- the same thing. They are flagged for review instead, because the landlord
-- still ends up being contacted by operators of both kinds.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 — Normalised phone.
--
-- Production holds the same number as "0033 689768525" and "0689 768525", so
-- comparing raw strings catches nothing. Digits only, then the last 9, which
-- makes a number comparable across country-code and leading-zero variants
-- without needing to know which country it is from.
--
-- Junk is treated as missing rather than as a value: "0000 0000000" is in the
-- data (a real lead, with a real email), and left alone it would make every
-- placeholder phone match every other one.
-- ---------------------------------------------------------------------------
create or replace function public.normalised_phone(p_raw text)
returns text
language sql
immutable
as $$
  select case
    when p_raw is null then null
    else (
      select case
        when length(d) < 7 then null          -- too short to identify anybody
        when d ~ '^0+$'    then null          -- all zeros: a placeholder
        else right(d, 9)
      end
      from (select regexp_replace(p_raw, '\D', '', 'g') as d) x
    )
  end;
$$;

-- ---------------------------------------------------------------------------
-- 2 — The identity key. NULL whenever any of the three parts is missing, so a
-- partial record can never collide with another partial record.
-- ---------------------------------------------------------------------------
create or replace function public.lead_identity_key(
  p_name  text,
  p_email text,
  p_phone text
)
returns text
language sql
immutable
as $$
  select case
    when nullif(btrim(coalesce(p_name, '')), '')  is null then null
    when nullif(btrim(coalesce(p_email, '')), '') is null then null
    when public.normalised_phone(p_phone)         is null then null
    else
      lower(btrim(regexp_replace(p_name, '\s+', ' ', 'g')))
      || '|' || lower(btrim(p_email))
      || '|' || public.normalised_phone(p_phone)
  end;
$$;

-- Ingest looks this up on every insert, so it needs to be indexed rather than a
-- sequential scan over a growing leads table.
create index if not exists idx_leads_identity_key
  on public.leads (public.lead_identity_key(lead_name, email, phone), lead_type);

-- ---------------------------------------------------------------------------
-- 3 — Does this landlord already exist for this product?
--
-- Returns the id of the earliest matching lead, so the ORIGINAL is always the
-- survivor and re-running ingest is stable: whichever copy arrives later loses,
-- every time, regardless of the order the sync happens to see them in.
--
-- Deliberately NOT a unique constraint. The 35 existing duplicates would make
-- one impossible to add without deleting live data first, and a constraint
-- would raise on insert where this lets ingest report a clean "duplicate" the
-- same way the monday_item_id path already does.
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
  order by l.created_at
  limit 1;
$$;

revoke execute on function public.find_duplicate_lead(text, text, text, public.lead_type)
  from public, anon, authenticated;
grant execute on function public.find_duplicate_lead(text, text, text, public.lead_type)
  to service_role;

-- ---------------------------------------------------------------------------
-- 4 — The existing mess, for review.
--
-- Two confidences, never merged:
--
--   exact     name + email + phone all match. What ingest now blocks.
--   probable  name + phone match but the email differs. Derek Howard's case.
--             Reported, never acted on automatically.
--
-- assignments_made is the column that matters commercially: it is how many
-- times a customer was charged for a copy of a landlord they may already hold.
-- ---------------------------------------------------------------------------
create or replace function public.get_duplicate_leads()
returns table (
  confidence       text,
  lead_name        text,
  email            text,
  phone            text,
  lead_type        public.lead_type,
  copies           integer,
  assignments_made integer,
  lead_ids         uuid[],
  first_seen       timestamptz,
  last_seen        timestamptz,
  spans_products   boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with keyed as (
    select
      l.*,
      lower(btrim(regexp_replace(coalesce(l.lead_name, ''), '\s+', ' ', 'g'))) as n,
      lower(btrim(coalesce(l.email, '')))                                     as e,
      public.normalised_phone(l.phone)                                        as p
    from public.leads l
  ),
  exact as (
    select
      'exact'::text as confidence,
      min(k.lead_name) as lead_name, k.e as email, min(k.phone) as phone,
      k.lead_type,
      count(*)::integer as copies,
      coalesce(sum(k.assignment_count), 0)::integer as assignments_made,
      array_agg(k.id order by k.created_at) as lead_ids,
      min(k.created_at) as first_seen, max(k.created_at) as last_seen
    from keyed k
    where k.n <> '' and k.e <> '' and k.p is not null
    group by k.n, k.e, k.p, k.lead_type
    having count(*) > 1
  ),
  probable as (
    select
      'probable'::text,
      min(k.lead_name), min(k.e), min(k.phone),
      k.lead_type,
      count(*)::integer,
      coalesce(sum(k.assignment_count), 0)::integer,
      array_agg(k.id order by k.created_at),
      min(k.created_at), max(k.created_at)
    from keyed k
    where k.n <> '' and k.p is not null
    group by k.n, k.p, k.lead_type
    having count(*) > 1 and count(distinct k.e) > 1
  ),
  -- One landlord who appears under both products. Never blocked — the two
  -- products sell to different customers, so nobody pays twice — but the
  -- landlord is still contacted by both, which is worth a look.
  cross_product as (
    select k.n, k.p
    from keyed k
    where k.n <> '' and k.p is not null
    group by k.n, k.p
    having count(distinct k.lead_type) > 1
  )
  select
    u.confidence, u.lead_name, u.email, u.phone, u.lead_type, u.copies,
    u.assignments_made, u.lead_ids, u.first_seen, u.last_seen,
    exists (
      select 1 from cross_product x
      where x.n = lower(btrim(regexp_replace(u.lead_name, '\s+', ' ', 'g')))
        and x.p = public.normalised_phone(u.phone)
    )
  from (select * from exact union all select * from probable) u
  order by u.assignments_made desc, u.copies desc;
$$;

revoke execute on function public.get_duplicate_leads() from public, anon, authenticated;
grant execute on function public.get_duplicate_leads() to service_role;
