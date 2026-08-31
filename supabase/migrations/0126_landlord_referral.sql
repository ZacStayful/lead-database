-- ---------------------------------------------------------------------------
-- 0126 — The landlord referral email
--
-- Until now nothing in this codebase has ever emailed a landlord. §40 messaging
-- writes to them AS THE OPERATOR, from the operator's own WhatsApp number or
-- Resend domain; this is Stayful writing to them ABOUT the operator, at the
-- moment a lead is allocated.
--
-- ⚠️ IT IS NOT A NEW PRODUCT DECISION. The landing page already carries a mock
-- of this email under the badge "Your key differentiator" and asserts "Before
-- any assignment fires, the landlord gets a Stayful email introducing you.
-- They've consented. They're expecting your call."
-- /policies/lead-quality-and-data tells customers the same, and the privacy
-- policy makes it the LAWFUL BASIS for the whole referral (§5.1) and states
-- details are shared "only after the referral email described in section 5.1
-- has been sent" (§6), naming Resend as its processor. None of it existed.
--
-- ⚠️ FORWARD-ONLY, AND STRUCTURALLY SO. The send fires inside
-- completeAssignment(), which runs only when a lead is allocated to an
-- operator. Nothing here walks existing leads, and nothing may ever be added
-- that does: a landlord who enquired in July must not be written to because a
-- feature shipped in August.
--
-- This migration is INERT on its own. Every column is nullable or defaulted to
-- today's meaning, the kill switch ships 'false', and no existing function,
-- predicate or trigger is redefined. Nothing reads any of it until the code
-- lands.
-- ---------------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------------
-- 1 — What the landlord tells us, on the LEAD.
--
-- ⚠️ ON `leads`, NEVER ON `lead_assignments`, AND THAT IS THE WHOLE FAIRNESS
-- PROPERTY. There is exactly one copy, so two operators cannot hold different
-- answers and one cannot have them while another does not. 0014's
-- `leads_select_assigned` grants select on the whole row to any customer with
-- an assignment for it and is evaluated AT READ TIME, so an operator assigned
-- next month sees these the moment they are assigned — no backfill, no copying
-- forward, nothing to keep in step.
--
-- The landlord is asked ONCE, however many operators the lead reaches:
-- `landlord_referral_first_sent_at` is claimed under the lead row lock in
-- claim_landlord_referral() below.
-- ---------------------------------------------------------------------------
alter table public.leads
  add column if not exists landlord_referral_first_sent_at timestamptz,
  add column if not exists landlord_contact_method         text,
  add column if not exists landlord_contact_time           text,
  add column if not exists landlord_questions              text,
  add column if not exists landlord_wants                  text[],
  add column if not exists landlord_note                   text,
  add column if not exists landlord_prefs_step             smallint not null default 0,
  add column if not exists landlord_prefs_submitted_at     timestamptz;

comment on column public.leads.landlord_referral_first_sent_at is
  'When the FIRST operator introduction for this lead was claimed. Non-null means the three questions have already been asked and must not be asked again (0126).';
comment on column public.leads.landlord_prefs_step is
  'How far through the reveal deck the landlord got. Partial progress is kept deliberately: one answer is still worth having, and drop-off per step is measurable rather than guessed at (0126).';
comment on column public.leads.landlord_wants is
  'Multi-select chips from "what would you most like to know?". Qualification context for every operator holding the lead (0126).';

