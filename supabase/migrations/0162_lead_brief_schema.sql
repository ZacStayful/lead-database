-- ============================================================================
-- The Lead Brief schema (Lead Brief, Phase 1). New Management customers only.
--
-- A new Management customer completes a brief after payment and before their
-- first lead: where they operate, how far they travel, and what a lead must
-- have. From that the engine (Phase 2) computes a service area, first-pick
-- areas and an expected mix, and routing (Phase 4) uses it to score leads.
-- This migration adds the storage only. docs/build/ holds the build prompt
-- and its additions (A1–A13).
--
-- What it adds:
--   1. customers.lead_brief_required / lead_brief_completed_at — the gate.
--   2. customer_lead_briefs — one row per brief VERSION, with a status.
--   3. lead_assignments.match_* — the label and "why" on a brief lead.
--   4. area_competition — the High / Medium / Low tier per area.
--   5. Two settings: the kill switch and the behind-pace threshold.
--
-- ⚠️ INERT. Nothing reads any of it until the brief code ships:
--   - lead_brief_required defaults to FALSE, so every existing customer is
--     exempt. The go-live migration (last in the build) flips the DEFAULT to
--     true so that every row created afterwards is flagged without any insert
--     path having to remember it, and backfills never-held prospects (D2).
--     Not here: flagging anyone now would change nothing (no code reads the
--     column yet) and would make the go-live step harder to reason about.
--   - lead_brief_enabled ships 'false'.
--   - Every new column on lead_assignments is null on every row, and a CHECK
--     keeps them null together.
--   - No existing function is created, replaced or re-granted. The helpers
--     below are new, immutable and pure.
--
-- Management only, by construction: the brief has no lead_type column and no
-- gr_ mirror, like the goals columns (§13). Guaranteed Rent is out of scope.
--
-- ⚠️ RLS ON, NO POLICIES, on both new tables. The build prompt asked for a
-- select-own policy; the approved Phase 0 report (C19) chose the house
-- posture instead: every read goes through a server route on the service
-- role, so the tables cannot be probed from the browser. The brief holds
-- computed areas that are a coarse map of where supply is.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The gate on customers
-- ---------------------------------------------------------------------------
alter table public.customers
  add column if not exists lead_brief_required boolean not null default false,
  add column if not exists lead_brief_completed_at timestamptz;

comment on column public.customers.lead_brief_required is
  'Management only (0162). True means this customer must complete a Lead Brief '
  'before routing delivers to them, and is then routed by the brief rather '
  'than by the legacy filter pools. False on every customer that existed when '
  'the brief shipped; the go-live migration flips the default for new rows.';

comment on column public.customers.lead_brief_completed_at is
  'When the customer first confirmed a Lead Brief (0162). Null until then. '
  'Stamped once; later brief versions do not move it.';

-- ---------------------------------------------------------------------------
-- 2. Validation helpers
--
-- The element rules live in immutable helpers so the CHECKs can call them —
-- the lead_tags_valid pattern (0150). Pure, no table reads, no ACL statements.
-- ---------------------------------------------------------------------------

-- An outcode ("YO10") or a postcode area ("YO"), upper-case, as an array with
-- no nulls and no repeats. Used for every area list on the brief and for
-- area_competition.area_code.
--
-- The outcode pattern is the same one leads.outcode (0161) extracts, so a
-- brief outcode and a lead outcode compare by plain equality.
create or replace function public.lead_brief_codes_valid(p_codes text[], p_kind text)
returns boolean
language sql
immutable
set search_path = public
as $$
  -- coalesce: a CHECK passes on NULL, so a validator must never answer one.
  select coalesce(
    p_codes is not null
    and p_kind in ('outcode', 'postcode_area')
    and cardinality(p_codes) <= 3000
    and cardinality(p_codes) = (select count(distinct c) from unnest(p_codes) as c)
    and not exists (
      select 1
        from unnest(p_codes) as c
       where c is null
          or c !~ case p_kind
                    when 'outcode' then '^[A-Z]{1,2}[0-9][A-Z0-9]?$'
                    else '^[A-Z]{1,2}$'
                  end
    ),
    false);
$$;

