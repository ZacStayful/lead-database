-- ============================================================================
-- 0073 — Expired leads pool (schema, eligibility, daily sweep).
--
-- A third and final rung on the distribution ladder. Initial allocation places
-- a lead with up to max_assignments operators; inactivity escalation (0062)
-- adds one more at day 10 and again at day 20; this opens the lead to EVERY
-- subscriber of its product at day 25, to call and — if the landlord is still
-- interested — claim.
--
-- Phase 1 is schema only. The claim function, the billing debit and the
-- customer-facing surface land in 0074+ / later phases. What is here:
--   * columns (customers, leads, lead_assignments)
--   * the two missing engagement timestamps (see §3)
--   * pool eligibility, exit and expiry as SQL functions
--   * sweep_lead_pool(), driven by a new daily cron
--   * pooled-lead guards on all four allocation-facing functions
--   * the escalation age gate moved onto the allocation clock (see §7)
--
-- ---------------------------------------------------------------------------
-- §1 — TWO BASES FOR ENTRY, AND ONLY ONE OF THEM IS TERMINAL
-- ---------------------------------------------------------------------------
-- The brief's rule is "a pooled lead can never be re-allocated by the normal
-- assignment system" (invariant 7). That is right for a lead that has been
-- round its operators and been ignored: it is at end of life, and selling it a
-- fourth time through ordinary routing is what makes a lead source look bad.
--
-- It is wrong for a lead that has NEVER BEEN SENT TO ANYBODY. At the time of
-- writing 211 of 230 guaranteed-rent leads have never been assigned — not
-- because operators ignored them, but because GR has two subscribers and no
-- capacity to absorb the volume. Those leads are unsold stock, not dead stock.
-- Retiring them from allocation on their 25th day would hand the next GR
-- subscriber an allocation with an empty book behind it: 174 leads would exist,
-- all of them claim-only, none of them allocatable against the £150 a month
-- that new subscriber pays.
--
-- So entry carries a BASIS, and the basis decides whether entry is terminal:
--
--   'ignored'    — the lead was assigned, and nobody worked it. Pooling is
--                  terminal. Invariant 7 applies in full.
--   'unassigned' — the lead was never assigned to anyone. It sits in the pool
--                  AND stays in ordinary allocation. Whichever happens first
--                  wins: allocated normally, it leaves the pool; claimed, it
--                  leaves the inventory.
--
-- An 'unassigned' lead that is allocated and then ignored re-enters 25 days
-- later as 'ignored', at which point it is terminal like any other. The ladder
-- is coherent in both directions.
--
-- ---------------------------------------------------------------------------
-- §2 — THE DEATH CLOCK IS ANCHORED SEPARATELY FROM THE ENTRY CLOCK
-- ---------------------------------------------------------------------------
-- A lead leaves the pool when somebody engages with it, and re-enters 25 days
-- later if they then go quiet. The 90-day life cap must NOT restart on that
-- second entry — otherwise a lead alternately touched and abandoned lives
-- forever. pool_first_entered_at is stamped once and never cleared;
-- pool_entered_at is the current tenancy and is cleared on exit. The cap is
-- measured from the former.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1 — Settings. Same shape as the escalation switches (0062) so both ladders
-- are tuned from the same admin surface without a deploy.
--
-- pool_enabled is checked by the cron FIRST, which logs a skipped run rather
-- than silently doing nothing — the failure mode 0062 was written to avoid.
-- ---------------------------------------------------------------------------
insert into public.system_settings (key, value)
  values ('pool_enabled', 'true')
  on conflict (key) do nothing;

insert into public.system_settings (key, value)
  values ('pool_entry_days', '25')
  on conflict (key) do nothing;

insert into public.system_settings (key, value)
  values ('pool_life_days', '90')
  on conflict (key) do nothing;


-- ---------------------------------------------------------------------------
-- 2 — customers: the pool debit, per product.
--
-- A claim at zero balance still succeeds. It cannot take lead_balance negative
-- (invariant 1), so the shortfall is recorded here and settled against the next
-- renewal grant. CHECK >= 0 because a negative debit would be a credit by
-- another name, and credits already have a column.
--
-- No management/GR asymmetry: both products can be claimed from, so both get a
-- debit (invariant 3). Unlike the goal columns (§13), there is no argument for
-- a management-only version — the mechanic is identical on both sides.
-- ---------------------------------------------------------------------------
alter table public.customers
  add column if not exists pool_debit    integer not null default 0,
  add column if not exists gr_pool_debit integer not null default 0;

alter table public.customers
  drop constraint if exists customers_pool_debit_check;
alter table public.customers
  add constraint customers_pool_debit_check check (pool_debit >= 0);

