-- ============================================================================
-- Pin search_path on engagement_score_params.
--
-- 0045 created it without `set search_path`, which the Supabase linter flags
-- (0011_function_search_path_mutable). The function is IMMUTABLE and returns
-- four literals, so there is nothing for a hostile search_path to redirect —
-- this is convention, not a vulnerability.
--
-- Fixed anyway so every function in the schema follows the same rule. A single
-- documented exception is how the next person learns that the rule is optional.
-- ============================================================================

create or replace function public.engagement_score_params()
returns table (
  open_rate_weight    numeric,
  contact_rate_weight numeric,
  window_days         integer,
  min_assignments     integer
)
language sql
immutable
set search_path = public
as $$
  select 0.35::numeric, 0.65::numeric, 30, 5;
$$;
