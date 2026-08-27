-- ---------------------------------------------------------------------------
-- 0113 — What the analysis says about the MARKET, not just the money.
--
-- 0089-0093 took nine figures out of the property analysis: the gross, the rate
-- and occupancy behind it, the cost percentages, the long-let comparison and
-- the seasonal curve. The analyser states more than that, and the rest is
-- exactly what an operator needs when a landlord asks the obvious question —
-- "is anyone actually booking round here?"
--
--   · how busy and how well-reviewed the competing listings are
--   · how far away they had to look to find them
--   · the analyser's own direct-booking and risk scores
--
-- ONLY WHAT THE REPORT STATES. Nothing here is derived, estimated or inferred
-- from figures we already hold. A number an operator repeats to a landlord has
-- to be one the document behind it actually prints, or the analysis stops being
-- the thing that makes the deck credible.
--
-- All nullable, all FAILING ALONE, in the same order of priority §25 sets: the
-- gross is live on leads customers read today, and no addition here may ever
-- cost it. A lead with none of these renders exactly as it does now.
-- ---------------------------------------------------------------------------

alter table public.leads
  add column if not exists market_occupancy_rate numeric,
  add column if not exists comp_set_size         integer,
  add column if not exists comp_set_radius_km    numeric,
  add column if not exists comp_avg_rating       numeric,
  add column if not exists comp_avg_review_count integer,
  add column if not exists risk_score            integer,
  add column if not exists risk_label            text,
  add column if not exists direct_booking_score  integer;

-- ---------------------------------------------------------------------------
-- The one figure that was already being read and thrown away.
--
-- OCCUPANCY_RE has matched `63% Market average 62%` since 0090 and captured the
-- second group only to discard it, because nothing needed it and one live
-- report states it as 0%. It is the cheapest possible answer to "how competitive
-- is this market" — the property's own occupancy is meaningless without it.
--
-- ⚠️ 0 IS A REAL VALUE HERE and means "no comparable listings nearby", which is
-- a fact worth showing rather than a parse failure. It is stored, and the
-- presentation is what decides not to draw a comparison against zero.
-- ---------------------------------------------------------------------------
comment on column public.leads.market_occupancy_rate is
  'The MARKET''s average occupancy as the report prints it (62, not 0.62), '
  'beside the property''s own occupancy_rate. 0 is legitimate and means no '
  'comparable listings were found nearby.';

comment on column public.leads.comp_set_size is
  'How many active listings the analysis compared against — the first figure in '
  '"N active Airbnb listings within X km".';

comment on column public.leads.comp_set_radius_km is
  'How far it had to look, in KILOMETRES, as the report prints it. Kept in the '
  'report''s own unit: converting here would mean our figure and the PDF an '
  'operator can open beside it disagree.';

comment on column public.leads.comp_avg_rating is
  'Mean guest rating across the comparable set, 0-5, one decimal as printed. '
  'The analyser excludes unrated listings from this mean, so it is the average '
  'of those that HAVE a rating.';

comment on column public.leads.comp_avg_review_count is
  'Mean number of reviews across the comparable set — how established the '
  'competition is, which is the half of "competitive" a rating alone misses. A '
  'market of 4.9-rated listings with six reviews each is a market with room in '
  'it.';

comment on column public.leads.risk_score is
  'The analyser''s own investment risk score, 0-100, where 0 is LOW risk. '
  'Direction matters and is the opposite of every other score here.';

comment on column public.leads.risk_label is
  'The wording the report prints beside that score ("Low-Medium Risk"). Stored '
  'rather than re-derived from the number, so the presentation and the PDF an '
  'operator hands over cannot band it differently.';

comment on column public.leads.direct_booking_score is
  'The analyser''s direct-booking potential score, 0-100, where 100 is best.';

-- ---------------------------------------------------------------------------
-- Ranges, so a mis-parse cannot store a number that renders as nonsense.
--
-- Each is added only if absent, and each allows NULL, because absence is the
-- normal state for every lead parsed before this shipped.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'leads_market_occupancy_rate_range') then
    alter table public.leads add constraint leads_market_occupancy_rate_range
      check (market_occupancy_rate is null or (market_occupancy_rate >= 0 and market_occupancy_rate <= 100));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'leads_comp_avg_rating_range') then
    alter table public.leads add constraint leads_comp_avg_rating_range
      check (comp_avg_rating is null or (comp_avg_rating >= 0 and comp_avg_rating <= 5));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'leads_risk_score_range') then
    alter table public.leads add constraint leads_risk_score_range
      check (risk_score is null or (risk_score >= 0 and risk_score <= 100));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'leads_direct_booking_score_range') then
    alter table public.leads add constraint leads_direct_booking_score_range
      check (direct_booking_score is null or (direct_booking_score >= 0 and direct_booking_score <= 100));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'leads_comp_set_size_range') then
    alter table public.leads add constraint leads_comp_set_size_range
      check (comp_set_size is null or comp_set_size >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'leads_comp_set_radius_km_range') then
    alter table public.leads add constraint leads_comp_set_radius_km_range
      check (comp_set_radius_km is null or (comp_set_radius_km > 0 and comp_set_radius_km <= 500));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- ⚠️ NO BACKFILL, AND NO WIDENING OF THE SWEEP'S THIRD PASS.
--
-- That pass selects `income_report_path is null OR platform_fee_pct is null`,
-- and every already-parsed lead fails both — so nothing here reaches the leads
-- that already carry figures. That is a DECISION, not an oversight: these leads
-- are working, their decks render today, and re-reading a few hundred documents
-- to add a slide is not worth the chance of disturbing one that is live.
--
-- New leads get these at ingest, through the same parse that writes the gross.
-- Should the backlog ever be worth clearing, adding `risk_score.is.null` to
-- that `.or()` is the whole change — presentationFiguresPatch already carries
-- these columns and already refuses to overwrite a value that exists.
-- ---------------------------------------------------------------------------
