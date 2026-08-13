-- ============================================================================
-- 0076 — Admin view of the pools, manual override, and the claim log.
--
-- Read-only reporting plus two deliberate escape hatches. Nothing here is on a
-- customer path; every function is service-role only and called from /admin.
--
-- ---------------------------------------------------------------------------
-- WHY FORCING A LEAD OUT NEEDS A NEW COLUMN
-- ---------------------------------------------------------------------------
-- Clearing pool_entered_at is not enough. The sweep runs every morning and
-- re-evaluates eligibility from scratch, so a lead an admin removed at 16:00
-- would be back in the pool at 10:30 the next day — a control that silently
-- undoes itself is worse than no control, because the admin believes it worked.
--
-- pool_excluded_at is therefore a sticky "never pool this" marker that
-- lead_pool_barred honours. Forcing a lead IN clears it, so the pair are true
-- opposites and neither is a one-way door.
--
-- WHAT FORCING OUT MEANS FOR ALLOCATION
-- -------------------------------------
-- It returns the lead to ordinary circulation. pool_entry_basis is cleared
-- along with the tenancy, so lead_retired_from_allocation goes false and
-- routing may place it again if it is under its cap.
--
-- That is the honest reading of the control: an admin removing a lead from the
-- pool is saying "this should not have been treated as expired". If they mean
-- "this lead is finished", the existing tools say that better — close records an
-- outcome, and the swap withdrawal takes it out of circulation entirely.
--
-- A CLAIMED LEAD CANNOT BE FORCED BACK IN. It belongs to whoever claimed it.
-- Putting it back would offer one customer's paid lead to everybody else.
-- ============================================================================

alter table public.leads
  add column if not exists pool_excluded_at timestamptz;

comment on column public.leads.pool_excluded_at is
  'An admin has removed this lead from the expired pool by hand. Sticky: the '
  'daily sweep will not re-add it. Cleared by forcing the lead back in.';


-- ---------------------------------------------------------------------------
-- 1 — lead_pool_barred honours the manual exclusion.
--
-- Definition verbatim from 0073 with pool_excluded_at added to the final
-- clause, alongside withdrawn_at and pool_expired_at — the three "this lead is
-- out of the pool by decision, not by measurement" cases.
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
        )
    );
$$;


