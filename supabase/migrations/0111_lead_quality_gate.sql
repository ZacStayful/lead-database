-- 0111_lead_quality_gate.sql
--
-- Stops a lead with unusable contact details from ever being allocated.
--
-- Until now nothing checked. `ingestLead` writes whatever Monday or n8n hands
-- it — the management branch writes '' for every absent field rather than null —
-- and `autoAssignLead` sells the row minutes later. An operator pays £15 for a
-- landlord whose "mobile" is a Dubai landline, reject does not refund
-- (invariant 4), and we keep the money. That is the shape of a chargeback.
--
-- WHAT IS CHECKED, AND WHAT IS NOT
--
-- Syntax only: a name that reads as a person, a UK mobile in 07 form, an email
-- with a valid shape. This migration adds no vendor call and needs no new
-- environment variable. It cannot tell you the number is answered or the
-- mailbox exists — the privacy policy names Twilio Lookup and ZeroBounce for
-- that, neither is implemented, and adding one belongs behind the same columns
-- rather than inside them.
--
-- THE RULES LIVE IN TYPESCRIPT, ON PURPOSE
--
-- `src/lib/leadQuality.ts` is the single definition and this migration does NOT
-- restate it. Writing the normaliser twice is exactly the failure this codebase
-- keeps recording (§20's capture_operator_proof, §26.7's presentationSeed): two
-- copies that must change together, and silently do not. So the verdict is
-- computed in one place and written to these columns, and SQL only reads the
-- verdict. The backfill is `POST /api/admin/leads/quality-check`, which runs the
-- same function over existing rows.
--
-- The normaliser is worth one warning even so. 89 of the 193 live management
-- leads store the number as +44 followed by a FULL NATIONAL number
-- (+4407304208011). Anything that strips '+44' and prefixes '0' produces
-- 007304208011 and rejects 46% of the management book. Whatever reads these
-- columns must never re-derive them with a hand-rolled rule.
--
-- THREE STATUSES, AND WHY `pending` DOES NOT BLOCK
--
--   pending  never judged — predates this migration, or written by a path that
--            does not stamp.       DOES NOT BLOCK.
--   passed   checked, details usable.
--   failed   checked, `lead_quality_codes` says why.  BLOCKS, unless overridden.
--
-- `pending` is the default, so on apply all 437 existing leads keep flowing
-- exactly as they do today and this migration changes NO behaviour at all. That
-- is what makes the migration-before-code rule hold in its strong form. It is
-- also the safe direction if a future ingest path forgets to stamp: an unchecked
-- lead being sold is recoverable, an unchecked lead silently withheld is not.
--
-- The override is a SEPARATE column rather than a fourth status, so both facts
-- survive — what the checker thought, and what an admin decided. The same shape
-- `pool_excluded_at` takes beside `pool_entered_at`. Clearing the override
-- restores the block with no re-check needed.
--
-- WHERE THE GATE IS ENFORCED — BOTH PREDICATES, NOT ONE
--
-- `lead_retired_from_allocation()` carries it, which propagates with no further
-- edits to all three candidate functions, `get_next_customers_for_lead`,
-- `get_escalation_candidates` and `assign_lead_to_customer` UNDER ITS ROW LOCK,
-- so nothing can slip through a race between the candidate query and the sale.
--
-- ⚠️ `lead_pool_barred()` needs it TOO, and this is the trap. The two functions
-- are separate predicates that happen to agree about owned leads (§32.6 says so
-- explicitly). Without a clause here, a blocked lead that was never assigned
-- enters the expired pool on its 25th day and becomes claimable, for free, by
-- every subscriber of its product — the worst available outcome, because the
-- pool's whole pitch is that ringing the landlord costs nothing.
--
-- ⚠️ CREATE OR REPLACE DISCARDS A FUNCTION'S ACL. §11 records 0049 having to
-- re-grant after exactly this. Both functions are re-secured at the end.
--
-- ⚠️ WHY 0111 AND NOT 0109. Production carries two migrations that are NOT in
-- supabase/migrations/ — `swap_respects_lead_filter` and
-- `admin_assign_respects_lead_filter`, both applied 2026-08-27 — which the
-- bodies they rewrote number 0109 and 0110. This one takes the next free number
-- so a rebuild from the directory cannot collide with them. That drift is worth
-- closing separately: a schema built from this directory today does NOT have
-- the lead-filter guards those two added, and `worked_conversion` (2026-08-23)
-- is missing from the directory too.
--
-- It is also why `admin_assign_lead` is NOT rewritten here. That function was
-- last replaced by one of those uncommitted migrations, so copying its live body
-- into this file would either lose their change or fight it depending on apply
-- order. `admin_block_check_lead_quality()` below is the guard instead, called
-- by the admin assign routes before they invoke `admin_assign_lead` — the same
-- arrangement leadResale.ts uses for the cap writes SQL cannot see (§32.6).

begin;

-- ── 1. Columns ──────────────────────────────────────────────────────────────

alter table public.leads
  add column if not exists lead_quality_status text not null default 'pending',
  add column if not exists lead_quality_codes text[] not null default '{}',
  add column if not exists lead_quality_checked_at timestamptz,
  add column if not exists lead_quality_override_at timestamptz,
  add column if not exists lead_quality_override_by text,
  add column if not exists lead_quality_override_note text;

comment on column public.leads.lead_quality_status is
  'pending | passed | failed. Written from assessLeadQuality() in '
  'src/lib/leadQuality.ts, never re-derived in SQL. pending does not block.';
