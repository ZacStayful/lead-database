-- ============================================================================
-- Public filter-volume cache, for the pre-signup estimator.
--
-- The landing pages let a prospect pick areas — by radius or by hand, exactly
-- as a customer does — and see the leads a month that selection is worth and
-- what it would cost per lead. Same maths as the dashboard, so the number they
-- are sold on is the number they get.
--
-- WHY A CACHE ROW AND NOT A LIVE READ
-- ---------------------------------------------------------------------------
-- fetchLeadVolumeAggregate pages the entire leads table. That is fine behind a
-- login, where it happens once per dashboard render; on an unauthenticated
-- endpoint it is a denial-of-service lever anyone can pull. This follows
-- public_activity_stats (0021) exactly: one row, rebuilt lazily behind an
-- atomic staleness claim, so a burst of traffic costs one rebuild rather than
-- one per request.
--
-- WHAT IS AND IS NOT EXPOSED
-- ---------------------------------------------------------------------------
-- `payload` holds per-area, per-bedroom lead counts — the minimum the estimator
-- needs to answer honestly, and effectively what the landing page is
-- advertising anyway.
--
-- It does NOT expose how many customers hold each area. Contention is applied
-- when the payload is BUILT, so the published counts are already the share a
-- newcomer could expect. A prospect therefore gets a contention-aware quote
-- without anyone being able to read our per-area customer counts out of it.
--
-- Read by anon; written only by the service role, as 0021 established.
-- ============================================================================

create table if not exists public.public_filter_volume (
  id           integer primary key default 1,
  payload      jsonb not null default '{}'::jsonb,
  generated_at timestamptz,
  constraint public_filter_volume_singleton check (id = 1)
);

insert into public.public_filter_volume (id, payload, generated_at)
  values (1, '{}'::jsonb, null)
  on conflict (id) do nothing;

alter table public.public_filter_volume enable row level security;

drop policy if exists "Public can read filter volume" on public.public_filter_volume;
create policy "Public can read filter volume"
  on public.public_filter_volume
  for select
  using (true);

comment on table public.public_filter_volume is
  'Single-row cache of per-area lead volume for the pre-signup estimator. Counts are already contention-adjusted for a newcomer, so per-area customer counts are not derivable from it.';