alter table public.customers
  drop constraint if exists customers_gr_pool_debit_check;
alter table public.customers
  add constraint customers_gr_pool_debit_check check (gr_pool_debit >= 0);

comment on column public.customers.pool_debit is
  'Management leads claimed from the expired pool while lead_balance was zero. '
  'Subtracted from the next invoice.paid grant, floored at zero, remainder '
  'carries. Also subtracted from expected pacing — a debited customer is not '
  'behind, they have already had the leads.';

comment on column public.customers.gr_pool_debit is
  'Guaranteed-rent mirror of pool_debit. Never touched by a management claim.';


-- ---------------------------------------------------------------------------
-- 3 — lead_assignments: the claim marker, and the two missing timestamps.
--
-- WHY due_to_call_date_set_at / income_estimate_set_at EXIST
--
-- The brief counts "operator set a due-to-call date" and "operator set an
-- income estimate" as engagement. Both columns store a VALUE and no date, so
-- they can answer "has somebody touched this" but not "when" — and the pool
-- clock needs a when. Without these two columns the fields could only ever be a
-- permanent exclusion, which is a blunter rule than the brief asks for.
--
-- Stamped by trigger (section 4) rather than by the PATCH route, because the
-- route is not the only writer: admin surfaces and any future import would
-- bypass an application-level stamp and silently produce a row whose value has
-- no date. A trigger cannot be bypassed.
--
-- Existing rows get NULL, which is honest — we genuinely do not know when those
-- were entered. Eligibility treats "value present, timestamp absent" as a
-- permanent exclusion (section 5), so a legacy lead somebody was working is
-- never pooled out from under them on the strength of a date we do not have.
-- That set shrinks to nothing as leads turn over.
-- ---------------------------------------------------------------------------
alter table public.lead_assignments
  add column if not exists claimed_from_pool_at    timestamptz,
  add column if not exists due_to_call_date_set_at timestamptz,
  add column if not exists income_estimate_set_at  timestamptz;

comment on column public.lead_assignments.claimed_from_pool_at is
  'Set when this assignment was created by a claim from the expired leads pool. '
  'Null on every ordinary, escalated or admin-forced assignment. A lead with any '
  'claimed assignment is permanently out of ordinary allocation (invariant 7).';

comment on column public.lead_assignments.due_to_call_date_set_at is
  'When due_to_call_date was last written. Trigger-maintained. Null on rows that '
  'predate 0073, including rows that already carry a due_to_call_date.';

comment on column public.lead_assignments.income_estimate_set_at is
  'When income_estimate was last written. Trigger-maintained. Null on rows that '
  'predate 0073, including rows that already carry an income_estimate.';


-- ---------------------------------------------------------------------------
-- 4 — leads: pool state.
--
-- pool_entry_basis is NOT derivable at read time from assignment_count. An
-- 'unassigned' lead that is later allocated has assignment_count > 0 while
-- still carrying its original basis, and the difference decides whether
-- ordinary routing may touch it. It has to be stored at the moment of entry.
-- ---------------------------------------------------------------------------
alter table public.leads
  add column if not exists pool_entered_at       timestamptz,
  add column if not exists pool_first_entered_at timestamptz,
  add column if not exists pool_expired_at       timestamptz,
  add column if not exists pool_entry_basis      text;

alter table public.leads
  drop constraint if exists leads_pool_entry_basis_check;
alter table public.leads
  add constraint leads_pool_entry_basis_check
  check (pool_entry_basis is null or pool_entry_basis in ('unassigned', 'ignored'));

comment on column public.leads.pool_entered_at is
  'Current pool tenancy. Null when the lead is not in the pool. Cleared on '
  'engagement (or on ordinary allocation, for an unassigned-basis lead) and set '
  'again if the lead goes quiet for another pool_entry_days.';

comment on column public.leads.pool_first_entered_at is
  'First ever pool entry. Never cleared. Anchors the 90-day life cap so that '
  'leaving and re-entering the pool cannot extend a lead''s life indefinitely.';

comment on column public.leads.pool_expired_at is
  'Life cap reached. Hidden from every pool permanently and never re-allocated.';

comment on column public.leads.pool_entry_basis is
  'Why the lead pooled. ''ignored'' = it was assigned and nobody worked it; '
  'pooling is terminal for ordinary allocation. ''unassigned'' = it was never '
  'sent to anyone; it stays allocatable and leaves the pool if it is placed.';

create index if not exists idx_leads_pool_entered
  on public.leads(pool_entered_at)
  where pool_entered_at is not null;

create index if not exists idx_leads_pool_open
  on public.leads(lead_type, pool_entered_at)
  where pool_entered_at is not null and pool_expired_at is null;