comment on column public.leads.lead_quality_override_at is
  'An admin decided to sell this lead despite a failed verdict. Kept separate '
  'from the status so both facts survive; clearing it restores the block.';

-- Dropped before being added, so a re-apply does not fail on "constraint
-- already exists" — the trap 0100 hit and §28.9 records.
alter table public.leads drop constraint if exists leads_quality_status_check;
alter table public.leads add constraint leads_quality_status_check
  check (lead_quality_status in ('pending', 'passed', 'failed'));

-- Serves the admin quarantine list and the two predicates below. Partial,
-- because the rows that matter are a single-digit percentage of the table.
create index if not exists idx_leads_quality_blocked
  on public.leads (lead_quality_status)
  where lead_quality_status = 'failed' and lead_quality_override_at is null;

-- Serves the backfill's "what has not been judged yet" page.
create index if not exists idx_leads_quality_pending
  on public.leads (created_at desc)
  where lead_quality_status = 'pending';

-- ── 2. The allocation predicate ─────────────────────────────────────────────
--
-- Body copied from 0108 with ONE clause added. Everything else is byte-for-byte
-- what production runs today, verified before this migration was written.

create or replace function public.lead_retired_from_allocation(p_lead_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    exists (
      select 1 from public.lead_assignments la
      where la.lead_id = p_lead_id
        and la.claimed_from_pool_at is not null
    )
    or exists (
      select 1 from public.leads l
      where l.id = p_lead_id
        and (
          l.pool_expired_at is not null
          or (l.pool_entered_at is not null and l.pool_entry_basis = 'ignored')
          -- An owned lead is retired UNTIL it qualifies. Qualification means a
          -- paid analysis came back with trustworthy figures (§32), and from
          -- that moment the lead is ordinary supply for exactly one more
          -- operator — so it has to leave this predicate, which is what every
          -- candidate function and the money path consult.
          --
          -- The pool is NOT relaxed with it: lead_pool_barred keeps its own
          -- `owner_customer_id is not null` clause, unchanged and deliberately
          -- so. The two functions used to agree by coincidence; from here they
          -- mean different things.
          or (
            l.owner_customer_id is not null
            and l.owner_resale_qualified_at is null
          )
          -- 0111. Contact details we have judged unusable. `pending` is absent
          -- from this test on purpose: an unjudged lead routes as it always did.
          or (
            l.lead_quality_status = 'failed'
            and l.lead_quality_override_at is null
          )
        )
    );
$$;

-- ── 3. The pool predicate ───────────────────────────────────────────────────
--
-- The one that is easy to forget. A blocked lead that was never assigned would
-- otherwise pool at day 25 and be claimable by the whole book.

create or replace function public.lead_pool_barred(p_lead_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    exists (
      select 1 from public.lead_notes n
      join public.lead_assignments la on la.id = n.lead_assignment_id
      where la.lead_id = p_lead_id
    )
    or exists (
      select 1 from public.lead_assignments la
      where la.lead_id = p_lead_id and la.status in ('in_discussion', 'won')
    )
    or exists (
      select 1 from public.lead_assignments la
      where la.lead_id = p_lead_id and la.closed_at is not null
    )
    or exists (
      select 1 from public.lead_assignments la
      where la.lead_id = p_lead_id
        and (
          (la.due_to_call_date is not null and la.due_to_call_date_set_at is null)
          or (la.income_estimate is not null and la.income_estimate_set_at is null)
        )
    )
    or exists (
      select 1 from public.leads l
      where l.id = p_lead_id
        and (
          l.withdrawn_at is not null
          or l.pool_expired_at is not null
          or l.pool_excluded_at is not null
          or l.owner_customer_id is not null
          -- 0111. Same clause, and it must be here as well as in
          -- lead_retired_from_allocation: a lead that was never assigned is not
          -- retired by anything above, so without this it pools on the
          -- `unassigned` basis and every subscriber can claim it.
          or (
            l.lead_quality_status = 'failed'
            and l.lead_quality_override_at is null
          )
        )
    );
$$;

-- ── 4. Admin force-assign ───────────────────────────────────────────────────
--
-- `admin_assign_lead` writes its own UPDATE and consults neither predicate, the
-- same gap 0102 had to close for owned leads. It refuses a blocked lead rather
-- than silently honouring it, and names the override so there is one verb for
-- "sell it anyway" and one place that records who said so.

create or replace function public.admin_block_check_lead_quality(p_lead_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from public.leads l
    where l.id = p_lead_id
      and l.lead_quality_status = 'failed'
      and l.lead_quality_override_at is null
  ) then
    raise exception
      'Lead % failed the contact-quality check. Override it on the lead page '
      'before assigning.', p_lead_id
      using errcode = 'check_violation';
  end if;
end;
$$;

-- ── 5. Grants ───────────────────────────────────────────────────────────────
--
-- ⚠️ MANDATORY AFTER ANY create or replace ON A PRIVILEGED FUNCTION. Replacing
-- a function discards its ACL and it reverts to PUBLIC EXECUTE; 0028 revoked
-- schema-wide, 0038 replaced a function and silently re-exposed it, and 0049
-- had to put it back (§11). Re-asserted rather than assumed.

revoke all on function public.lead_retired_from_allocation(uuid) from public, anon, authenticated;
revoke all on function public.lead_pool_barred(uuid) from public, anon, authenticated;
revoke all on function public.admin_block_check_lead_quality(uuid) from public, anon, authenticated;

grant execute on function public.lead_retired_from_allocation(uuid) to service_role;
grant execute on function public.lead_pool_barred(uuid) to service_role;
grant execute on function public.admin_block_check_lead_quality(uuid) to service_role;

commit;
