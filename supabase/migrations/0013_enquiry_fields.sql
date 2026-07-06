-- ============================================================================
-- Enquiry-form fields on customers.
-- The landing-page enquiry form captures the prospect's website and how many
-- properties they manage. These are stored on the customer row (in addition to
-- being pushed to the Monday enquiries board) so an admin can see them when
-- deciding whether to activate the account. Both nullable — existing customers
-- and the owner bootstrap path leave them empty.
-- ============================================================================

alter table public.customers
  add column if not exists website_url text;
alter table public.customers
  add column if not exists properties_managed text;