create index if not exists idx_lead_assignments_claimed
  on public.lead_assignments(lead_id)
  where claimed_from_pool_at is not null;


-- ---------------------------------------------------------------------------
-- 5 — Stamp the two new timestamps.
--
-- `is distinct from` rather than `<>` so a NULL -> value transition is caught:
-- setting a due-to-call date for the first time is exactly the case that
-- matters, and `<>` returns NULL (falsy) for it.
--
-- CLEARING a field also stamps. Wiping a call date is a deliberate act on the
-- lead and is as much evidence of work as setting one; treating it as silence
-- would let an operator clear a field and have the lead pool 25 days later
-- while they were actively managing it.
--
-- RECURSION: this is a BEFORE trigger assigning to NEW, not an UPDATE against
-- the table, so it cannot re-fire. The OF clause narrows it to the two columns.
-- ---------------------------------------------------------------------------
create or replace function public.stamp_assignment_field_times()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.due_to_call_date is distinct from old.due_to_call_date then
    new.due_to_call_date_set_at := now();
  end if;

  if new.income_estimate is distinct from old.income_estimate then
    new.income_estimate_set_at := now();
  end if;

  return new;
end;
$$;

drop trigger if exists trg_stamp_assignment_field_times on public.lead_assignments;
create trigger trg_stamp_assignment_field_times
  before update of due_to_call_date, income_estimate on public.lead_assignments
  for each row
  execute function public.stamp_assignment_field_times();


-- ---------------------------------------------------------------------------
-- 6 — Pool settings reader. One place, so the sweep and the reporting views
-- cannot disagree about what 25 means.
-- ---------------------------------------------------------------------------
create or replace function public.pool_setting_int(p_key text, p_default integer)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    nullif(btrim((select value from public.system_settings where key = p_key)), '')::integer,
    p_default
  );
$$;


-- ---------------------------------------------------------------------------
-- 7 — Last activity on a lead, across every assignee.
--
-- The clock basis, per the brief: the LATER of the lead's most recent
-- assignment and the most recent engagement on any of its assignments. A
-- customer who receives a lead on day 20 via escalation gets a full 25 days
-- before it can pool, because their assigned_at is in the greatest().
--
-- Never assigned to anyone: falls back to leads.created_at.
--
-- WHAT COUNTS, and why lead_events is filtered:
-- every operator-generated event type counts, and 'nudge_sent' does not. It is
-- system-generated (CLAUDE.md §3) — counting it would let our own reminder
-- emails keep resetting the clock on the leads nobody is touching, which is
-- precisely inverted.
--
-- viewed_at is included even though CLAUDE.md §11 warns it is not telemetry.
-- Here that warning does not bite: viewed_at being set is always real evidence
-- of a human expanding the card. Its weakness is the other direction (a lead
-- read via a direct link leaves it null), and detail_opened covers that.
-- ---------------------------------------------------------------------------
create or replace function public.lead_last_activity_at(p_lead_id uuid)
returns timestamptz
language sql
stable
security definer
set search_path = public
as $$
  select greatest(
    (select l.created_at from public.leads l where l.id = p_lead_id),
    (select max(greatest(
        la.assigned_at,
        coalesce(la.viewed_at,               '-infinity'::timestamptz),
        coalesce(la.last_status_change_at,   '-infinity'::timestamptz),
        coalesce(la.first_contacted_at,      '-infinity'::timestamptz),
        coalesce(la.due_to_call_date_set_at, '-infinity'::timestamptz),
        coalesce(la.income_estimate_set_at,  '-infinity'::timestamptz)
      ))
      from public.lead_assignments la
      where la.lead_id = p_lead_id),
    (select max(e.created_at)
      from public.lead_events e
      join public.lead_assignments la on la.id = e.assignment_id
      where la.lead_id = p_lead_id
        and e.event_type <> 'nudge_sent'),
    (select max(n.created_at)
      from public.lead_notes n
      join public.lead_assignments la on la.id = n.lead_assignment_id
      where la.lead_id = p_lead_id),
    (select max(f.created_at)
      from public.lead_files f
      join public.lead_assignments la on la.id = f.lead_assignment_id
      where la.lead_id = p_lead_id)
  );
$$;


