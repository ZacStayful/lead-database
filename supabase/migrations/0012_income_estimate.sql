-- ============================================================================
-- Per-lead income estimate.
-- The customer's own estimated monthly income for a lead/property, entered in
-- their portal. Lives on lead_assignments (per customer/lead), independent of
-- anything pulled from Monday. Feeds the analytics income totals.
-- ============================================================================

alter table public.lead_assignments
  add column if not exists income_estimate numeric;
