-- ---------------------------------------------------------------------------
-- 0129 — Re-engaging a landlord who never answered (§41.1)
--
-- 0126 emails a landlord once, at allocation, and the FIRST operator's
-- introduction carries three questions behind a link to /p/<token>. Nothing
-- chases a landlord who does not answer, in either of the two ways they fail
-- to:
--
--   1. Received it, never answered. `landlord_referral_first_sent_at` is
--      stamped at CLAIM time — before the email is even attempted — so the
--      questions count as asked whether or not anyone read them. Every later
--      operator's referral comes through with ask_questions = false.
--   2. Started the deck, abandoned it. Each card POSTs as it is answered, so a
--      landlord who picks WhatsApp on card 1 and closes the tab leaves that one
--      answer and nothing invites them back.
--
-- Phase 4 of poll-whatsapp-status looks like a retry and is not one: it selects
-- `claimed_at is not null and sent_at is null`, so it only ever sees
-- introductions Resend NEVER ACCEPTED. A landlord who received the email and
-- ignored it is structurally invisible to it.
--
-- ⚠️ WHY THIS MATTERS MORE SINCE §42. `contactStrategy.firstAttemptChannel()`
-- now overrides attempt 1 of the five-attempt contact plan with the landlord's
-- stated channel, and says in terms: "Absence — which is every lead that
-- predates §41 and every landlord who never answered — leaves the default cold
-- call in place." An unanswered referral is no longer a missing display line;
-- it costs that landlord a cold call they might have asked not to have.
--
-- TWO MECHANISMS, and they are complementary:
--
--   A. RE-ASK ON THE NEXT ALLOCATION. claim_landlord_referral's rule widens
--      from "nobody has been asked" to "nobody has ANSWERED, we are under the
--      cap, and the last ask was long enough ago". It rides an allocation that
--      was happening anyway — no new send path, no new consent surface, and
--      forward-only by construction.
--
--   B. A REMINDER SWEEP. Two nudges, at 48h and 72h after a DELIVERED
--      introduction, driven by get_due_landlord_nudges() below.
--
-- ⚠️ B IS THE FIRST THING IN THIS FEATURE THAT WALKS EXISTING LEADS AND EMAILS
-- THEM, which 0126's own header and landlordReferral.ts both say must never be
-- added. It is admissible only because of `landlord_nudge_from`: seeded to the
-- apply instant, compared against `landlord_referral_first_sent_at`, and read
-- FAIL-CLOSED by the sweep. That is 0128's shape — "the daily prompt covers
-- leads assigned from this cutoff onward", Zac's rule — and it answers §32.4's
-- objection to a global cutoff (that it is "one bad read from enrolling the
-- entire back catalogue") by making an unreadable value mean nobody.
--
-- ⚠️ THE POPULATION IS NOT EMPTY AT APPLY TIME, and an earlier draft of this
-- header said it was. §41 went live on 2026-09-01 and delivered 20
-- introductions to 20 landlords between 11:01 and 11:02 UTC, with no failures
-- and — an hour later — no answers yet. Seeding the cutoff to the apply instant
-- therefore excludes that first cohort permanently, which is the SAFE reading
-- and not obviously the right one: they were introduced by this very feature,
-- today, and their 48-hour window has not opened.
--
-- The cutoff is left at the apply instant deliberately, because it is one
-- UPDATE to widen and nothing to undo if it goes out too far. Moving it back to
-- just before 2026-09-01T11:00:00Z is what enrols those 20.
--
-- ⚠️ THE REMINDER IS NOT AN OPERATOR APPROACH. 0127's landlord_approach_ok caps
-- approaches to one landlord at 1/day and 3/week, and its own header states the
-- rule this obeys: "Counts operator-generated contact only. `nudge_sent` and
-- `message_received` are excluded for the §3 reason — our own reminders and the
-- landlord's own reply are not approaches by anybody." So nothing here calls
-- that function, and nothing here writes an event in its counted set
-- ('tel_click','whatsapp_click','mailto_click','message_sent'). A Stayful email
-- about who is going to ring must never eat an operator's ration.
--
-- INERT ON ITS OWN. Every column defaults to today's meaning — ask_count 0 and
-- last_asked_at null reproduce the current `first_sent_at is null` decision
-- exactly — the switch ships 'false', and the cutoff is seeded to now. Nothing
-- here touches a balance, counter, pacing or capacity column, so a lagging
-- migration cannot affect lead allocation.
-- ---------------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------------
-- 1 — What we have asked, and what we have chased. On the LEAD.
--
-- On `leads` for 0126's stated reason: there is exactly one copy, so two
-- operators cannot disagree about whether this landlord has been asked, and
-- 0014's `leads_select_assigned` shares it with every holder at read time.
--
-- TWO COUNTERS, NOT ONE, because they bound different acts. `ask_count` bounds
-- INTRODUCTIONS that carried the questions (mechanism A); `nudge_count` bounds
-- REMINDERS (mechanism B). One shared counter would mean a lead that took both
-- reminders could never be re-asked by a second operator, which is mechanism A
-- switched off by mechanism B.
-- ---------------------------------------------------------------------------
alter table public.leads
  add column if not exists landlord_prefs_ask_count     smallint not null default 0,
  add column if not exists landlord_prefs_last_asked_at timestamptz,
  add column if not exists landlord_prefs_nudge_count   smallint not null default 0,
  add column if not exists landlord_prefs_nudge_sent_at timestamptz,
  add column if not exists landlord_prefs_nudge_error   text;

comment on column public.leads.landlord_prefs_ask_count is
  'How many operator introductions have carried the three questions. Caps re-asking at 3, and is decremented by release_landlord_referral so a bounced address never burns an ask (0129).';
comment on column public.leads.landlord_prefs_last_asked_at is
  'Anchors the re-ask floor. Load-bearing: autoAssignLead places a lead with up to three operators in ONE sequential pass, so without a time floor a single fan-out would send three emails all carrying the same questions (0129).';
comment on column public.leads.landlord_prefs_nudge_count is
  'Reminders sent, 0-2. Claimed by write before the send, released only on a retryable failure (0129).';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'leads_landlord_prefs_ask_count_range') then
    alter table public.leads add constraint leads_landlord_prefs_ask_count_range
      check (landlord_prefs_ask_count >= 0 and landlord_prefs_ask_count <= 5);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'leads_landlord_prefs_nudge_count_range') then
    alter table public.leads add constraint leads_landlord_prefs_nudge_count_range
      check (landlord_prefs_nudge_count >= 0 and landlord_prefs_nudge_count <= 2);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'leads_landlord_prefs_nudge_error_len') then
    alter table public.leads add constraint leads_landlord_prefs_nudge_error_len
      check (landlord_prefs_nudge_error is null or length(landlord_prefs_nudge_error) <= 500);
  end if;