-- ---------------------------------------------------------------------------
-- 8 — Permanent exclusions.
--
-- A lead matching any of these is never pool-eligible at any age, and is never
-- offered even if it is quiet for a year.
--
--   note written        — somebody built something on this lead
--   in_discussion / won — a live or closed conversation exists
--   closed (0067)       — an operator reported the LANDLORD as done. Not in the
--                         brief, but selling a landlord who has already said no
--                         is the exact outcome the close feature exists to
--                         prevent, and the pool would be a new way to do it.
--   withdrawn (0059)    — an admin pulled the lead from circulation on a swap
--   legacy field values — a due-to-call date or income estimate with no
--                         timestamp (section 3): we cannot date the work, so we
--                         do not gamble on it being old
-- ---------------------------------------------------------------------------
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
      where la.lead_id = p_lead_id
        and la.status in ('in_discussion', 'won')
    )
    or exists (
      select 1 from public.lead_assignments la
      where la.lead_id = p_lead_id
        and la.closed_at is not null
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
        and (l.withdrawn_at is not null or l.pool_expired_at is not null)
    );
$$;


-- ---------------------------------------------------------------------------
-- 9 — Is this lead retired from ORDINARY allocation?
--
-- Invariant 7, expressed once so the four allocation-facing functions cannot
-- drift apart. True when:
--   * somebody has claimed it from the pool — it belongs to them now, and no
--     amount of subsequent capacity should hand it to anyone else; or
--   * it pooled on the 'ignored' basis — it has been round its operators; or
--   * it has expired.
--
-- Deliberately FALSE for a lead pooled on the 'unassigned' basis (§1). Those
-- are still live stock and ordinary routing must keep placing them.
-- ---------------------------------------------------------------------------
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
        )
    );
$$;