-- ---------------------------------------------------------------------------
-- 2 — Per-product summary for the admin panel.
--
-- pending_entry is what the NEXT sweep will add, so an admin can see a change
-- coming rather than discovering it after the fact. It is the same function the
-- cron calls, so the preview cannot drift from the action.
--
-- barred is reported because it is the number that explains a small pool. A
-- management pool of six against 151 leads looks broken until you can see that
-- 77 are barred for having been genuinely worked.
-- ---------------------------------------------------------------------------
create or replace function public.get_admin_pool_summary()
returns table (
  lead_type        public.lead_type,
  in_pool          integer,
  in_pool_ignored  integer,
  in_pool_unassigned integer,
  pending_entry    integer,
  claimed_total    integer,
  expired_total    integer,
  excluded_total   integer,
  barred_total     integer,
  oldest_in_pool_days integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    t.lead_type,
    coalesce(p.in_pool, 0)::integer,
    coalesce(p.ignored, 0)::integer,
    coalesce(p.unassigned, 0)::integer,
    coalesce(e.pending, 0)::integer,
    coalesce(c.claimed, 0)::integer,
    coalesce(x.expired, 0)::integer,
    coalesce(x.excluded, 0)::integer,
    coalesce(b.barred, 0)::integer,
    coalesce(p.oldest_days, 0)::integer
  from (select unnest(enum_range(null::public.lead_type)) as lead_type) t
  left join (
    select l.lead_type,
      count(*) as in_pool,
      count(*) filter (where l.pool_entry_basis = 'ignored') as ignored,
      count(*) filter (where l.pool_entry_basis = 'unassigned') as unassigned,
      max((extract(epoch from now() - l.pool_entered_at) / 86400)::int) as oldest_days
    from public.leads l
    where l.pool_entered_at is not null and l.pool_expired_at is null
    group by l.lead_type
  ) p on p.lead_type = t.lead_type
  left join (
    select lead_type, count(*) as pending
    from public.get_pool_entry_candidates() group by lead_type
  ) e on e.lead_type = t.lead_type
  left join (
    select l.lead_type, count(distinct l.id) as claimed
    from public.leads l
    join public.lead_assignments la on la.lead_id = l.id
    where la.claimed_from_pool_at is not null
    group by l.lead_type
  ) c on c.lead_type = t.lead_type
  left join (
    select l.lead_type,
      count(*) filter (where l.pool_expired_at is not null) as expired,
      count(*) filter (where l.pool_excluded_at is not null) as excluded
    from public.leads l group by l.lead_type
  ) x on x.lead_type = t.lead_type
  left join (
    select l.lead_type, count(*) as barred
    from public.leads l
    where public.lead_pool_barred(l.id)
    group by l.lead_type
  ) b on b.lead_type = t.lead_type;
$$;


-- ---------------------------------------------------------------------------
-- 3 — The pools themselves, read-only.
--
-- Unlike the customer listing (0075) this DOES report how many operators held
-- the lead and what became of them. The customer must not see that — "three
-- operators passed" is an argument against ringing — but the admin deciding
-- whether the pool is behaving needs exactly that number.
-- ---------------------------------------------------------------------------
create or replace function public.get_admin_pool_leads(p_lead_type public.lead_type)
returns table (
  lead_id           uuid,
  lead_name         text,
  address           text,
  postcode_area     text,
  bedrooms          text,
  basis             text,
  assignment_count  integer,
  max_assignments   integer,
  pool_entered_at   timestamptz,
  days_in_pool      integer,
  days_until_expiry integer,
  last_activity_at  timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    l.id,
    l.lead_name,
    l.address,
    l.postcode_area,
    l.bedrooms,
    l.pool_entry_basis,
    l.assignment_count,
    l.max_assignments,
    l.pool_entered_at,
    (extract(epoch from now() - l.pool_entered_at) / 86400)::integer,
    greatest(
      public.pool_setting_int('pool_life_days', 90)
        - (extract(epoch from now() - l.pool_first_entered_at) / 86400)::integer,
      0
    ),
    public.lead_last_activity_at(l.id)
  from public.leads l
  where l.lead_type = p_lead_type
    and l.pool_entered_at is not null
    and l.pool_expired_at is null
  order by l.pool_entered_at desc;
$$;


-- ---------------------------------------------------------------------------
-- 4 — Claim history.
--
-- Every claim ever made, newest first. `paid_with` is reconstructed rather than
-- stored: a claim spends a credit or takes a debit, and which one it was is not
-- recorded on the assignment. price_paid is always the full lead price either
-- way (invariant 4), so the row cannot answer it.
--
-- The honest reconstruction is the payments trail, and there is not one for a
-- debit — so this reports the customer's CURRENT debit alongside the claim and
-- leaves the inference to the reader, rather than inventing a per-claim answer
-- the schema cannot support. If per-claim attribution is ever wanted it needs a
-- column on lead_assignments written at claim time; it is not worth one today,
-- with the total number of claims at zero.
-- ---------------------------------------------------------------------------
create or replace function public.get_pool_claim_history(p_limit integer default 200)
returns table (
  assignment_id        uuid,
  lead_id              uuid,
  lead_name            text,
  lead_type            public.lead_type,
  customer_id          uuid,
  business_name        text,
  claimed_at           timestamptz,
  price_paid           numeric,
  status               text,
  pipeline_stage       text,
  customer_pool_debit  integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    la.id,
    l.id,
    l.lead_name,
    l.lead_type,
    c.id,
    c.business_name,
    la.claimed_from_pool_at,
    la.price_paid,
    la.status,
    la.pipeline_stage,
    case when l.lead_type = 'guaranteed_rent' then c.gr_pool_debit
         else c.pool_debit end
  from public.lead_assignments la
  join public.leads l     on l.id = la.lead_id
  join public.customers c on c.id = la.customer_id
  where la.claimed_from_pool_at is not null
  order by la.claimed_from_pool_at desc
  limit p_limit;
$$;


-- ---------------------------------------------------------------------------
-- 5 — Force a lead into the pool.
--
-- Bypasses the age clock and every bar EXCEPT the two that are not measurements
-- but facts about ownership: a claimed lead belongs to somebody, and a
-- withdrawn lead was pulled from circulation on purpose.
--
-- Expiry is cleared too. An admin putting an expired lead back is overriding
-- the life cap knowingly, and leaving pool_expired_at set would have the sweep
-- remove it again within the day.
-- ---------------------------------------------------------------------------
create or replace function public.admin_pool_force_in(p_lead_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead public.leads%rowtype;
begin
  select * into v_lead from public.leads where id = p_lead_id for update;
  if not found then
    raise exception 'Lead % not found', p_lead_id;
  end if;

  if exists (
    select 1 from public.lead_assignments la
    where la.lead_id = p_lead_id and la.claimed_from_pool_at is not null
  ) then
    raise exception 'Lead % has been claimed and cannot be returned to the pool',
      p_lead_id;
  end if;

  if v_lead.withdrawn_at is not null then
    raise exception 'Lead % was withdrawn from circulation and cannot be pooled',
      p_lead_id;
  end if;

  update public.leads
    set pool_entered_at       = coalesce(pool_entered_at, now()),
        pool_first_entered_at = coalesce(pool_first_entered_at, now()),
        pool_entry_basis      = case when assignment_count = 0
                                     then 'unassigned' else 'ignored' end,
        pool_excluded_at      = null,
        pool_expired_at       = null
    where id = p_lead_id;
end;
$$;


-- ---------------------------------------------------------------------------
-- 6 — Force a lead out of the pool.
--
-- Sticky, for the reason in the header: without pool_excluded_at the next
-- sweep would undo it.
-- ---------------------------------------------------------------------------
create or replace function public.admin_pool_force_out(p_lead_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.leads where id = p_lead_id) then
    raise exception 'Lead % not found', p_lead_id;
  end if;

  update public.leads
    set pool_entered_at  = null,
        pool_entry_basis = null,
        pool_excluded_at = now()
    where id = p_lead_id;
end;
$$;


-- ---------------------------------------------------------------------------
-- 7 — Grants. Service role only, all of it.
-- ---------------------------------------------------------------------------
revoke execute on function public.lead_pool_barred(uuid) from public, anon, authenticated;
grant execute on function public.lead_pool_barred(uuid) to service_role;

revoke execute on function public.get_admin_pool_summary() from public, anon, authenticated;
grant execute on function public.get_admin_pool_summary() to service_role;

revoke execute on function public.get_admin_pool_leads(public.lead_type) from public, anon, authenticated;
grant execute on function public.get_admin_pool_leads(public.lead_type) to service_role;

revoke execute on function public.get_pool_claim_history(integer) from public, anon, authenticated;
grant execute on function public.get_pool_claim_history(integer) to service_role;

revoke execute on function public.admin_pool_force_in(uuid) from public, anon, authenticated;
grant execute on function public.admin_pool_force_in(uuid) to service_role;

revoke execute on function public.admin_pool_force_out(uuid) from public, anon, authenticated;
grant execute on function public.admin_pool_force_out(uuid) to service_role;
