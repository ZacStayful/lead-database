-- ============================================================================
-- The town a radius search was centred on.
--
-- 0094 recorded HOW a filter was set (hand-picked areas, or a radius) and the
-- outcode the circle was centred on. The radius box took a postcode and
-- nothing else, so the outcode WAS the centre and there was nothing else to
-- record. It now takes a town name as well, resolved through a vendored
-- gazetteer to the outcode nearest that town INSIDE its own postcode area —
-- so "Salisbury" and "SP1" produce the same circle, and without this column
-- admin reads "Radius: 20 mi from SP1" for a search the customer made by
-- typing Salisbury.
--
-- METADATA ONLY, exactly as 0094's header states: routing matches on
-- filter_areas, which the radius resolves to before anything is saved, and
-- nothing gates on any column here. Both are nullable and additive — NULL
-- means the centre was a postcode (or the filter predates this), which is
-- what every existing radius filter is.
--
-- Deliberately NOT cleared by execute_filter_lift (0026), for 0094's reason:
-- that would mean a create-or-replace of a privileged function for a metadata
-- nicety (the §11 ACL trap). Readers must only consult these columns while
-- filter_status is 'active' or 'pending_lift'.
--
-- ⚠️ The length CHECK is not decoration. filterKindLabel() renders this
-- straight into an admin table cell, the apply route takes it from the
-- browser, and the column has no other constraint — the longest real name in
-- the gazetteer is 27 characters ("Knightsbridge and Belgravia"), so 120 is generous and still bounded.
-- ============================================================================

alter table public.customers
  add column if not exists filter_radius_place text;

alter table public.customers
  drop constraint if exists customers_filter_radius_place_check;
alter table public.customers
  add constraint customers_filter_radius_place_check
  check (
    filter_radius_place is null
    or (length(filter_radius_place) between 1 and 120)
  );

-- gr_ mirror (invariant 6). Guaranteed Rent has the same filter machinery and
-- the same radius box, so it gets the same column — unlike a figure that only
-- one product can ever hold.
alter table public.customers
  add column if not exists gr_filter_radius_place text;

alter table public.customers
  drop constraint if exists customers_gr_filter_radius_place_check;
alter table public.customers
  add constraint customers_gr_filter_radius_place_check
  check (
    gr_filter_radius_place is null
    or (length(gr_filter_radius_place) between 1 and 120)
  );

comment on column public.customers.filter_radius_place is
  'Town a radius filter was centred on, when the customer typed a name rather than a postcode (0157). Metadata only; nothing gates on it.';
comment on column public.customers.gr_filter_radius_place is
  'Guaranteed Rent mirror of filter_radius_place (0157).';