-- ---------------------------------------------------------------------------
-- 10 — Leads that SHOULD be in the pool but are not.
--
-- Reporting and dry-run use as well as the sweep, so admin can see exactly what
-- the next run will do before it does it.
-- ---------------------------------------------------------------------------
create or replace function public.get_pool_entry_candidates()
returns table (
  lead_id          uuid,
  lead_type        public.lead_type,
  basis            text,
  last_activity_at timestamptz,
  days_quiet       integer,
  assignment_count integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    l.id,
    l.lead_type,
    case when l.assignment_count = 0 then 'unassigned' else 'ignored' end,
    public.lead_last_activity_at(l.id),
    (extract(epoch from now() - public.lead_last_activity_at(l.id)) / 86400)::integer,
    l.assignment_count
  from public.leads l
  where l.pool_entered_at is null
    and l.pool_expired_at is null
    and not public.lead_pool_barred(l.id)
    and public.lead_last_activity_at(l.id)
        <= now() - make_interval(days => public.pool_setting_int('pool_entry_days', 25));
$$;


-- ---------------------------------------------------------------------------
-- 11 — Leads that should LEAVE the pool.
--
-- Two exits, and they are not the same thing:
--
--   engagement — somebody worked the lead after it entered. It goes back to its
--                holder and the 25-day clock restarts. The 90-day cap does not
--                (§2).
--   allocated  — an 'unassigned'-basis lead has since been placed through
--                ordinary routing. It is somebody's lead now, not open stock.
--                This exit does not exist for the 'ignored' basis, which is
--                terminal and cannot be allocated in the first place.
--
-- A barred lead also exits: a note written on a pooled lead both counts as
-- engagement and bars it permanently, and the bar is what stops it returning.
-- ---------------------------------------------------------------------------
create or replace function public.get_pool_exit_candidates()
returns table (
  lead_id   uuid,
  lead_type public.lead_type,
  reason    text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    l.id,
    l.lead_type,
    case
      when public.lead_pool_barred(l.id) then 'barred'
      when l.pool_entry_basis = 'unassigned' and l.assignment_count > 0 then 'allocated'
      else 'engaged'
    end
  from public.leads l
  where l.pool_entered_at is not null
    and l.pool_expired_at is null
    and (
      public.lead_pool_barred(l.id)
      or (l.pool_entry_basis = 'unassigned' and l.assignment_count > 0)
      or public.lead_last_activity_at(l.id) > l.pool_entered_at
    );
$$;


-- ---------------------------------------------------------------------------
-- 12 — The daily sweep.
--
-- Order matters: EXIT before ENTRY. A lead that leaves on engagement must not be
-- re-added in the same run, and running entry first would evaluate it against a
-- pool_entered_at that the exit pass is about to clear. Expiry runs last so a
-- lead entering and immediately hitting its cap is recorded as both, in the
-- order it actually happened.
--
-- Idempotent. Running it twice in a day changes nothing on the second pass:
-- every transition is predicated on the state it changes.
-- ---------------------------------------------------------------------------
create or replace function public.sweep_lead_pool()
returns table (
  entered integer,
  exited  integer,
  expired integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entered integer := 0;
  v_exited  integer := 0;
  v_expired integer := 0;
  v_life    integer := public.pool_setting_int('pool_life_days', 90);
begin
  -- Exit. pool_first_entered_at is deliberately untouched (§2).
  with exits as (select lead_id from public.get_pool_exit_candidates())
  update public.leads l
    set pool_entered_at  = null,
        pool_entry_basis = null
    from exits
    where l.id = exits.lead_id;
  get diagnostics v_exited = row_count;

  -- Enter. coalesce keeps the FIRST entry date on a re-entry.
  with entries as (
    select lead_id, basis from public.get_pool_entry_candidates()
  )
  update public.leads l
    set pool_entered_at       = now(),
        pool_first_entered_at = coalesce(l.pool_first_entered_at, now()),
        pool_entry_basis      = entries.basis
    from entries
    where l.id = entries.lead_id;
  get diagnostics v_entered = row_count;

  -- Expire. Measured from first entry, and it applies whether or not the lead
  -- is currently in the pool: a lead that left on engagement and was then
  -- abandoned again still dies 90 days after it first went cold.
  update public.leads l
    set pool_expired_at  = now(),
        pool_entered_at  = null,
        pool_entry_basis = null
    where l.pool_first_entered_at is not null
      and l.pool_expired_at is null
      and l.pool_first_entered_at <= now() - make_interval(days => v_life);
  get diagnostics v_expired = row_count;

  return query select v_entered, v_exited, v_expired;
end;
$$;


-- ---------------------------------------------------------------------------
-- 13 — Ordinary allocation must skip retired leads.
--
-- All three candidate functions, re-created verbatim from 0038 with ONE added
-- predicate. They are rewritten in full rather than patched because the whole
-- eligibility rule is the answer to "why did that lead go to that customer",
-- and a reader should not have to diff three migrations to get it — the same
-- argument 0067 makes for get_escalation_candidates.
--
-- The guard is expressed as a WHERE clause returning zero rows rather than an
-- exception: these are ranking queries, and a retired lead simply has no
-- eligible recipients. Callers already handle an empty candidate list.
-- ---------------------------------------------------------------------------
drop function if exists public.get_next_customers_for_lead(uuid, integer, uuid[], public.lead_type);
create or replace function public.get_next_customers_for_lead(
  p_lead_id uuid,
  p_max integer,
  p_exclude_customer_ids uuid[] default '{}'::uuid[],
  p_lead_type public.lead_type default 'management'
)
returns table (customer_id uuid)
language sql
security definer
set search_path = public
as $$
  select c.id
  from public.customers c
  where not public.lead_retired_from_allocation(p_lead_id)
    and c.is_active = true
    and not (c.id = any (coalesce(p_exclude_customer_ids, '{}'::uuid[])))
    and not exists (
      select 1 from public.lead_assignments la
      where la.lead_id = p_lead_id
        and la.customer_id = c.id
    )
    and (
      (
        p_lead_type = 'management'
        and c.account_status = 'active'
        and c.subscription_status = 'active'
        and c.lead_balance > 0
        and c.paused_at is null
      )
      or (
        p_lead_type = 'guaranteed_rent'
        and c.gr_subscription_status = 'active'
        and c.gr_lead_balance > 0
      )
    )
  order by
    case
      when p_lead_type = 'guaranteed_rent' then
        round(
          (least(greatest(
            extract(day from now() - coalesce(c.gr_billing_cycle_anchor, c.created_at::date)),
            0), 30) / 30.0)
          * c.gr_monthly_allocation
        ) - c.gr_leads_received_this_month
      else
        round(
          (least(greatest(
            extract(day from now() - coalesce(c.billing_cycle_anchor, c.created_at::date)),
            0), 30) / 30.0)
          * c.monthly_allocation
        ) - c.leads_received_this_month
    end desc,
    case
      when p_lead_type = 'guaranteed_rent' then c.gr_last_assignment_at
      else c.last_assignment_at
    end asc nulls first,
    c.created_at asc
  limit p_max;
$$;

create or replace function public.get_unfiltered_candidates_for_lead(
  p_lead_id uuid,
  p_max integer,
  p_lead_type public.lead_type default 'management'
)
returns table (customer_id uuid, deficit numeric)
language sql
security definer
set search_path = public
as $$
  select
    c.id,
    case
      when p_lead_type = 'guaranteed_rent' then
        round(
          (least(greatest(
            extract(day from now() - coalesce(c.gr_billing_cycle_anchor, c.created_at::date)),
            0), 30) / 30.0)
          * c.gr_monthly_allocation
        ) - c.gr_leads_received_this_month
      else
        round(
          (least(greatest(
            extract(day from now() - coalesce(c.billing_cycle_anchor, c.created_at::date)),
            0), 30) / 30.0)
          * c.monthly_allocation
        ) - c.leads_received_this_month
    end as deficit
  from public.customers c
  where not public.lead_retired_from_allocation(p_lead_id)
    and c.is_active = true
    and not exists (
      select 1 from public.lead_assignments la
      where la.lead_id = p_lead_id and la.customer_id = c.id
    )
    and (
      (
        p_lead_type = 'management'
        and c.account_status = 'active'
        and c.subscription_status = 'active'
        and c.lead_balance > 0
        and c.paused_at is null
        and c.filter_status = 'off'
      )
      or (
        p_lead_type = 'guaranteed_rent'
        and c.gr_subscription_status = 'active'
        and c.gr_lead_balance > 0
        and c.gr_filter_status = 'off'
      )
    )
  order by
    deficit desc,
    case when p_lead_type = 'guaranteed_rent' then c.gr_last_assignment_at
         else c.last_assignment_at end asc nulls first,
    c.created_at asc
  limit p_max;
$$;

create or replace function public.get_filtered_candidates_for_lead(
  p_lead_id uuid,
  p_max integer,
  p_lead_type public.lead_type default 'management'
)
returns table (customer_id uuid, priority_score numeric)
language sql
security definer
set search_path = public
as $$
  with l as (
    select
      postcode_area as area,
      nullif(substring(coalesce(bedrooms, '') from '\d+'), '')::int as bed
    from public.leads
    where id = p_lead_id
  )
  select
    c.id,
    case
      when p_lead_type = 'guaranteed_rent' then
        round(
          (least(greatest(
            extract(day from now() - coalesce(c.gr_billing_cycle_anchor, c.created_at::date)),
            0), 30) / 30.0)
          * c.gr_monthly_allocation
        ) - c.gr_leads_received_this_month
      else
        round(
          (least(greatest(
            extract(day from now() - coalesce(c.billing_cycle_anchor, c.created_at::date)),
            0), 30) / 30.0)
          * c.monthly_allocation
        ) - c.leads_received_this_month
    end as priority_score
  from public.customers c, l
  where not public.lead_retired_from_allocation(p_lead_id)
    and c.is_active = true
    and l.area is not null
    and l.bed is not null
    and not exists (
      select 1 from public.lead_assignments la
      where la.lead_id = p_lead_id and la.customer_id = c.id
    )
    and (
      (
        p_lead_type = 'management'
        and c.account_status = 'active'
        and c.subscription_status = 'active'
        and c.lead_balance > 0
        and c.paused_at is null
        and c.filter_status in ('active', 'pending_lift')
        and (
          c.filter_areas is null
          or array_length(c.filter_areas, 1) is null
          or l.area = any (c.filter_areas)
        )
        and (c.filter_min_bedrooms is null or l.bed >= c.filter_min_bedrooms)
        and (c.filter_max_bedrooms is null or l.bed <= c.filter_max_bedrooms)
      )
      or
      (
        p_lead_type = 'guaranteed_rent'
        and c.gr_subscription_status = 'active'
        and c.gr_lead_balance > 0
        and c.gr_filter_status in ('active', 'pending_lift')
        and (
          c.gr_filter_areas is null
          or array_length(c.gr_filter_areas, 1) is null
          or l.area = any (c.gr_filter_areas)
        )
        and (c.gr_filter_min_bedrooms is null or l.bed >= c.gr_filter_min_bedrooms)
        and (c.gr_filter_max_bedrooms is null or l.bed <= c.gr_filter_max_bedrooms)
      )
    )
  order by
    priority_score desc,
    case when p_lead_type = 'guaranteed_rent' then c.gr_last_assignment_at
         else c.last_assignment_at end asc nulls first,
    c.created_at asc
  limit p_max;
$$;

-- 0028/0049: a create-or-replace discards the function's ACL, so every
-- privileged function re-created above must have its grants re-asserted.
revoke execute on function public.get_next_customers_for_lead(uuid, integer, uuid[], public.lead_type)
  from public, anon, authenticated;
grant execute on function public.get_next_customers_for_lead(uuid, integer, uuid[], public.lead_type)
  to service_role;

revoke execute on function public.get_unfiltered_candidates_for_lead(uuid, integer, public.lead_type)
  from public, anon, authenticated;
grant execute on function public.get_unfiltered_candidates_for_lead(uuid, integer, public.lead_type)
  to service_role;

revoke execute on function public.get_filtered_candidates_for_lead(uuid, integer, public.lead_type)
  from public, anon, authenticated;
grant execute on function public.get_filtered_candidates_for_lead(uuid, integer, public.lead_type)
  to service_role;


-- ---------------------------------------------------------------------------
-- 14 — Escalation: skip retired leads, and move the age gate onto the
-- allocation clock.
--
-- TWO CHANGES, both from the same decision.
--
-- (a) The pooled-lead guard. Without it a lead that pooled on the 'ignored'
--     basis could still be escalated onto a fourth operator, which is the same
--     lead being sold twice by two different mechanisms.
--
-- (b) lead_age_days now measures DAYS SINCE THIS ASSIGNMENT, not days since the
--     enquiry date. The escalation_max_lead_age_days gate is set to 25 in
--     production — the same number as pool entry — which was clearly meant as a
--     handoff: escalate up to day 25, pool after. It could not work, because the
--     two sides measured different things. The gate counted from
--     safe_enquiry_date(l.enquiry_date), free text from Monday that does not
--     always parse, while allocation, pacing and now the pool all count from
--     lead_assignments.assigned_at.
--
--     On the assignment clock the ladder finally reads as one sequence:
--     assigned -> day 10 rung -> day 20 rung -> day 25 pool. And the null case
--     disappears: assigned_at is NOT NULL, so no candidate is ever waved
--     through on an unreadable date the way an unparseable enquiry date was.
--
--     The route's null-tolerant branch (`c.lead_age_days != null`) is left in
--     place and simply never fires now. Harmless, and it keeps the route
--     working against either definition during deployment.
-- ---------------------------------------------------------------------------
create or replace function public.get_escalation_candidates(
  p_cutoff       timestamptz,
  p_stage        integer,
  p_min_age_days integer
)
returns table (
  assignment_id   uuid,
  lead_id         uuid,
  customer_id     uuid,
  lead_type       public.lead_type,
  assigned_at     timestamptz,
  max_assignments integer,
  lead_age_days   integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    la.id,
    la.lead_id,
    la.customer_id,
    l.lead_type,
    la.assigned_at,
    l.max_assignments,
    (extract(epoch from now() - la.assigned_at) / 86400)::integer
  from public.lead_assignments la
  join public.leads l on l.id = la.lead_id
  where
    la.assigned_at > p_cutoff
    and la.assigned_at <= now() - make_interval(days => p_min_age_days)
    and la.inactivity_escalation_stage = p_stage - 1
    and la.status not in ('won', 'rejected')
    and l.max_assignments < 5

    -- The lead has passed to the pool (or been claimed out of it). Escalation
    -- and the pool are two routes to the same place; a lead must not travel
    -- both.
    and not public.lead_retired_from_allocation(la.lead_id)
    and l.pool_entered_at is null

    -- This operator has filed the lead. Escalating it would be chasing them
    -- about a lead they have already told us the outcome of.
    and la.closed_at is null

    -- ANY operator has reported the landlord as done. Selling a lead that has
    -- already said no is how a lead source earns a bad name — and it is exactly
    -- the outcome this whole feature exists to avoid.
    and not exists (
      select 1 from public.lead_assignments closed
      where closed.lead_id = la.lead_id
        and closed.closed_at is not null
    );
$$;

revoke execute on function public.get_escalation_candidates(timestamptz, integer, integer)
  from public, anon, authenticated;
grant execute on function public.get_escalation_candidates(timestamptz, integer, integer)
  to service_role;


-- ---------------------------------------------------------------------------
-- 15 — Ordinary allocation clears an 'unassigned' pool tenancy.
--
-- The other half of §1. When routing places a lead that was sitting in the pool
-- as unsold stock, it must leave the pool in the SAME TRANSACTION — not on the
-- next nightly sweep. Otherwise there is a window, up to 24 hours wide, in which
-- the lead is both assigned to somebody and claimable by everybody, and a claim
-- landing in that window sells a lead its new owner has already been charged for.
--
-- pool_first_entered_at survives (§2), so if the new holder ignores it the lead
-- re-pools 25 days later on the 'ignored' basis with its original death clock
-- still running.
--
-- Definition otherwise verbatim from 0053. No gate, counter or price changes.
-- ---------------------------------------------------------------------------
create or replace function public.assign_lead_to_customer(
  p_lead_id uuid,
  p_customer_id uuid,
  p_price numeric,
  p_lead_type lead_type default 'management'::lead_type
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_lead     public.leads%rowtype;
  v_customer public.customers%rowtype;
  v_assignment_id uuid;
  v_capacity integer;
begin
  select * into v_lead from public.leads
    where id = p_lead_id for update;
  if not found then
    raise exception 'Lead % not found', p_lead_id;
  end if;

  select * into v_customer from public.customers
    where id = p_customer_id for update;
  if not found then
    raise exception 'Customer % not found', p_customer_id;
  end if;

  -- Before capacity: an already-held lead must not be reported as a cap breach.
  if exists (
    select 1 from public.lead_assignments
    where lead_id = p_lead_id and customer_id = p_customer_id
  ) then
    raise exception 'Customer already has this lead'
      using detail = format('customer=%s lead=%s', p_customer_id, p_lead_id);
  end if;

  -- Invariant 7, asserted at the money path as well as in the ranking queries.
  -- The candidate functions already exclude these leads, but this is the only
  -- place that is under a row lock, and admin_assign_lead is not the only other
  -- caller — anything that acquires a lead id from elsewhere arrives here.
  if public.lead_retired_from_allocation(p_lead_id) then
    raise exception 'Lead % has passed to the expired leads pool and cannot be allocated',
      p_lead_id;
  end if;

  -- Capacity = ordinary cap + any reclaim slot granted and not yet consumed.
  v_capacity := v_lead.max_assignments
                + public.lead_open_reclaim_slots(p_lead_id);

  if v_lead.assignment_count >= v_capacity then
    raise exception 'Lead % is at max assignments (%/%)',
      p_lead_id, v_lead.assignment_count, v_capacity;
  end if;

  if p_lead_type = 'guaranteed_rent' then
    if v_customer.gr_lead_balance <= 0 then
      raise exception 'Customer % has no remaining GR lead balance', p_customer_id;
    end if;
  else
    if v_customer.paused_at is not null then
      raise exception 'Customer % is paused and cannot receive management leads', p_customer_id;
    end if;
    if v_customer.lead_balance <= 0 then
      raise exception 'Customer % has no remaining lead balance', p_customer_id;
    end if;
  end if;

  insert into public.lead_assignments (lead_id, customer_id, price_paid)
    values (p_lead_id, p_customer_id, p_price)
    returning id into v_assignment_id;

  update public.leads
    set assignment_count = assignment_count + 1,
        -- Placed, so it is no longer open stock. Only ever true of the
        -- 'unassigned' basis: the 'ignored' basis is terminal and the guard
        -- above has already refused it.
        pool_entered_at  = case when pool_entry_basis = 'unassigned'
                                then null else pool_entered_at end,
        pool_entry_basis = case when pool_entry_basis = 'unassigned'
                                then null else pool_entry_basis end
    where id = p_lead_id;

  if p_lead_type = 'guaranteed_rent' then
    -- GR branch: unchanged. No lifetime odometer exists for this product.
    update public.customers
      set gr_lead_balance = gr_lead_balance - 1,
          gr_leads_received_this_month = gr_leads_received_this_month + 1,
          gr_last_assignment_at = now(),
          updated_at = now()
      where id = p_customer_id;
  else
    update public.customers
      set leads_received_this_month = leads_received_this_month + 1,
          management_lifetime_leads_received =
            management_lifetime_leads_received + 1,
          lead_balance = lead_balance - 1,
          last_assignment_at = now(),
          updated_at = now()
      where id = p_customer_id;
  end if;

  return v_assignment_id;
end;
$function$;

revoke execute on function public.assign_lead_to_customer(uuid, uuid, numeric, public.lead_type)
  from public, anon, authenticated;
grant execute on function public.assign_lead_to_customer(uuid, uuid, numeric, public.lead_type)
  to service_role;


-- ---------------------------------------------------------------------------
-- 16 — Grants for the new functions.
--
-- Service role only, every one of them. Nothing here takes identity from
-- auth.uid(), so nothing here is safe to expose to `authenticated` — the two
-- functions that are (get_engagement_benchmarks, set_management_customer_goal)
-- resolve identity internally and return aggregates. The customer-facing pool
-- read goes through a server route on the service role in Phase 3, exactly as
-- /dashboard/leads already does.
-- ---------------------------------------------------------------------------
revoke execute on function public.pool_setting_int(text, integer) from public, anon, authenticated;
grant execute on function public.pool_setting_int(text, integer) to service_role;

revoke execute on function public.lead_last_activity_at(uuid) from public, anon, authenticated;
grant execute on function public.lead_last_activity_at(uuid) to service_role;

revoke execute on function public.lead_pool_barred(uuid) from public, anon, authenticated;
grant execute on function public.lead_pool_barred(uuid) to service_role;

revoke execute on function public.lead_retired_from_allocation(uuid) from public, anon, authenticated;
grant execute on function public.lead_retired_from_allocation(uuid) to service_role;

revoke execute on function public.get_pool_entry_candidates() from public, anon, authenticated;
grant execute on function public.get_pool_entry_candidates() to service_role;

revoke execute on function public.get_pool_exit_candidates() from public, anon, authenticated;
grant execute on function public.get_pool_exit_candidates() to service_role;

revoke execute on function public.sweep_lead_pool() from public, anon, authenticated;
grant execute on function public.sweep_lead_pool() to service_role;

revoke execute on function public.stamp_assignment_field_times() from public, anon, authenticated;