-- Essentials (A8 Q3): up to two of minimum bedrooms and minimum revenue, each
-- at most once. The threshold for each lives in its own typed column below,
-- so routing (Phase 4) can test it in SQL without parsing jsonb.
create or replace function public.lead_brief_essentials_valid(p_essentials text[])
returns boolean
language sql
immutable
set search_path = public
as $$
  select coalesce(
    p_essentials is not null
    and cardinality(p_essentials) <= 2
    and cardinality(p_essentials) = (select count(distinct e) from unnest(p_essentials) as e)
    and not exists (
      select 1
        from unnest(p_essentials) as e
       where e is null or e not in ('bedrooms', 'revenue')
    ),
    false);
$$;

-- Priorities (A8): a ranked jsonb array, most important first, of objects
-- {"key": "location" | "revenue" | "bedrooms" | "occupancy"} with an optional
-- numeric "threshold". 1–4 entries, each key at most once.
--
-- The default ranking (location, then the chosen essentials, then revenue,
-- bedrooms, occupancy) is the questionnaire's job, not a column default:
-- it depends on what the customer picked as essentials.
create or replace function public.lead_brief_priorities_valid(p_priorities jsonb)
returns boolean
language sql
immutable
set search_path = public
as $$
  -- ⚠️ CASE, not AND: SQL does not promise to evaluate the type test before
  -- jsonb_array_length / jsonb_array_elements, and both RAISE on a non-array.
  -- A CHECK that errors instead of answering false is a 500 on a bad write.
  select case
    when jsonb_typeof(p_priorities) = 'array' then
      jsonb_array_length(p_priorities) between 1 and 4
      and not exists (
        select 1
          from jsonb_array_elements(p_priorities) as p(e)
         where case
                 when jsonb_typeof(p.e) <> 'object' then true
                 when jsonb_typeof(p.e -> 'key') is distinct from 'string' then true
                 when (p.e ->> 'key') not in ('location', 'revenue', 'bedrooms', 'occupancy') then true
                 when p.e ? 'threshold' then jsonb_typeof(p.e -> 'threshold') <> 'number'
                 else false
               end
      )
      and jsonb_array_length(p_priorities) = (
        select count(distinct p.e ->> 'key')
          from jsonb_array_elements(p_priorities) as p(e)
      )
    else false
  end;
$$;