-- Each CHECK allows NULL, because absence is the normal state for every lead
-- that predates this and for every landlord who never answers.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'leads_landlord_contact_method_valid') then
    alter table public.leads add constraint leads_landlord_contact_method_valid
      check (landlord_contact_method is null
             or landlord_contact_method in ('whatsapp', 'email', 'phone'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'leads_landlord_contact_time_len') then
    alter table public.leads add constraint leads_landlord_contact_time_len
      check (landlord_contact_time is null or length(landlord_contact_time) <= 120);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'leads_landlord_questions_len') then
    alter table public.leads add constraint leads_landlord_questions_len
      check (landlord_questions is null or length(landlord_questions) <= 1000);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'leads_landlord_note_len') then
    alter table public.leads add constraint leads_landlord_note_len
      check (landlord_note is null or length(landlord_note) <= 1000);
  end if;
  -- Bounded rather than open: the chips are a fixed list, and an unbounded
  -- array on a row a public endpoint can write is a way to grow the table.
  if not exists (select 1 from pg_constraint where conname = 'leads_landlord_wants_bounded') then
    alter table public.leads add constraint leads_landlord_wants_bounded
      check (landlord_wants is null or cardinality(landlord_wants) <= 8);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'leads_landlord_prefs_step_range') then
    alter table public.leads add constraint leads_landlord_prefs_step_range
      check (landlord_prefs_step >= 0 and landlord_prefs_step <= 10);
  end if;
end $$;


-- ---------------------------------------------------------------------------
-- 2 — What we sent, per operator, on the ASSIGNMENT.
--
-- The row is already unique per (lead, customer) — 0001_init.sql:57 — so it is
-- the idempotency claim and no new table is needed.
--
-- ⚠️ `claimed_at` AND `sent_at` ARE SEPARATE ON PURPOSE. The claim is written
-- BEFORE the send (the credit_invoice discipline, §19.5: claim by write, never
-- check-then-act), so a single column stamped up front would later tell an
-- operator "the landlord was told about you" about an email that 429'd. The
-- lead page keys on `sent_at`. completeAssignment already draws exactly this
-- distinction with `email_sent: wantsNewLead && !emailError`.
--
-- `attempts` / `next_attempt_at` exist because of the rate limit: bulk assign
-- runs completeAssignment at NOTIFY_CONCURRENCY = 8, which with a second email
-- per assignment means sixteen concurrent Resend requests against a documented
-- 2/second limit (§21.3). A 429 must not mean the landlord is never introduced.
-- ---------------------------------------------------------------------------
alter table public.lead_assignments
  add column if not exists landlord_referral_claimed_at      timestamptz,
  add column if not exists landlord_referral_sent_at         timestamptz,
  add column if not exists landlord_referral_error           text,
  add column if not exists landlord_referral_attempts        smallint not null default 0,
  add column if not exists landlord_referral_next_attempt_at timestamptz;

comment on column public.lead_assignments.landlord_referral_claimed_at is
  'Claim-by-write, stamped BEFORE the send. Non-null means this assignment has been taken by a sender; it does not mean an email went (0126).';
comment on column public.lead_assignments.landlord_referral_sent_at is
  'Non-null ONLY when Resend accepted the referral. This is what the lead page reads before telling an operator the landlord was introduced (0126).';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'lead_assignments_landlord_referral_attempts_range') then
    alter table public.lead_assignments add constraint lead_assignments_landlord_referral_attempts_range
      check (landlord_referral_attempts >= 0 and landlord_referral_attempts <= 20);
  end if;
end $$;

-- Serves the retry sweep only: claimed, not yet sent, and due. Partial so it
-- indexes the handful of failures rather than every assignment ever made.
create index if not exists lead_assignments_landlord_referral_retry_idx
  on public.lead_assignments (landlord_referral_next_attempt_at)
  where landlord_referral_claimed_at is not null
    and landlord_referral_sent_at is null
    and landlord_referral_next_attempt_at is not null;


-- ---------------------------------------------------------------------------
-- 3 — The operator's own introduction.
--
-- There is no operator self-description anywhere in this codebase today:
-- draftContext.ts tells the model only `OPERATOR: ${contactName}, ${businessName}`.
-- This feeds the referral email AND buildDraftContext, so a landlord meets the
-- same operator in both.
--
-- 600 chars matches the `compliance` / `vetting` caps in presentationSettings.ts.
-- ---------------------------------------------------------------------------
alter table public.customers
  add column if not exists operator_intro            text,
  add column if not exists operator_intro_updated_at timestamptz;

