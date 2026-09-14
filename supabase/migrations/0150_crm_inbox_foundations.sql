-- ---------------------------------------------------------------------------
-- 0150 — Foundations for the CRM redesign's inbox and contact panel (§56)
--
-- The GHL-style redesign draws four things the schema has no home for: a
-- starred conversation, a tag on a lead, a date a goal is due by, and a saved
-- reply in the composer. It also lists conversations ACROSS leads, which no
-- index is shaped for — lead_message_threads is indexed by assignment_id, and
-- the Supabase performance advisor already flags lead_message_threads.lead_id
-- and lead_messages.lead_id as unindexed foreign keys, which is exactly the join
-- the inbox groups on.
--
-- Entirely additive, and inert until the code ships:
--
--   * `starred_at` is null on every thread; `tags` is '{}' on every assignment;
--     `management_customer_goal_due` is null on every customer.
--   * `set_management_customer_goal(integer)` is UNTOUCHED. A second,
--     two-argument signature is added beside it. ⚠️ Not a defaulted second
--     parameter on the existing function: that creates an OVERLOAD rather than
--     a replacement, and every existing one-argument call — the goal route in
--     production at apply time — fails with "function is not unique" (§34/§35).
--     Two distinct signatures, neither defaulted, and the new one gets its own
--     grant, because a grant attaches to a signature (invariant 7).
--   * `message_templates` (0116) ships empty and has never been read. It already
--     carries customer_id, channel and body_template — the shape a saved reply
--     needs — so it gains a title and a channel value meaning "either", rather
--     than a second table meaning the same thing.
--
-- Nothing here touches a balance, counter, pacing or capacity column, and no
-- routing function is replaced.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- 1. Threads: starring, and the index the inbox lists by
-- ===========================================================================

alter table public.lead_message_threads
  add column if not exists starred_at timestamptz;

comment on column public.lead_message_threads.starred_at is
  'When the operator starred this conversation; null when not starred. '
  'Presentation state only — nothing routes on it.';

-- The inbox asks "this customer''s conversations, newest activity first". The
-- existing indexes lead on (customer, channel, counterparty) and on
-- assignment_id, neither of which serves that ordering.
create index if not exists lead_message_threads_customer_recent_idx
  on public.lead_message_threads (customer_id, last_message_at desc nulls last);

-- Both flagged by the performance advisor as unindexed foreign keys, and both
-- are the join the inbox groups threads and messages under a lead by.
create index if not exists lead_message_threads_lead_idx
  on public.lead_message_threads (lead_id);

create index if not exists lead_messages_lead_idx
  on public.lead_messages (lead_id);

-- ===========================================================================
-- 2. Tags on an assignment
-- ===========================================================================
--
-- Per ASSIGNMENT, not per lead. A lead reaches up to three operators (§4) and
-- one operator's "hot" must never appear on another's copy — the same reason
-- notes, files and income_estimate hang off the assignment.

alter table public.lead_assignments
  add column if not exists tags text[] not null default '{}';

comment on column public.lead_assignments.tags is
  'Operator-chosen labels for their own copy of the lead. At most 20, each '
  '1–40 characters, trimmed. Never read by routing, scoring or reporting.';

-- The element rules live in an immutable helper so the CHECK can call it.
-- Bounds only: what a tag SAYS is the operator''s business.
create or replace function public.lead_tags_valid(p_tags text[])
returns boolean
language sql
immutable
set search_path = public
as $$
  select p_tags is not null
     and cardinality(p_tags) <= 20
     and not exists (
       select 1
         from unnest(p_tags) as t
        where t is null
           or length(btrim(t)) = 0
           or length(t) > 40
           or t <> btrim(t)
     );
$$;

alter table public.lead_assignments
  drop constraint if exists lead_assignments_tags_check;
alter table public.lead_assignments
  add constraint lead_assignments_tags_check
  check (public.lead_tags_valid(tags));