-- Expected mix (Phase 2, A4): the customer's own allocation split across the
-- four labels, e.g. {"top_match": 12, "strong_match": 5, "first_pick": 2,
-- "nearby_opportunity": 1}. Whole, non-negative numbers; a label may be
-- absent. Never a lead volume: A4 forbids sending one to a client.
create or replace function public.lead_brief_mix_valid(p_mix jsonb)
returns boolean
language sql
immutable
set search_path = public
as $$
  -- CASE throughout, for the reason given in lead_brief_priorities_valid:
  -- jsonb_each raises on a non-object, and the numeric cast on a non-number.
  select case
    when jsonb_typeof(p_mix) = 'object' then
      not exists (
        select 1
          from jsonb_each(p_mix) as m(k, v)
         where case
                 when m.k not in ('top_match', 'strong_match', 'first_pick', 'nearby_opportunity') then true
                 when jsonb_typeof(m.v) <> 'number' then true
                 else (m.v #>> '{}')::numeric < 0
                   or (m.v #>> '{}')::numeric <> trunc((m.v #>> '{}')::numeric)
               end
      )
    else false
  end;
$$;

-- ---------------------------------------------------------------------------
-- 3. customer_lead_briefs — one row per brief VERSION
--
-- Versioned rather than updated in place, like filter_forecast_acknowledgements:
-- an edit (Phase 5) or a monthly recompute (A10) inserts a new version, so the
-- brief a lead was routed under is still there to explain it.
--
-- ⚠️ EXACTLY ONE ACTIVE ROW PER CUSTOMER (A10), enforced by a partial unique
-- index rather than by the writers. Routing reads the active row only. A wider
-- area found by the monthly recompute is never applied silently: it is written
-- as pending_confirmation and waits for the customer (batch 04 builds that
-- screen). At most one of those per customer, too, so a second recompute
-- replaces the waiting one rather than stacking them.
-- ---------------------------------------------------------------------------
create table if not exists public.customer_lead_briefs (
  id                    uuid primary key default gen_random_uuid(),
  customer_id           uuid not null references public.customers(id) on delete cascade,
  version               integer not null check (version >= 1),
  status                text not null
                          check (status in ('active', 'pending_confirmation', 'superseded')),
  -- Who produced this version: the customer (questionnaire or editor), the
  -- monthly recompute (A10), or an admin.
  origin                text not null default 'customer'
                          check (origin in ('customer', 'recompute', 'admin')),

  -- What the customer told us (A8) ------------------------------------------
  -- The postcode as given, upper-case: a full "YO10 5DD" or just the outcode.
  base_postcode         text not null,
  base_outcode          text not null,
  -- Derived, never asked (A8): 10 miles → local, 25 or 50 → growing,
  -- anywhere → anywhere. Null travel limit means anywhere; the plan cap (A3)
  -- still applies to it.
  operating_mode        text not null
                          check (operating_mode in ('local', 'growing', 'anywhere')),
  travel_limit_miles    integer,
  -- The plan the brief was computed for. It decides the cap (A3).
  allocation            integer not null check (allocation > 0),
  priorities            jsonb not null,
  essentials            text[] not null default '{}',
  -- The threshold for each essential. Each is set exactly when its essential
  -- is chosen. min_gross uses the GROSS_THRESHOLDS list from §68
  -- (src/lib/filterPrediction.ts), the same list customers.filter_min_gross
  -- is checked against (0158).
  min_bedrooms          integer check (min_bedrooms between 1 and 10),
  min_gross             integer
                          check (min_gross in (25000, 30000, 40000, 50000, 75000)),
  -- "Add another area" (A8 Q1): extra outcodes the customer works.
  priority_outcodes     text[] not null default '{}',
  -- Similar areas the customer accepted from the suggestions (A8 preview).
  -- Postcode areas, not outcodes: similarity is computed per postcode area,
  -- because no outcode has enough leads to compare on its own (D4).
  similar_areas         text[] not null default '{}',

  -- What the engine computed (Phase 2) --------------------------------------
  -- The smallest radius that delivers the allocation from live supply, capped
  -- at the smaller of the travel limit and the plan maximum (A3).
  service_radius_miles  integer not null check (service_radius_miles >= 1),
  -- Every outcode inside that radius. Routing's hard boundary.
  service_outcodes      text[] not null,
  -- Outcodes within the travel limit that no other customer covers (Phase 2).
  -- May lie outside the service area, which is why routing admits a lead in
  -- either list. Never a claim of exclusivity (locked decision 7).
  first_pick_outcodes   text[] not null default '{}',
  -- Behind-pace widening (A11): outcodes beyond the service area, out to the
  -- plan maximum, NEAREST FIRST — the array order is the order they are
  -- offered in. Used only while the customer is behind pace; the stored
  -- service area never changes because of them.
  pace_outcodes         text[] not null default '{}',
  -- True when the cap was reached before the supply target, so the mix will
  -- lean to Nearby opportunity (A3). The brief is stored anyway.
  mix_leans_nearby      boolean not null default false,
  expected_mix          jsonb not null default '{}',
  -- End of the billing cycle the first-pick areas are locked for (Phase 2).
  locked_until          date,

  confirmed_at          timestamptz,
  superseded_at         timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint customer_lead_briefs_version_unique unique (customer_id, version),

  -- The postcode is a canonical "OUT IN" postcode or just the outcode,
  -- upper-case with one space, and the outcode is its outward part.
  constraint customer_lead_briefs_base_postcode_format check (
    base_postcode ~ '^[A-Z]{1,2}[0-9][A-Z0-9]?( [0-9][A-Z]{2})?$'
  ),
  constraint customer_lead_briefs_base_outcode_format check (
    public.lead_brief_codes_valid(array[base_outcode], 'outcode')
    and (base_postcode = base_outcode or base_postcode like base_outcode || ' %')
  ),

  -- ⚠️ The derivation in A8, enforced here so the stored mode can never
  -- disagree with the stored limit. Validated against the LIST of offered
  -- distances, never a range (§68.5's rule).
  --
  -- ⚠️ A CASE WITH coalesce, NOT AN OR CHAIN. A CHECK passes on NULL, and
  -- `travel_limit_miles = 10` is NULL when the limit is NULL — so the obvious
  -- `(mode = 'local' and limit = 10) or …` admits 'local' with no limit at
  -- all. The test suite caught exactly that.
  constraint customer_lead_briefs_travel_mode check (
    case operating_mode
      when 'anywhere' then travel_limit_miles is null
      when 'local'    then coalesce(travel_limit_miles = 10, false)
      when 'growing'  then coalesce(travel_limit_miles in (25, 50), false)
      else false
    end
  ),

  -- ⚠️ A3: never beyond the smaller of the travel limit and the plan maximum
  -- (10-lead plan 40 miles, 20-lead plan 75). The same constants live in the
  -- engine (src/lib/leadBrief/), which a later guard test pins to these.
  constraint customer_lead_briefs_radius_cap check (
    service_radius_miles <= case when allocation <= 10 then 40 else 75 end
    and (travel_limit_miles is null or service_radius_miles <= travel_limit_miles)
  ),

  constraint customer_lead_briefs_priorities_valid check (
    public.lead_brief_priorities_valid(priorities)
  ),
  constraint customer_lead_briefs_essentials_valid check (
    public.lead_brief_essentials_valid(essentials)
  ),
  constraint customer_lead_briefs_bedrooms_threshold check (
    ('bedrooms' = any(essentials)) = (min_bedrooms is not null)
  ),
  constraint customer_lead_briefs_revenue_threshold check (
    ('revenue' = any(essentials)) = (min_gross is not null)
  ),

  constraint customer_lead_briefs_outcode_lists check (
    public.lead_brief_codes_valid(priority_outcodes, 'outcode')
    and public.lead_brief_codes_valid(service_outcodes, 'outcode')
    and public.lead_brief_codes_valid(first_pick_outcodes, 'outcode')
    and public.lead_brief_codes_valid(pace_outcodes, 'outcode')
    and public.lead_brief_codes_valid(similar_areas, 'postcode_area')
  ),
  -- The base outcode is at distance zero, so it is always in the service area.
  constraint customer_lead_briefs_service_has_base check (
    base_outcode = any(service_outcodes)
  ),
  -- Pace outcodes are BEYOND the service area by definition (A11).
  constraint customer_lead_briefs_pace_outside_service check (
    not (pace_outcodes && service_outcodes)
  ),

  constraint customer_lead_briefs_mix_valid check (
    public.lead_brief_mix_valid(expected_mix)
  ),

  -- An active brief is one the customer confirmed. A pending one has not been
  -- confirmed yet; a superseded one may or may not have been.
  constraint customer_lead_briefs_active_confirmed check (
    status <> 'active' or confirmed_at is not null
  ),
  constraint customer_lead_briefs_superseded_stamp check (
    (status = 'superseded') = (superseded_at is not null)
  )
);

comment on table public.customer_lead_briefs is
  'Lead Brief versions, Management only (0162). Exactly one active row per '
  'customer; at most one pending_confirmation. Written and read on the service '
  'role only (RLS on, no policies).';

create unique index if not exists customer_lead_briefs_one_active
  on public.customer_lead_briefs (customer_id)
  where status = 'active';

create unique index if not exists customer_lead_briefs_one_pending
  on public.customer_lead_briefs (customer_id)
  where status = 'pending_confirmation';

alter table public.customer_lead_briefs enable row level security;

-- updated_at. SECURITY INVOKER with no ACL statements, a copy of
-- touch_lead_analysis_updated_at (0104): it needs a trigger context to do
-- anything, and Postgres checks EXECUTE on a trigger function when the trigger
-- is created, not when it fires.
create or replace function public.touch_lead_brief_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_customer_lead_briefs_touch on public.customer_lead_briefs;
create trigger trg_customer_lead_briefs_touch
  before update on public.customer_lead_briefs
  for each row execute function public.touch_lead_brief_updated_at();

-- ---------------------------------------------------------------------------
-- 4. The label on a brief customer's lead
--
-- Written by completeAssignment for brief customers only (Phase 4). Null on
-- every other assignment, and on every assignment that exists today.
--
-- Per ASSIGNMENT, not per lead: the label says how well the lead fits THIS
-- customer's brief, and another holder's copy must never show it.
-- ⚠️ match_reasons is read by the customer's own browser (the lead pages read
-- lead_assignments.*). It must never mention another holder, a holder count,
-- a deficit or an area volume (locked decision 9).
-- ---------------------------------------------------------------------------
alter table public.lead_assignments
  add column if not exists match_label    text,
  add column if not exists match_score    numeric,
  add column if not exists match_reasons  jsonb,
  -- The brief version the label was computed against, so the "why" still
  -- reads correctly after the customer edits their brief.
  add column if not exists match_brief_id uuid
    references public.customer_lead_briefs(id) on delete set null;

alter table public.lead_assignments
  drop constraint if exists lead_assignments_match_label_check;
alter table public.lead_assignments
  add constraint lead_assignments_match_label_check check (
    match_label is null
    or match_label in ('top_match', 'strong_match', 'first_pick', 'nearby_opportunity')
  );

alter table public.lead_assignments
  drop constraint if exists lead_assignments_match_score_check;
alter table public.lead_assignments
  add constraint lead_assignments_match_score_check check (
    match_score is null or match_score >= 0
  );

alter table public.lead_assignments
  drop constraint if exists lead_assignments_match_reasons_check;
alter table public.lead_assignments
  add constraint lead_assignments_match_reasons_check check (
    match_reasons is null or jsonb_typeof(match_reasons) = 'object'
  );

-- A label always comes with its score and reasons; no label means none of the
-- four is set. match_brief_id may be nulled later by its FK without the label
-- going, so it is only required to be null when there is no label.
alter table public.lead_assignments
  drop constraint if exists lead_assignments_match_together;
alter table public.lead_assignments
  add constraint lead_assignments_match_together check (
    (match_label is null and match_score is null
       and match_reasons is null and match_brief_id is null)
    or (match_label is not null and match_score is not null
       and match_reasons is not null)
  );

-- The FK needs an index or deleting a brief scans every assignment. Partial:
-- almost every row is null.
create index if not exists lead_assignments_match_brief_idx
  on public.lead_assignments (match_brief_id)
  where match_brief_id is not null;

comment on column public.lead_assignments.match_label is
  'Lead Brief label (0162): top_match, strong_match, first_pick or '
  'nearby_opportunity. Null on every non-brief assignment.';

-- ---------------------------------------------------------------------------
-- 5. area_competition — the High / Medium / Low tier per area
--
-- Shown to a customer as "High / Medium / Low competition from management
-- companies" (locked decision 8). One row per area. An admin can set any tier
-- (source = 'admin'); a computed suggestion is written with source =
-- 'contention' and must never overwrite an admin row (Phase 6). The
-- contention figure itself is never shown to a customer (C9, D5).
-- ---------------------------------------------------------------------------
create table if not exists public.area_competition (
  id          uuid primary key default gen_random_uuid(),
  area_kind   text not null check (area_kind in ('outcode', 'postcode_area')),
  area_code   text not null,
  tier        text not null check (tier in ('high', 'medium', 'low')),
  source      text not null check (source in ('contention', 'admin')),
  note        text check (note is null or char_length(note) <= 500),
  updated_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint area_competition_code_format check (
    public.lead_brief_codes_valid(array[area_code], area_kind)
  ),
  constraint area_competition_one_per_area unique (area_kind, area_code)
);

comment on table public.area_competition is
  'Competition tier per outcode or postcode area for the Lead Brief (0162). '
  'Admin rows win over contention rows. Service role only (RLS on, no policies).';

alter table public.area_competition enable row level security;

drop trigger if exists trg_area_competition_touch on public.area_competition;
create trigger trg_area_competition_touch
  before update on public.area_competition
  for each row execute function public.touch_lead_brief_updated_at();

-- ---------------------------------------------------------------------------
-- 6. Settings
--
-- lead_brief_enabled ships OFF. It is read by TypeScript only.
-- lead_brief_pace_deficit_pct is the behind-pace threshold for A11: a brief
-- customer is behind pace when their deficit is at least
-- ceil(allocation × pct / 100) (D9).
-- ---------------------------------------------------------------------------
insert into public.system_settings (key, value)
values
  ('lead_brief_enabled', 'false'),
  ('lead_brief_pace_deficit_pct', '20')
on conflict (key) do nothing;