comment on column public.customers.operator_intro is
  'A short operator self-introduction, shown to landlords in the referral email and fed to the WhatsApp drafter. Refused at save time if it mentions a fee: validateDraft PRICE_RE rejects any message quoting one, so an intro containing a price would silently fail every generated draft (0126).';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'customers_operator_intro_len') then
    alter table public.customers add constraint customers_operator_intro_len
      check (operator_intro is null or length(operator_intro) <= 600);
  end if;
end $$;


-- ---------------------------------------------------------------------------
-- 4 — The kill switch. SHIPS OFF.
--
-- This emails members of the public. `messaging_enabled` and
-- `messaging_sequences_enabled` both shipped false for the same reason, and the
-- reader fails closed (§40.3), so a missing row is also off.
-- ---------------------------------------------------------------------------
insert into public.system_settings (key, value)
values ('landlord_referral_enabled', 'false')
on conflict (key) do nothing;


-- ---------------------------------------------------------------------------
-- 5 — Claim the referral, and decide who asks the questions.
--
-- ⚠️ THE RACE THIS EXISTS FOR. autoAssignLead places a lead with up to three
-- customers, and bulk assign runs inChunks(..., NOTIFY_CONCURRENCY = 8, ...) in
-- bounded parallel. Two senders can therefore ask "am I the first?" at the same
-- instant. Answered here, under the lead row lock, so exactly one caller ever
-- sees `landlord_referral_first_sent_at` null — however many are assigned
-- together.
--
-- Returns (claimed, ask_questions):
--   claimed       false when another sender already took this assignment.
--   ask_questions true for exactly one assignment per lead, ever.
--
-- ⚠️ Takes the LEAD lock only, in its own transaction, and never touches
-- `customers`. assign_lead_to_customer locks lead then customer; a single lock
-- taken afterwards cannot deadlock against it.
-- ---------------------------------------------------------------------------
create or replace function public.claim_landlord_referral(p_assignment_id uuid)
returns table (claimed boolean, ask_questions boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead_id uuid;
  v_first   boolean := false;
  v_rows    integer;
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

  -- Only now, holding the lead lock and having won the assignment, decide
  -- whether this is the introduction that carries the questions.
  update public.leads
     set landlord_referral_first_sent_at = now()
   where id = v_lead_id
     and landlord_referral_first_sent_at is null;

  get diagnostics v_rows = row_count;
  v_first := v_rows > 0;

  return query select true, v_first;
end;
$$;

revoke execute on function public.claim_landlord_referral(uuid)
  from public, anon, authenticated;
grant execute on function public.claim_landlord_referral(uuid) to service_role;


-- ---------------------------------------------------------------------------
-- 6 — Give a claim back, when the failure is PERMANENT.
--
-- ⚠️ THE RULE DIFFERS BY FAILURE TYPE AND GETTING IT BACKWARDS IS A REAL BUG.
--
--   RETRYABLE (429, timeout, 5xx) — the caller KEEPS both stamps and schedules
--   a retry. It must NOT call this. Releasing the first-flag on a retryable
--   failure would let the NEXT operator's referral ask the questions as well,
--   and the landlord would be asked twice.
--
--   PERMANENT (Resend rejects the address) — this releases, so the next
--   operator's introduction carries the questions instead and the one chance to
--   ask them is not burned on an address that will never accept mail.
--
-- Same doctrine as §31.5: release an indeterminate claim, never finalise it —
-- with the addition that a retryable failure holds its claim precisely because
-- a retry is coming.
--
-- p_was_first must be the `ask_questions` value the claim returned. Passing it
-- rather than re-deriving it is deliberate: by now another assignment may have
-- claimed the lead, and "was I the one that stamped it" is not answerable from
-- the row afterwards.
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
       set landlord_referral_first_sent_at = null
     where id = v_lead_id;
  end if;
end;
$$;

revoke execute on function public.release_landlord_referral(uuid, boolean, text)
  from public, anon, authenticated;
grant execute on function public.release_landlord_referral(uuid, boolean, text)
  to service_role;

commit;
