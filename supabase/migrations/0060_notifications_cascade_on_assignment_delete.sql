-- ============================================================================
-- notifications.lead_assignment_id must not block deleting an assignment.
--
-- THIS IS A LIVE BUG FIX, NOT A TIDY-UP.
--
-- Every other foreign key pointing at lead_assignments handles the parent
-- going away: lead_events, lead_files and lead_notes cascade, testimonials
-- sets null. notifications was created with the default NO ACTION, which
-- REFUSES the delete.
--
-- Two paths delete a lead_assignments row, and both were broken by it:
--
--   * discard_lead_assignment (0010) — the customer-facing Discard button.
--     Every assignment gets a notification row on delivery (228 of 228 in
--     production at the time of writing), so every discard attempt failed with
--     "update or delete on table lead_assignments violates foreign key
--     constraint notifications_lead_assignment_id_fkey". Discard has never
--     worked for any lead that was actually notified — which is all of them.
--
--   * admin_swap_lead_assignment (0059) — hit the same wall as soon as it
--     shipped, which is how the older fault was found.
--
-- CASCADE rather than SET NULL. A notification exists to tell a customer they
-- received a specific lead; once that delivery is retracted the notification is
-- about something that did not happen. SET NULL would keep it in the feed with
-- a dead link — visibly broken, and worse than absent. Notifications are an
-- ephemeral feed, not a financial record: payments, lead_events and the
-- assignment's own price_paid are where delivery history is kept, and none of
-- them are touched here.
--
-- Nothing else changes. The column stays nullable, the index stays, and no
-- application code needs to know.
-- ============================================================================

alter table public.notifications
  drop constraint if exists notifications_lead_assignment_id_fkey;

alter table public.notifications
  add constraint notifications_lead_assignment_id_fkey
  foreign key (lead_assignment_id)
  references public.lead_assignments(id)
  on delete cascade;