-- ===========================================================================
-- 3. A date the goal is due by
-- ===========================================================================
--
-- §13's goal is a count with no deadline. The redesign's goal card reads
-- "Sign 6 landlords by 30 Sep · 16 days left", and a deadline is the one thing
-- that turns a target into a pace. Nullable: a goal with no date is exactly
-- what every existing goal is.

alter table public.customers
  add column if not exists management_customer_goal_due date;

comment on column public.customers.management_customer_goal_due is
  'Management only. The date the customer wants management_customer_goal met '
  'by; null when no deadline was set. Cleared whenever the goal is cleared. '
  'Written only through set_management_customer_goal(integer, date).';

-- The two-argument form. Same identity rule as 0051: the caller is resolved
-- from auth.uid() inside the function, no customer id is accepted, and it
-- raises rather than silently no-ops for a missing row or an inactive
-- management subscription.
create or replace function public.set_management_customer_goal(
  p_goal integer,
  p_due  date
)
returns table (
  goal            integer,
  goal_updated_at timestamptz,
  goal_due        date
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer_id uuid;
  v_status      text;
begin
  if p_goal is not null and p_goal < 1 then
    raise exception 'Goal must be at least 1, or null to clear it';
  end if;

  select c.id, c.subscription_status
    into v_customer_id, v_status
    from public.customers c
   where c.user_id = auth.uid();

  if v_customer_id is null then
    raise exception 'No customer record for the current user';
  end if;

  if coalesce(v_status, '') <> 'active' then
    raise exception
      'Goals are available with an active management subscription';
  end if;

  -- Clearing the goal clears its date: a deadline with no target is noise.
  update public.customers
     set management_customer_goal            = p_goal,
         management_customer_goal_due        = case when p_goal is null then null else p_due end,
         management_customer_goal_updated_at = now(),
         updated_at                          = now()
   where id = v_customer_id
  returning management_customer_goal,
            management_customer_goal_updated_at,
            management_customer_goal_due
       into goal, goal_updated_at, goal_due;

  if not found then
    raise exception 'Failed to update goal for customer %', v_customer_id;
  end if;

  return next;
end;
$$;

-- Its own grant: the one-argument function's grant does not carry over to a
-- new signature (invariant 7 — this is one of the few functions
-- `authenticated` may call, and it must stay callable).
revoke execute on function public.set_management_customer_goal(integer, date)
  from public, anon;
grant execute on function public.set_management_customer_goal(integer, date)
  to authenticated, service_role;

-- ===========================================================================
-- 4. Saved replies, on the table that was waiting for them
-- ===========================================================================

alter table public.message_templates
  add column if not exists title text;

comment on column public.message_templates.title is
  'What the operator sees in the composer''s picker. Null on any Stayful-'
  'provided template (customer_id is null), which the picker does not list.';

-- 'any' means "offer it in both composers". The two existing values keep their
-- meaning for the sequence engine, which never reads a customer snippet.
alter table public.message_templates
  drop constraint if exists message_templates_channel_check;
alter table public.message_templates
  add constraint message_templates_channel_check
  check (channel in ('email', 'whatsapp', 'any'));

-- A snippet body is pasted into a WhatsApp from a real person''s number, so it
-- gets the same ceiling every other operator-authored message has (480,
-- MAX_TEMPLATE_CHARS / HANDOFF_MAX_TEXT). Stayful-provided rows are exempt —
-- they are the sequence engine''s, not a snippet.
alter table public.message_templates
  drop constraint if exists message_templates_snippet_length_check;
alter table public.message_templates
  add constraint message_templates_snippet_length_check
  check (
    customer_id is null
    or (length(btrim(body_template)) between 1 and 480
        and title is not null
        and length(btrim(title)) between 1 and 60)
  );

-- Flagged by the advisor as an unindexed FK; the snippet picker lists by it.
create index if not exists message_templates_customer_idx
  on public.message_templates (customer_id)
  where customer_id is not null;
