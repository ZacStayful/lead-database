-- ---------------------------------------------------------------------------
-- 0128 — the daily follow-up prompt (§42)
--
-- 0127 built the contact plan and the timeline. Nothing anywhere ASKED an
-- operator to work one: 357 plans were materialised and every customer had to
-- go looking for them. This adds the two things the prompt needs.
--
-- Additive and inert on its own — the cron that reads both ships behind
-- `contact_plans_enabled`, which is still false.
-- ---------------------------------------------------------------------------
begin;

-- ---------------------------------------------------------------------------
-- 1. The opt-out key (§21.7's four-place rule; this is the fourth place)
--
-- One key covers the daily prompt and the weekly falling-behind notice: they
-- are two halves of one conversation about work that is due, and a customer
-- wanting one and not the other does not exist. `||` is a merge rather than a
-- replace, so an existing explicit false on any other stream survives.
-- ---------------------------------------------------------------------------
alter table public.customers
  alter column notification_preferences set default
    '{"new_lead": true, "credit_warnings": true, "inactivity_nudge": true,
      "progress_report": true, "monthly_insights": true, "announcements": true,
      "contact_followups": true}'::jsonb;

update public.customers
   set notification_preferences =
       notification_preferences || '{"contact_followups": true}'::jsonb
 where not (notification_preferences ? 'contact_followups');

-- ---------------------------------------------------------------------------
-- 2. ⚠️ THE CUTOFF, AND WHY THE PROMPT WOULD BE UNUSABLE WITHOUT IT
--
-- The 2026-09-01 backfill gave every open lead a plan, so the timeline reads
-- the same on all of them. It does NOT follow that 342 landlords who enquired
-- months ago should now be chased: the backfilled plan is there to be worked if
-- the operator chooses, and the daily prompt covers leads assigned from this
-- cutoff onward — Zac's rule, and the thing that stops switch-on being a wall.
--
-- Without it the first send is 326 attempts across 23 customers in one email,
-- which is how a daily prompt gets filtered to trash on day one and never read
-- again. There is no recovering from that, so the cron FAILS CLOSED on a
-- missing or unreadable value and prompts nobody.
--
-- A settings row rather than a column: it is one platform-wide date, and every
-- other go-live marker here (`reclaim_enabled_from`, `contact_gate_from`) is
-- the same shape. Stored as an ISO timestamp, compared against
-- `lead_assignments.assigned_at`.
--
-- Deliberately NOT in the /admin/messaging allow-list, unlike the four contact
-- settings 0127 added. That list is booleans and bounded integers, and a date
-- would need a third field kind for a value that is set once at go-live and
-- then never touched — the same position `reclaim_enabled_from` has always
-- been in. Moving it is a SQL edit, on purpose.
--
-- Seeded to the apply instant, so a fresh build prompts about nothing until
-- leads start arriving — the safe direction, and the same one
-- `contact_plans_enabled = false` picks.
-- ---------------------------------------------------------------------------
insert into public.system_settings (key, value)
values ('contact_notify_from', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
on conflict (key) do nothing;

commit;