end $$;

-- Serves the sweep only. Partial so it indexes the handful of leads still open
-- to a reminder rather than every lead ever ingested.
create index if not exists leads_landlord_nudge_due_idx
  on public.leads (landlord_referral_first_sent_at, landlord_prefs_nudge_sent_at)
  where landlord_prefs_nudge_count < 2
    and landlord_referral_first_sent_at is not null;


-- ---------------------------------------------------------------------------
-- 2 — Settings.
--
-- ⚠️ THE SWITCH IS SEPARATE FROM `landlord_referral_enabled`, and that is the
-- point rather than tidiness: it is what lets the introduction run on its own
-- for a fortnight and the reminder be turned on afterwards, once
-- `landlord_prefs_step` has real drop-off data behind it instead of a guess.
--
-- The four tunables join /admin/messaging's allow-list (§42's precedent, which
-- put five non-messaging keys there rather than build a second list).
-- `landlord_nudge_from` deliberately does NOT: it is a date, set once at
-- go-live, and 0128 states the same position for `contact_notify_from` —
-- "a date would need a third field kind for a value that is set once at go-live
-- and then never touched". Moving it is a SQL edit, on purpose.
-- ---------------------------------------------------------------------------
insert into public.system_settings (key, value) values
  ('landlord_referral_nudge_enabled',   'false'),
  ('landlord_prefs_nudge_first_hours',  '48'),
  ('landlord_prefs_nudge_second_hours', '72'),
  ('landlord_prefs_reask_days',         '7')
on conflict (key) do nothing;

