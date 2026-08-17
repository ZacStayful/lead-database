-- ============================================================================
-- Store the pending-cancellation flag, per product.
--
-- The billing portal is configured subscription_cancel.mode = "at_period_end", so
-- a customer clicking cancel does NOT produce a cancelled subscription: it arrives
-- as customer.subscription.updated with status still "active" and
-- cancel_at_period_end true, and only becomes status "canceled" a whole billing
-- period later. Until now that flag was stored nowhere — CLAUDE.md §21 says so
-- explicitly, and gives a good reason: the Paused tab reads it LIVE from Stripe
-- because a stored flag would have been wrong for everyone already paused.
--
-- WHY THAT IS NO LONGER ENOUGH
-- ----------------------------
-- The Monday status sync (§23) writes `Cancelled` to the sales board the moment a
-- customer asks to leave, which was a deliberate product decision — churn should be
-- visible immediately, not a month later. But because the flag lived only inside
-- the webhook's event object, the label rule could not see it, and the rule had to
-- take it as a PARAMETER. Every other hook — a GR renewal, a failed payment, a
-- pause, a resume — recomputed the label without that parameter, concluded the
-- customer was simply active, and wrote `Management Customer` back over the top.
-- So a cancellation could be silently undone on the board for the rest of the
-- customer's paid period, which is exactly the fact the board most needs to be
-- right about.
--
-- A parameter that every caller must remember to pass is the wrong shape for a
-- rule that must not vary by caller. Storing it makes `mondayStatusLabelFor()` a
-- pure function of the customer row, so every hook necessarily agrees. That is the
-- fix; the alternative (an ordering rule about which hook is allowed to overwrite
-- which label) would have been a special case bolted onto the rule instead.
--
-- §21's objection does not apply to this column: it was about back-filling a flag
-- for customers who were ALREADY paused, where the true value was unknowable. Here
-- there is nothing to backfill — no customer has ever cancelled — and the column
-- is maintained by the same webhook branch that already maintains
-- cancellation_feedback / cancellation_comment, under exactly the same condition.
-- It is therefore never staler than those two columns are.
--
-- The Paused tab still reads Stripe live and should keep doing so: it is answering
-- "can we actually re-bill this person right now", which wants the live truth, not
-- our cache of it.
--
-- BOTH PRODUCTS, deliberately (invariant 6). GR has no resurrection bug today —
-- a GR customer with a pending cancellation is still gr_subscription_status
-- 'active', so every hook already agrees on `Guaranteed rent customer` — but
-- leaving the columns asymmetric would mean a GR cancellation showed on the board a
-- billing period after a management one, for no reason a reader could discover.
-- Both flags exist so both products can report a cancellation at the moment it is
-- requested.
--
-- Neither column gates anything: not allocation, not pacing, not capacity, not
-- eligibility. Routing continues to key on account_status / subscription_status and
-- their GR equivalents. These two are read by the Monday label rule and nothing
-- else.
-- ============================================================================

alter table public.customers
  add column if not exists cancel_at_period_end    boolean not null default false,
  add column if not exists gr_cancel_at_period_end boolean not null default false;

comment on column public.customers.cancel_at_period_end is
  'Management subscription is scheduled to cancel at period end. Set from Stripe''s cancel_at_period_end on customer.subscription.*, cleared when the subscription is active and no longer scheduled to cancel. Read by the Monday label rule (§23); gates nothing.';
comment on column public.customers.gr_cancel_at_period_end is
  'Guaranteed Rent equivalent of cancel_at_period_end. Same writer, same clearing rule.';
