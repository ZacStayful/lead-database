-- ============================================================================
-- How a lead filter was set: hand-picked areas, or a radius search.
--
-- The radius filter mode (no migration of its own — it resolves to postcode
-- areas client-side and saves through the ordinary filter apply) left admin
-- unable to tell a radius-set filter from a hand-picked one, or to see the
-- radius the customer asked for. These columns record that intent. They are
-- METADATA ONLY: routing reads filter_areas exactly as before, and nothing
-- gates on any column here.
--
-- All columns are nullable and additive. NULL selection mode means "unknown"
-- — every filter set before this migration — and renders as hand-picked,
-- which is what they all were. The radius columns are only meaningful when
-- the mode is 'radius'.
--
-- Deliberately NOT cleared by execute_filter_lift (0026): that would mean a
-- create-or-replace of a privileged function for a metadata nicety (see the
-- §11 ACL trap in CLAUDE.md). Instead, readers must only consult these
-- columns while filter_status is 'active' or 'pending_lift'; a lifted
-- filter's stale metadata is invisible and the next apply overwrites it.
-- ============================================================================

alter table public.customers
  add column if not exists filter_selection_mode  text,
  add column if not exists filter_radius_outcode  text,
  add column if not exists filter_radius_miles    integer;

alter table public.customers
  drop constraint if exists customers_filter_selection_mode_check;
alter table public.customers
  add constraint customers_filter_selection_mode_check
  check (filter_selection_mode in ('areas', 'radius'));

alter table public.customers
  drop constraint if exists customers_filter_radius_miles_check;
alter table public.customers
  add constraint customers_filter_radius_miles_check
  check (filter_radius_miles > 0);

-- gr_ mirror (invariant 6).
alter table public.customers
  add column if not exists gr_filter_selection_mode  text,
  add column if not exists gr_filter_radius_outcode  text,
  add column if not exists gr_filter_radius_miles    integer;

alter table public.customers
  drop constraint if exists customers_gr_filter_selection_mode_check;
alter table public.customers
  add constraint customers_gr_filter_selection_mode_check
  check (gr_filter_selection_mode in ('areas', 'radius'));

alter table public.customers
  drop constraint if exists customers_gr_filter_radius_miles_check;
alter table public.customers
  add constraint customers_gr_filter_radius_miles_check
  check (gr_filter_radius_miles > 0);