-- Seeded to the apply instant, so a fresh build chases nobody until leads start
-- arriving — the safe direction, and the one `landlord_referral_nudge_enabled
-- = false` also picks. Same ISO shape as `contact_notify_from`.
insert into public.system_settings (key, value)
values ('landlord_nudge_from', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
on conflict (key) do nothing;


-- ---------------------------------------------------------------------------
-- 3 — Mechanism A: the ask rule widens.
--
-- Identical to 0126's function in every respect but the ask decision: same
-- signature, same lead row lock, same claim-by-write order (§19.5).
--
-- ⚠️ UNANSWERED IS TESTED ON THE SPINE COLUMNS, NOT ON
-- `landlord_prefs_submitted_at`. That column is stamped by ANY single answer,
-- so gating on it would abandon exactly the partial-answer case this exists
-- for — a landlord who picked a contact method on card 1 and stopped would
-- read as "answered" and never be asked the rest.
--
-- ⚠️ THE RE-ASK FLOOR IS LOAD-BEARING, NOT COSMETIC. autoAssignLead places a
-- lead with up to three operators in one SEQUENTIAL pass (ingest.ts), so
-- without a time floor that single fan-out sends three emails all carrying the
-- same questions — the exact failure 0126's once-only design exists to prevent.
-- 7 days blocks a same-day fan-out and admits the day-10 escalation, which is
-- the split we want.
--
-- The cap is 3, so a landlord who never engages is asked at most three times
-- across the whole life of the lead, each time inside an introduction they were
-- going to receive anyway.
-- ---------------------------------------------------------------------------
create or replace function public.claim_landlord_referral(p_assignment_id uuid)
returns table (claimed boolean, ask_questions boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead_id     uuid;
  v_first       boolean := false;
  v_rows        integer;
  v_reask_days  integer;
begin
  select la.lead_id into v_lead_id
    from public.lead_assignments la
   where la.id = p_assignment_id;

  if v_lead_id is null then
    return query select false, false;
    return;
  end if;

  -- The lock. Everything below is serialised per lead.
  perform 1 from public.leads where id = v_lead_id for update;

  update public.lead_assignments
     set landlord_referral_claimed_at = now(),
         landlord_referral_attempts   = landlord_referral_attempts + 1
   where id = p_assignment_id
     and landlord_referral_claimed_at is null;

  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    return query select false, false;
    return;
  end if;

  -- A missing or unparseable floor reads as the default rather than as zero.
  -- Zero would remove the floor entirely, which is the one value that breaks
  -- the fan-out guarantee above.
  select coalesce(nullif(regexp_replace(s.value, '[^0-9]', '', 'g'), '')::integer, 7)
    into v_reask_days
    from public.system_settings s
   where s.key = 'landlord_prefs_reask_days';
  v_reask_days := coalesce(v_reask_days, 7);

  -- Only now, holding the lead lock and having won the assignment, decide
  -- whether this introduction carries the questions.
  update public.leads l
     set landlord_referral_first_sent_at =
           coalesce(l.landlord_referral_first_sent_at, now()),
         landlord_prefs_ask_count     = l.landlord_prefs_ask_count + 1,
         landlord_prefs_last_asked_at = now()
   where l.id = v_lead_id
     -- Unanswered: the spine, never `landlord_prefs_submitted_at`.
     and (l.landlord_contact_method is null
          or l.landlord_contact_time is null
          or l.landlord_wants is null)
     and l.landlord_prefs_ask_count < 3
     and (l.landlord_referral_first_sent_at is null
          or l.landlord_prefs_last_asked_at is null
          or l.landlord_prefs_last_asked_at < now() - make_interval(days => v_reask_days));

  get diagnostics v_rows = row_count;
  v_first := v_rows > 0;

  return query select true, v_first;
end;
$$;

revoke execute on function public.claim_landlord_referral(uuid)
  from public, anon, authenticated;
grant execute on function public.claim_landlord_referral(uuid) to service_role;


-- ---------------------------------------------------------------------------
-- 4 — Releasing must give the ASK back too.
--
-- ⚠️ 0126's version only nulled `first_sent_at`. With a counter and a floor that
-- is no longer enough: a permanently-bounced address would burn one of the
-- three asks AND hold the lead quiet for a week, over an email that never went.
--
-- The failure-type asymmetry 0126 documents is unchanged and still the rule:
-- RETRYABLE keeps both stamps and schedules a retry (releasing would let the
-- next operator ask the same landlord twice); PERMANENT releases, so the next
-- operator's introduction carries the questions instead.
-- ---------------------------------------------------------------------------
create or replace function public.release_landlord_referral(
  p_assignment_id uuid,
  p_was_first     boolean,
  p_error         text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead_id uuid;
begin
  select la.lead_id into v_lead_id
    from public.lead_assignments la
   where la.id = p_assignment_id;

  if v_lead_id is null then
    return;
  end if;

  perform 1 from public.leads where id = v_lead_id for update;

  -- The error is kept. The row is the record that we tried, which is a
  -- different fact from never having tried (§21.2).
  update public.lead_assignments
     set landlord_referral_claimed_at      = null,
         landlord_referral_next_attempt_at = null,
         landlord_referral_error           = left(coalesce(p_error, 'failed'), 500)
   where id = p_assignment_id;

  if p_was_first then
    update public.leads
       set landlord_referral_first_sent_at = null,
           -- greatest() so a release can never drive the counter negative past
           -- its CHECK, however the caller arrived here.
           landlord_prefs_ask_count     = greatest(landlord_prefs_ask_count - 1, 0),
           landlord_prefs_last_asked_at = null
     where id = v_lead_id;
  end if;
end;
$$;

revoke execute on function public.release_landlord_referral(uuid, boolean, text)
  from public, anon, authenticated;
grant execute on function public.release_landlord_referral(uuid, boolean, text)
  to service_role;


-- ---------------------------------------------------------------------------
-- 5 — Mechanism B: which leads are due a reminder.
--
-- ⚠️ THIS IS A FUNCTION BECAUSE THE QUESTION CANNOT BE ASKED IN POSTGREST.
-- The conditions span SIBLING assignments — some assignment delivered, NO
-- assignment contacted — and a PostgREST filter on a to-many embedded resource
-- matches ANY row, never "none of them". §27.8 records what the near-miss costs
-- there: a 200 that paginates normally and is wrong. Answered set-wise here
-- instead, in one statement.
--
-- ⚠️ ANCHORED ON `landlord_referral_sent_at`, NOT `first_sent_at`. The latter is
-- stamped at claim, so it does not prove delivery — chasing off it would email
-- "did you see our introduction?" to somebody who never got one. Using the
-- delivered stamp also means a lead still sitting in Phase 4's retry queue can
-- never be nudged, with no coordination between the two phases.
--
-- ⚠️ THE CUTOFF FAILS CLOSED. A missing or unparseable `landlord_nudge_from`
-- yields NULL, the comparison yields NULL, and no lead qualifies. That is what
-- makes a global cutoff safe here where §32.4 rejected one.
--
-- The referable test is deliberately COARSE — an address that is present and
-- contains an '@', and not a customer-owned lead. `shouldReferLandlord` in
-- TypeScript is the authority and is re-run before every send; restating
-- EMAIL_RE in SQL would be a second definition of a rule that already has one.
-- ---------------------------------------------------------------------------
create or replace function public.get_due_landlord_nudges(p_limit integer default 25)
returns table (
  lead_id      uuid,
  customer_id  uuid,
  nudge_count  smallint,
  prefs_step   smallint,
  delivered_at timestamptz,
  nudge_sent_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with cutoff as (
    -- ⚠️ The shape is checked BEFORE the cast. A bare `value::timestamptz`
    -- RAISES on a malformed row, which would make the whole sweep error rather
    -- than chase nobody — the opposite of the fail-closed behaviour the cutoff
    -- exists for. An unrecognised value yields NULL, and the comparison below
    -- then matches no lead.
    select case
             when s.value ~ '^\d{4}-\d{2}-\d{2}' then s.value::timestamptz
             else null
           end as from_at
      from public.system_settings s
     where s.key = 'landlord_nudge_from'
  ),
  hours as (
    select
      coalesce(max(case when s.key = 'landlord_prefs_nudge_first_hours'
                        then nullif(regexp_replace(s.value, '[^0-9]', '', 'g'), '')::integer end), 48) as first_h,
      coalesce(max(case when s.key = 'landlord_prefs_nudge_second_hours'
                        then nullif(regexp_replace(s.value, '[^0-9]', '', 'g'), '')::integer end), 72) as second_h
      from public.system_settings s
  ),
  delivered as (
    -- The earliest introduction we know Resend accepted, and the operator whose
    -- introduction it was — so the reminder names the right person.
    select distinct on (la.lead_id)
           la.lead_id,
           la.customer_id,
           la.landlord_referral_sent_at as delivered_at
      from public.lead_assignments la
     where la.landlord_referral_sent_at is not null
     order by la.lead_id, la.landlord_referral_sent_at asc
  )
  select l.id,
         d.customer_id,
         l.landlord_prefs_nudge_count,
         l.landlord_prefs_step,
         d.delivered_at,
         l.landlord_prefs_nudge_sent_at
    from public.leads l
    join delivered d on d.lead_id = l.id
   cross join cutoff c
   cross join hours h
   where
     -- The spine is unfinished. Never `landlord_prefs_submitted_at`.
     (l.landlord_contact_method is null
      or l.landlord_contact_time is null
      or l.landlord_wants is null)
     -- Forward-only. NULL cutoff => no rows, which is the fail-closed direction.
     and l.landlord_referral_first_sent_at >= c.from_at
     and l.landlord_prefs_nudge_count < 2
     -- Still worth writing to at all (§30: an owned lead never enquired with us).
     and l.owner_customer_id is null
     and coalesce(l.email, '') <> ''
     and position('@' in l.email) > 1
     -- Nobody has rung. This is the user's chosen stop: once the operator has
     -- made contact the warm-up happened live, and asking how they would like
     -- to be contacted reads as noise.
     and not exists (
       select 1 from public.lead_assignments a
        where a.lead_id = l.id and a.first_contacted_at is not null
     )
     -- Settled, either way.
     and not exists (
       select 1 from public.lead_assignments a
        where a.lead_id = l.id and a.status in ('won', 'rejected')
     )
     and not public.lead_is_closed(l.id)
     -- Due: 48h from delivery for the first, 72h from delivery for the second.
     --
     -- ⚠️ THE SECOND ALSO REQUIRES A MINIMUM GAP SINCE THE FIRST. Both windows
     -- are measured from delivery, so a first reminder held back by quiet hours
     -- or a failed run can land at 71h — and the 72h test alone would then send
     -- the second an hour later. Two emails an hour apart to a member of the
     -- public who has already ignored one is the shape this must never take.
     and (
       (l.landlord_prefs_nudge_count = 0
        and d.delivered_at <= now() - make_interval(hours => h.first_h))
       or
       (l.landlord_prefs_nudge_count = 1
        and l.landlord_prefs_nudge_sent_at is not null
        and d.delivered_at <= now() - make_interval(hours => h.second_h)
        and l.landlord_prefs_nudge_sent_at <= now() - interval '12 hours')
     )
   order by d.delivered_at asc
   limit greatest(coalesce(p_limit, 25), 0);
$$;

revoke execute on function public.get_due_landlord_nudges(integer)
  from public, anon, authenticated;
grant execute on function public.get_due_landlord_nudges(integer) to service_role;


-- ---------------------------------------------------------------------------
-- 6 — Claim a reminder before sending it.
--
-- The credit_invoice discipline (§19.5) and the `pause_ending_notice_sent_at`
-- shape (§21): claim by write, THEN send. Checking whether we have already
-- chased and then chasing leaves a window; claiming does not. The sweep runs
-- every five minutes and a long run can overlap its successor, so the race is
-- ordinary rather than theoretical.
-- ---------------------------------------------------------------------------
create or replace function public.claim_landlord_nudge(p_lead_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
begin
  update public.leads
     set landlord_prefs_nudge_count   = landlord_prefs_nudge_count + 1,
         landlord_prefs_nudge_sent_at = now(),
         landlord_prefs_nudge_error   = null
   where id = p_lead_id
     and landlord_prefs_nudge_count < 2;

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

revoke execute on function public.claim_landlord_nudge(uuid)
  from public, anon, authenticated;
grant execute on function public.claim_landlord_nudge(uuid) to service_role;


-- ---------------------------------------------------------------------------
-- 7 — Give a reminder back, on a RETRYABLE failure only.
--
-- ⚠️ THIS IS THE OPPOSITE ASYMMETRY TO release_landlord_referral, AND THE
-- DIFFERENCE IS REAL RATHER THAN AN INCONSISTENCY.
--
-- There, a retryable failure KEEPS its claim, because another sender exists and
-- releasing would let them ask the same landlord the same questions twice.
--
-- Here there is no other sender. Releasing simply means "try again next run",
-- and the 48h/72h windows bound how long that can go on — once the lead falls
-- past its window it stops being due and the query never returns it again. A
-- PERMANENT failure keeps the count consumed and records the error, so a
-- rejected address is not chased twice more.
-- ---------------------------------------------------------------------------
create or replace function public.release_landlord_nudge(
  p_lead_id uuid,
  p_error   text
)
returns void
language sql
security definer
set search_path = public
as $$
  update public.leads
     set landlord_prefs_nudge_count   = greatest(landlord_prefs_nudge_count - 1, 0),
         landlord_prefs_nudge_sent_at = null,
         landlord_prefs_nudge_error   = left(coalesce(p_error, 'failed'), 500)
   where id = p_lead_id;
$$;

revoke execute on function public.release_landlord_nudge(uuid, text)
  from public, anon, authenticated;
grant execute on function public.release_landlord_nudge(uuid, text) to service_role;

commit;
