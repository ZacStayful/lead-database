-- ============================================================================
-- 0055 — one lead now reaches three operators instead of two.
--
-- leads.max_assignments has defaulted to 2 since 0001, so every lead has been
-- sold to at most two customers through ordinary routing. Raising the default
-- to 3 sells each lead to one more operator.
--
-- DEFAULT ONLY — EXISTING ROWS ARE NOT TOUCHED.
--
-- `alter column ... set default` applies to rows inserted from now on. Every
-- lead already in the table keeps the max_assignments it was ingested with, and
-- that is deliberate: raising it in place would immediately mark 67 completed
-- management leads (2 of 2) as under-assigned, and both top-up paths —
-- ingestLead()'s duplicate branch on the daily Monday sync, and
-- /api/admin/leads/assign-pending — would then push a third copy of leads up to
-- several weeks old out to whoever had credit, in one burst. Those assignments
-- are chargeable and cannot be withdrawn (invariant 4), so it is a decision to
-- take deliberately rather than a side effect of a default change.
--
-- Nothing else needs to move. Every capacity check reads the column
-- (`assignment_count >= max_assignments`), the candidate queries take their
-- shortfall from the caller, and admin can still override a single lead through
-- PATCH /api/admin/leads/[id] (bounded 1..4). Soft reclaim continues to add its
-- derived slot on top of max_assignments without incrementing it (0046), so a
-- lead can now reach three operators normally and a fourth via reclaim.
-- ============================================================================

alter table public.leads
  alter column max_assignments set default 3;
