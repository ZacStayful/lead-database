-- ============================================================================
-- last_status_change_at — when a lead_assignment's status last changed.
--
-- Enables a true "days since last activity" inactivity nudge: a lead that moved
-- to 'contacted' and then went quiet is now detectable, not only leads left
-- untouched since assignment. Defaults to now() so a freshly-inserted
-- assignment (status 'new') is stamped at creation == its assignment time.
--
-- Stamped going forward by the customer assignments PATCH on every status
-- change it makes (contacted / won). Terminal transitions driven by the
-- reject/discard security-definer RPCs are intentionally NOT stamped here:
-- those states are excluded from the nudge, and rewriting privileged functions
-- is out of scope for this change. If the column is later needed as an
-- authoritative "last status change" for all transitions, those RPCs would need
-- to stamp it too.
-- ============================================================================

alter table public.lead_assignments
  add column if not exists last_status_change_at timestamptz not null default now();

-- Backfill existing rows to their best-known change time. A 'new' assignment
-- has not changed since it was assigned; a contacted/won assignment's best-known
-- change time is its first contact. coalesce(first_contacted_at, assigned_at)
-- captures both (assigned_at is always set, so the result is never null).
update public.lead_assignments
  set last_status_change_at = coalesce(first_contacted_at, assigned_at);
