-- ============================================================================
-- Behavioural tests for 0155 — a landlord Stayful is already working is never
-- sold (CLAUDE.md §64).
--
-- The assertions that matter most: nothing about ordinary allocation changes
-- (a marketplace lead still allocates and spends exactly one credit), a
-- flagged lead is refused by every path that hands a lead out, a withdrawal
-- moves NO money on any holder, and a replacement is fulfilled at the price
-- the customer paid — never over their filter, never through a paused
-- customer, never twice.
--
-- Run against a scratch Postgres with every migration applied. See README.md.
-- ============================================================================
\set ON_ERROR_STOP on
\pset pager off
\o /dev/null

create schema if not exists test_util;

create or replace function test_util.assert_eq(actual anyelement, expected anyelement, label text)
returns void language plpgsql as $$
begin
  if actual is distinct from expected then
    raise exception 'FAIL % — expected %, got %', label, expected, actual;
  end if;
  raise notice 'ok  %', label;
end $$;

create or replace function test_util.assert_raises(sql text, label text)
returns void language plpgsql as $$
begin
  begin
    execute sql;
  exception when others then
    raise notice 'ok  % (%)', label, SQLERRM;
    return;
  end;
  raise exception 'FAIL % — expected an exception, none raised', label;
end $$;

create or replace function test_util.assert_raises_like(sql text, pattern text, label text)
returns void language plpgsql as $$
declare msg text;
begin
  begin
    execute sql;
  exception when others then
    msg := SQLERRM;
    if msg not like pattern then
      raise exception 'FAIL % — expected a message like %, got %', label, pattern, msg;
    end if;
    raise notice 'ok  % (%)', label, msg;
    return;
  end;
  raise exception 'FAIL % — expected an exception, none raised', label;
end $$;

-- ⚠️ THE ORACLE. 0111's body, transcribed verbatim (as 0144's suite does), so
-- the deliberate divergence 0155 introduces is asserted rather than derived.
create or replace function test_util.lead_retired_0111(p_lead_id uuid)
returns boolean language sql stable as $$
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
          or (
            l.owner_customer_id is not null
            and l.owner_resale_qualified_at is null
          )
          or (
            l.lead_quality_status = 'failed'
            and l.lead_quality_override_at is null
          )
        )
    );
$$;

-- Every holder's money columns, in one string.
create or replace function test_util.money_fingerprint()
returns text language sql stable as $$
  select md5(string_agg(
    c.id::text || ':' || c.lead_balance || ':' || c.leads_received_this_month || ':'
      || c.management_lifetime_leads_received || ':' || c.replacement_balance || ':'
      || c.clean_leads_streak || ':' || c.quality_claims_this_cycle,
    '|' order by c.id))
  from public.customers c;
$$;

-- ⚠️ Cleared UP FRONT as well as at the end: mutation testing aborts a suite
-- by design, and a suite that is not re-runnable reports the wrong failure on
-- the next pass. The new table is included.
delete from public.owed_lead_replacements;
delete from public.lead_outcome_reasons;
delete from public.lead_quality_claims;
delete from public.lead_events;
delete from public.lead_notes;
delete from public.lead_assignments;
delete from public.leads;
delete from public.customers;

update public.system_settings set value = 'false' where key = 'release_enabled';

-- Unfilt (no filter), Filt (BS 3+), Paused (management, paused), GRonly.
insert into public.customers
  (id, business_name, contact_name, email, monthly_allocation, lead_balance,
   leads_received_this_month, management_lifetime_leads_received, replacement_balance,
   clean_leads_streak, quality_claims_this_cycle, billing_cycle_anchor,
   account_status, subscription_status, gr_subscription_status, filter_status, gr_filter_status)
values
  ('11111111-1111-1111-1111-111111111111','Unfilt','A','a@x.com',20,10,2,5,3,4,1,current_date - 3,
   'active','active','inactive','off','off'),
  ('22222222-2222-2222-2222-222222222222','Filt','B','b@x.com',20,10,2,5,3,4,1,current_date - 3,
   'active','active','inactive','active','off'),
  ('33333333-3333-3333-3333-333333333333','Paused','C','c@x.com',20,10,2,5,3,4,1,current_date - 3,
   'active','active','inactive','off','off'),
  ('44444444-4444-4444-4444-444444444444','Winner','D','d@x.com',20,10,2,5,3,4,1,current_date - 3,
   'active','active','inactive','off','off'),
  ('55555555-5555-5555-5555-555555555555','GRonly','E','e@x.com',20,0,0,0,0,0,0,null,
   'waitlisted','inactive','active','off','off');

update public.customers set filter_areas = '{BS}', filter_min_bedrooms = 3
  where id = '22222222-2222-2222-2222-222222222222';
update public.customers set paused_at = now() - interval '1 day'
  where id = '33333333-3333-3333-3333-333333333333';
update public.customers set gr_lead_balance = 10, gr_monthly_allocation = 10
  where id = '55555555-5555-5555-5555-555555555555';

-- CONFLICT held by four customers; STOCK-A (BS 4-bed) and STOCK-B (SW 1-bed)
-- unsold; NEVER unsold and never assigned; OLDSTOCK an older BS lead; GR-X.
insert into public.leads
  (id, monday_item_id, lead_name, postcode, postcode_area, bedrooms,
   max_assignments, assignment_count, created_at, lead_quality_status)
values
  ('aaaa0000-0000-0000-0000-00000000c0f1','m-conflict','Conflict lead','BS1 1AA','BS','3 bedrooms',3,4, now() - interval '20 days','passed'),
  ('aaaa0000-0000-0000-0000-0000000057a1','m-stock-a','Stock A','BS2 2BB','BS','4 bedrooms',3,0, now() - interval '1 day','passed'),
  ('aaaa0000-0000-0000-0000-0000000057b2','m-stock-b','Stock B','SW1 1CC','SW','1 bedroom',3,0, now() - interval '2 days','passed'),
  ('aaaa0000-0000-0000-0000-00000000ee01','m-never','Never sold','BS3 3DD','BS','3 bedrooms',3,0, now() - interval '40 days','passed'),
  ('aaaa0000-0000-0000-0000-0000000001d0','m-old','Old stock','BS4 4EE','BS','3 bedrooms',3,0, now() - interval '10 days','passed');

insert into public.leads
  (id, monday_item_id, lead_name, lead_type, postcode, postcode_area, bedrooms,
   max_assignments, assignment_count, lead_quality_status)
values
  ('bbbb0000-0000-0000-0000-00000000c0f1','g-conflict','GR lead','guaranteed_rent','BS5 5FF','BS','3',3,0,'passed');

-- The four holders of CONFLICT: new, contacted (with a note), new (paused), won.
insert into public.lead_assignments (id, lead_id, customer_id, price_paid, status)
values
  ('cccc0000-0000-0000-0000-000000000001','aaaa0000-0000-0000-0000-00000000c0f1','11111111-1111-1111-1111-111111111111',15.00,'new'),
  ('cccc0000-0000-0000-0000-000000000002','aaaa0000-0000-0000-0000-00000000c0f1','22222222-2222-2222-2222-222222222222',15.00,'contacted'),
  ('cccc0000-0000-0000-0000-000000000003','aaaa0000-0000-0000-0000-00000000c0f1','33333333-3333-3333-3333-333333333333',15.00,'new'),
  ('cccc0000-0000-0000-0000-000000000004','aaaa0000-0000-0000-0000-00000000c0f1','44444444-4444-4444-4444-444444444444',15.00,'won');

insert into public.lead_notes (lead_assignment_id, customer_id, body)
values ('cccc0000-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','Spoke to the landlord on Tuesday');

-- ---------------------------------------------------------------------------
-- 0 — Seeds, columns, the table
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  (select value from public.system_settings where key = 'stayful_conflict_enabled'),
  'false', 'stayful_conflict_enabled ships false');
select test_util.assert_eq(
  (select count(*)::integer from information_schema.columns
    where table_schema = 'public' and table_name = 'leads'
      and column_name in ('stayful_conflict_at','stayful_conflict_item_id',
                          'stayful_conflict_group_id','stayful_conflict_matched_by')),
  4, 'the four conflict columns exist');
select test_util.assert_eq(
  (select count(*)::integer from public.leads where stayful_conflict_at is not null),
  0, 'no seeded lead is flagged');
select test_util.assert_eq(
  (select relrowsecurity from pg_class where oid = 'public.owed_lead_replacements'::regclass),
  true, 'owed_lead_replacements has RLS on');
select test_util.assert_eq(
  (select count(*)::integer from pg_policies where tablename = 'owed_lead_replacements'),
  0, 'owed_lead_replacements has zero policies (deny-all)');
select test_util.assert_raises(
  $q$update public.leads set stayful_conflict_at = now(), stayful_conflict_item_id = 'i',
       stayful_conflict_group_id = 'g', stayful_conflict_matched_by = 'name'
     where id = 'aaaa0000-0000-0000-0000-0000000001d0'$q$,
  'matched_by refuses a value outside item/email/phone');
select test_util.assert_raises(
  $q$update public.leads set stayful_conflict_at = now()
     where id = 'aaaa0000-0000-0000-0000-0000000001d0'$q$,
  'a stamp with no evidence is refused by the shape check');

-- ---------------------------------------------------------------------------
-- 1 — Regression: ordinary allocation is untouched
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  test_util.lead_retired_0111('aaaa0000-0000-0000-0000-0000000057a1'),
  public.lead_retired_from_allocation('aaaa0000-0000-0000-0000-0000000057a1'),
  'the 0111 oracle and the predicate agree on an unflagged lead');
select test_util.assert_eq(
  (select count(*)::integer from public.get_unfiltered_candidates_for_lead('aaaa0000-0000-0000-0000-0000000001d0', 10)
    where customer_id = '11111111-1111-1111-1111-111111111111'),
  1, 'regression: an unflagged lead still reaches Unfilt');
select public.assign_lead_to_customer(
  'aaaa0000-0000-0000-0000-0000000001d0', '11111111-1111-1111-1111-111111111111', 15.00);
select test_util.assert_eq(
  (select lead_balance from public.customers where id = '11111111-1111-1111-1111-111111111111'),
  9, 'regression: one credit spent (10 -> 9)');
select test_util.assert_eq(
  (select leads_received_this_month from public.customers where id = '11111111-1111-1111-1111-111111111111'),
  3, 'regression: the monthly counter moved');
select test_util.assert_eq(
  (select management_lifetime_leads_received from public.customers where id = '11111111-1111-1111-1111-111111111111'),
  6, 'regression: the odometer moved');

-- ---------------------------------------------------------------------------
-- 2 — The flag: three withdrawn, the won row kept, nothing else moves
-- ---------------------------------------------------------------------------
create temporary table before_flag as select test_util.money_fingerprint() as fp;

create temporary table flag_rows as
  select * from public.flag_stayful_conflict(
    'aaaa0000-0000-0000-0000-00000000c0f1', '12345678', 'group_mm1dtkdm', 'email');

select test_util.assert_eq((select count(*)::integer from flag_rows), 3,
  'flag returns exactly the three live assignments');
select test_util.assert_eq(
  (select count(*)::integer from flag_rows where owed_id is not null), 3,
  'every withdrawn assignment produced an owed row');
select test_util.assert_eq(
  (select count(*)::integer from public.lead_assignments
    where lead_id = 'aaaa0000-0000-0000-0000-00000000c0f1'),
  1, 'only the won assignment survives');
select test_util.assert_eq(
  (select status from public.lead_assignments where id = 'cccc0000-0000-0000-0000-000000000004'),
  'won', 'the won row is untouched');

select test_util.assert_eq(
  (select stayful_conflict_matched_by from public.leads where id = 'aaaa0000-0000-0000-0000-00000000c0f1'),
  'email', 'matched_by stamped');
select test_util.assert_eq(
  (select stayful_conflict_group_id from public.leads where id = 'aaaa0000-0000-0000-0000-00000000c0f1'),
  'group_mm1dtkdm', 'group stamped');
select test_util.assert_eq(
  (select stayful_conflict_at is not null from public.leads where id = 'aaaa0000-0000-0000-0000-00000000c0f1'),
  true, 'stayful_conflict_at stamped');
select test_util.assert_eq(
  (select assignment_count from public.leads where id = 'aaaa0000-0000-0000-0000-00000000c0f1'),
  1, 'assignment_count reflects the one surviving row');
select test_util.assert_eq(
  (select max_assignments from public.leads where id = 'aaaa0000-0000-0000-0000-00000000c0f1'),
  1, 'max_assignments clamped to the count');
select test_util.assert_eq(
  (select withdrawn_at is not null from public.leads where id = 'aaaa0000-0000-0000-0000-00000000c0f1'),
  true, 'withdrawn_at stamped');
select test_util.assert_eq(
  (select withdrawn_slots from public.leads where id = 'aaaa0000-0000-0000-0000-00000000c0f1'),
  2, 'withdrawn_slots = old cap 3 - surviving 1');
select test_util.assert_eq(
  (select pool_excluded_at is not null and pool_entered_at is null
     from public.leads where id = 'aaaa0000-0000-0000-0000-00000000c0f1'),
  true, 'forced out of the pool');

select test_util.assert_eq(
  (select count(*)::integer from public.owed_lead_replacements where status = 'open'), 3,
  'three owed rows, all open');
select test_util.assert_eq(
  (select price_paid from public.owed_lead_replacements
    where origin_assignment_id = 'cccc0000-0000-0000-0000-000000000002'),
  15.00, 'owed at the original price');
select test_util.assert_eq(
  (select replacement_depth from public.owed_lead_replacements
    where origin_assignment_id = 'cccc0000-0000-0000-0000-000000000002'),
  0, 'owed row carries the withdrawn depth');
select test_util.assert_eq(
  (select origin_status from public.owed_lead_replacements
    where origin_assignment_id = 'cccc0000-0000-0000-0000-000000000002'),
  'contacted', 'origin_status recorded');
select test_util.assert_eq(
  (select origin_notes->0->>'body' from public.owed_lead_replacements
    where origin_assignment_id = 'cccc0000-0000-0000-0000-000000000002'),
  'Spoke to the landlord on Tuesday', 'the note the cascade destroyed is snapshotted');
select test_util.assert_eq(
  (select origin_notes from public.owed_lead_replacements
    where origin_assignment_id = 'cccc0000-0000-0000-0000-000000000001') is null,
  true, 'no notes means a null snapshot, not an empty array');

select test_util.assert_eq(
  test_util.money_fingerprint(), (select fp from before_flag),
  'NO MONEY MOVED on any holder: balance, counter, odometer, replacement_balance, streak, claims');

-- ---------------------------------------------------------------------------
-- 3 — Retired everywhere
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  public.lead_retirement_reason('aaaa0000-0000-0000-0000-00000000c0f1'),
  'stayful_conflict', 'the reason is stayful_conflict');
select test_util.assert_eq(
  test_util.lead_retired_0111('aaaa0000-0000-0000-0000-00000000c0f1'),
  false, 'the 0111 oracle does NOT retire it — the deliberate divergence');
select test_util.assert_eq(
  public.lead_retired_from_allocation('aaaa0000-0000-0000-0000-00000000c0f1'),
  true, 'lead_retired_from_allocation inherits the arm');

-- Precedence: flagged AND quality-failed reads stayful_conflict.
update public.leads set lead_quality_status = 'failed', lead_quality_codes = array['name_junk']
  where id = 'aaaa0000-0000-0000-0000-00000000c0f1';
select test_util.assert_eq(
  public.lead_retirement_reason('aaaa0000-0000-0000-0000-00000000c0f1'),
  'stayful_conflict', 'stayful_conflict outranks quality_failed');
update public.leads set lead_quality_status = 'passed', lead_quality_codes = '{}'
  where id = 'aaaa0000-0000-0000-0000-00000000c0f1';

-- Give it a free slot again so only retirement stands in the way.
update public.leads set max_assignments = 5 where id = 'aaaa0000-0000-0000-0000-00000000c0f1';

select test_util.assert_eq(
  (select count(*)::integer from public.get_unfiltered_candidates_for_lead('aaaa0000-0000-0000-0000-00000000c0f1', 10)),
  0, 'absent from get_unfiltered_candidates_for_lead');
select test_util.assert_eq(
  (select count(*)::integer from public.get_filtered_candidates_for_lead('aaaa0000-0000-0000-0000-00000000c0f1', 10)),
  0, 'absent from get_filtered_candidates_for_lead');
select test_util.assert_eq(
  (select count(*)::integer from public.get_escalation_candidates(now() - interval '100 days', 0, 0)
    where lead_id = 'aaaa0000-0000-0000-0000-00000000c0f1'),
  0, 'absent from get_escalation_candidates');
select test_util.assert_raises_like(
  $q$select public.assign_lead_to_customer('aaaa0000-0000-0000-0000-00000000c0f1',
       '11111111-1111-1111-1111-111111111111', 15.00)$q$,
  '%', 'assign_lead_to_customer refuses it');
select test_util.assert_raises_like(
  $q$select public.assign_lead_to_customer('aaaa0000-0000-0000-0000-00000000c0f1',
       '11111111-1111-1111-1111-111111111111', 15.00, 'management', true)$q$,
  '%', 'assign_lead_to_customer refuses it with the filter override too');
update public.leads set max_assignments = 1 where id = 'aaaa0000-0000-0000-0000-00000000c0f1';
select test_util.assert_raises_like(
  $q$select public.admin_assign_lead('aaaa0000-0000-0000-0000-00000000c0f1',
       '11111111-1111-1111-1111-111111111111', 15.00)$q$,
  '%max assignments%', 'admin_assign_lead refuses it on the clamp');
select test_util.assert_eq(
  public.lead_pool_barred('aaaa0000-0000-0000-0000-00000000c0f1'),
  true, 'lead_pool_barred is true');

-- The swap: cannot come IN, greyed in the picker.
insert into public.lead_assignments (id, lead_id, customer_id, price_paid)
values ('cccc0000-0000-0000-0000-000000000010','aaaa0000-0000-0000-0000-0000000057b2',
        '11111111-1111-1111-1111-111111111111',15.00);
update public.leads set assignment_count = 1 where id = 'aaaa0000-0000-0000-0000-0000000057b2';
update public.leads set max_assignments = 5 where id = 'aaaa0000-0000-0000-0000-00000000c0f1';
select test_util.assert_raises_like(
  $q$select public.admin_swap_lead_assignment('cccc0000-0000-0000-0000-000000000010',
       'aaaa0000-0000-0000-0000-00000000c0f1', true)$q$,
  '%retired from allocation%', 'the swap refuses a flagged lead IN, override or not');
-- Absent from the picker rather than greyed: the flag stamps withdrawn_at, and
-- a withdrawn lead is not stock in any picker (0141, 0144) — the same
-- treatment a swap-withdrawn lead gets.
select test_util.assert_eq(
  (select count(*)::integer from public.get_swap_candidates_for_assignment('cccc0000-0000-0000-0000-000000000010')
    where id = 'aaaa0000-0000-0000-0000-00000000c0f1'),
  0, 'the swap picker does not offer a withdrawn, flagged lead');
update public.leads set max_assignments = 1 where id = 'aaaa0000-0000-0000-0000-00000000c0f1';

-- ---------------------------------------------------------------------------
-- 4 — The pool: a never-sold flagged lead never pools, and one already in
--     the pool is out of it immediately
-- ---------------------------------------------------------------------------
update public.leads set created_at = now() - interval '40 days'
  where id = 'aaaa0000-0000-0000-0000-00000000ee01';
select test_util.assert_eq(
  (select count(*)::integer from public.get_pool_entry_candidates()
    where lead_id = 'aaaa0000-0000-0000-0000-00000000ee01'),
  1, 'NEVER is a pool entry candidate before flagging');
select public.flag_stayful_conflict('aaaa0000-0000-0000-0000-00000000ee01', '2', 'group_mksxb5m0', 'phone');
select test_util.assert_eq(
  (select count(*)::integer from public.get_pool_entry_candidates()
    where lead_id = 'aaaa0000-0000-0000-0000-00000000ee01'),
  0, 'NEVER is not a pool entry candidate after flagging');
select test_util.assert_eq(
  (select withdrawn_slots from public.leads where id = 'aaaa0000-0000-0000-0000-00000000ee01'),
  3, 'a never-sold lead leaving supply records its whole cap');
select test_util.assert_eq(
  (select max_assignments from public.leads where id = 'aaaa0000-0000-0000-0000-00000000ee01'),
  0, 'clamped to zero: nothing can ever be placed');

-- OLDSTOCK force-in'd to the pool, then flagged: invisible at once.
update public.leads set assignment_count = 0, max_assignments = 3
  where id = 'aaaa0000-0000-0000-0000-0000000001d0';
delete from public.lead_assignments where lead_id = 'aaaa0000-0000-0000-0000-0000000001d0';
update public.leads set pool_entered_at = now(), pool_first_entered_at = now(), pool_entry_basis = 'unassigned'
  where id = 'aaaa0000-0000-0000-0000-0000000001d0';
select test_util.assert_eq(
  public.customer_can_see_pool_lead('aaaa0000-0000-0000-0000-0000000001d0', '22222222-2222-2222-2222-222222222222'),
  true, 'OLDSTOCK is visible in Filt''s pool before flagging');
select public.flag_stayful_conflict('aaaa0000-0000-0000-0000-0000000001d0', '3', 'group_mm47p8js', 'item');
select test_util.assert_eq(
  public.customer_can_see_pool_lead('aaaa0000-0000-0000-0000-0000000001d0', '22222222-2222-2222-2222-222222222222'),
  false, 'OLDSTOCK is out of the pool the moment it is flagged');

-- ---------------------------------------------------------------------------
-- 5 — Idempotent, and the refusals
-- ---------------------------------------------------------------------------
create temporary table before_reflag as
  select md5(row(l.*)::text) as fp,
         (select count(*) from public.owed_lead_replacements) as owed
  from public.leads l where l.id = 'aaaa0000-0000-0000-0000-00000000c0f1';
select test_util.assert_eq(
  (select count(*)::integer from public.flag_stayful_conflict(
     'aaaa0000-0000-0000-0000-00000000c0f1', 'x', 'group_mm28ypgs', 'item')),
  0, 'a second flag returns zero rows');
select test_util.assert_eq(
  (select md5(row(l.*)::text) from public.leads l where l.id = 'aaaa0000-0000-0000-0000-00000000c0f1'),
  (select fp from before_reflag), 'a second flag changes nothing on the lead');
select test_util.assert_eq(
  (select count(*) from public.owed_lead_replacements),
  (select owed from before_reflag), 'a second flag writes no owed row');

select test_util.assert_raises_like(
  $q$select public.flag_stayful_conflict('bbbb0000-0000-0000-0000-00000000c0f1', '1', 'group_mm28ypgs', 'item')$q$,
  '%management%', 'a GR lead is refused');
update public.leads set owner_customer_id = '11111111-1111-1111-1111-111111111111', owner_source = 'manual'
  where id = 'aaaa0000-0000-0000-0000-0000000057b2';
select test_util.assert_raises_like(
  $q$select public.flag_stayful_conflict('aaaa0000-0000-0000-0000-0000000057b2', '1', 'group_mm28ypgs', 'item')$q$,
  '%added by a customer%', 'an owned lead is refused');
update public.leads set owner_customer_id = null, owner_source = null
  where id = 'aaaa0000-0000-0000-0000-0000000057b2';
select test_util.assert_raises_like(
  $q$select public.flag_stayful_conflict('aaaa0000-0000-0000-0000-0000000057a1', '1', 'group_mm28ypgs', 'name')$q$,
  '%Unknown match basis%', 'an unknown basis is refused');
select test_util.assert_raises_like(
  $q$select public.flag_stayful_conflict('00000000-0000-0000-0000-000000000000', '1', 'group_mm28ypgs', 'item')$q$,
  '%not found%', 'an unknown lead is refused');

-- ---------------------------------------------------------------------------
-- 6 — Who is owed a replacement this lead would satisfy
-- ---------------------------------------------------------------------------
-- STOCK-A is a BS 4-bed: Unfilt and Filt qualify, Paused does not.
select test_util.assert_eq(
  (select string_agg(customer_id::text, ',' order by owed_since, customer_id)
     from public.open_owed_replacements_for_lead('aaaa0000-0000-0000-0000-0000000057a1')),
  '11111111-1111-1111-1111-111111111111,22222222-2222-2222-2222-222222222222',
  'STOCK-A: Unfilt and Filt are owed and eligible; Paused is not');
-- STOCK-B is a SW 1-bed: Filt''s filter refuses it. (Unfilt holds STOCK-B
-- from §3, so nobody qualifies.)
select test_util.assert_eq(
  (select count(*)::integer from public.open_owed_replacements_for_lead('aaaa0000-0000-0000-0000-0000000057b2')),
  0, 'STOCK-B: Filt is refused by their filter and Unfilt already holds it');
delete from public.lead_assignments where id = 'cccc0000-0000-0000-0000-000000000010';
update public.leads set assignment_count = 0 where id = 'aaaa0000-0000-0000-0000-0000000057b2';
select test_util.assert_eq(
  (select string_agg(customer_id::text, ',')
     from public.open_owed_replacements_for_lead('aaaa0000-0000-0000-0000-0000000057b2')),
  '11111111-1111-1111-1111-111111111111',
  'STOCK-B: Unfilt only');
select test_util.assert_eq(
  (select count(*)::integer from public.open_owed_replacements_for_lead('00000000-0000-0000-0000-000000000000')),
  0, 'an unknown lead is owed to nobody');

-- One row per customer even when they are owed twice.
insert into public.owed_lead_replacements
  (customer_id, lead_type, origin_lead_id, origin_assignment_id, origin_status, price_paid)
values ('11111111-1111-1111-1111-111111111111','management',
        'aaaa0000-0000-0000-0000-00000000c0f1','dddd0000-0000-0000-0000-000000000001','new',15.00);
select test_util.assert_eq(
  (select count(*)::integer from public.open_owed_replacements_for_lead('aaaa0000-0000-0000-0000-0000000057a1')
    where customer_id = '11111111-1111-1111-1111-111111111111'),
  1, 'a customer owed twice appears once per arriving lead');

-- ---------------------------------------------------------------------------
-- 7 — Fulfilment: filter, price, depth, no money, once
-- ---------------------------------------------------------------------------
create temporary table filt_owed as
  select id from public.owed_lead_replacements
   where origin_assignment_id = 'cccc0000-0000-0000-0000-000000000002';
create temporary table before_fulfil as select test_util.money_fingerprint() as fp;

select test_util.assert_raises_like(
  format($q$select public.fulfil_owed_replacement('%s', 'aaaa0000-0000-0000-0000-0000000057b2')$q$,
         (select id from filt_owed)),
  '%filter%', 'a lead outside the filter is refused');
select test_util.assert_eq(
  (select status from public.owed_lead_replacements where id = (select id from filt_owed)),
  'open', 'a refused fulfilment leaves the row open');
select test_util.assert_eq(
  (select assignment_count from public.leads where id = 'aaaa0000-0000-0000-0000-0000000057b2'),
  0, 'a refused fulfilment writes no assignment');

create temporary table new_asg as
  select public.fulfil_owed_replacement((select id from filt_owed), 'aaaa0000-0000-0000-0000-0000000057a1') as id;
select test_util.assert_eq((select id is not null from new_asg), true, 'fulfilment returns an assignment id');
select test_util.assert_eq(
  (select price_paid from public.lead_assignments where id = (select id from new_asg)),
  15.00, 'the replacement carries the SAME price');
select test_util.assert_eq(
  (select replacement_depth from public.lead_assignments where id = (select id from new_asg)),
  1, 'one replacement deeper');
select test_util.assert_eq(
  (select customer_id from public.lead_assignments where id = (select id from new_asg)),
  '22222222-2222-2222-2222-222222222222'::uuid, 'placed with the customer who was owed');
select test_util.assert_eq(
  (select assignment_count from public.leads where id = 'aaaa0000-0000-0000-0000-0000000057a1'),
  1, 'the replacement lead''s count moved');
select test_util.assert_eq(
  (select status from public.owed_lead_replacements where id = (select id from filt_owed)),
  'fulfilled', 'the owed row is fulfilled');
select test_util.assert_eq(
  (select fulfilled_assignment_id from public.owed_lead_replacements where id = (select id from filt_owed)),
  (select id from new_asg), 'the owed row names the new assignment');
select test_util.assert_eq(
  test_util.money_fingerprint(), (select fp from before_fulfil),
  'NO MONEY MOVED on fulfilment');
select test_util.assert_raises_like(
  format($q$select public.fulfil_owed_replacement('%s', 'aaaa0000-0000-0000-0000-0000000057a1')$q$,
         (select id from filt_owed)),
  '%already settled%', 'a settled row cannot be fulfilled twice');

-- Refusals on the incoming lead.
create temporary table unfilt_owed as
  select id from public.owed_lead_replacements
   where origin_assignment_id = 'cccc0000-0000-0000-0000-000000000001';
select test_util.assert_raises_like(
  format($q$select public.fulfil_owed_replacement('%s', 'aaaa0000-0000-0000-0000-00000000ee01')$q$,
         (select id from unfilt_owed)),
  '%withdrawn%', 'a withdrawn lead is refused');
update public.leads set lead_quality_status = 'failed', lead_quality_codes = array['name_junk']
  where id = 'aaaa0000-0000-0000-0000-0000000057b2';
select test_util.assert_raises_like(
  format($q$select public.fulfil_owed_replacement('%s', 'aaaa0000-0000-0000-0000-0000000057b2')$q$,
         (select id from unfilt_owed)),
  '%retired%', 'a quality-blocked lead is refused');
update public.leads set lead_quality_status = 'passed', lead_quality_codes = '{}'
  where id = 'aaaa0000-0000-0000-0000-0000000057b2';
update public.leads set max_assignments = 0 where id = 'aaaa0000-0000-0000-0000-0000000057b2';
select test_util.assert_raises_like(
  format($q$select public.fulfil_owed_replacement('%s', 'aaaa0000-0000-0000-0000-0000000057b2')$q$,
         (select id from unfilt_owed)),
  '%max assignments%', 'a full lead is refused');
update public.leads set max_assignments = 3 where id = 'aaaa0000-0000-0000-0000-0000000057b2';
select test_util.assert_raises_like(
  format($q$select public.fulfil_owed_replacement('%s', 'bbbb0000-0000-0000-0000-00000000c0f1')$q$,
         (select id from unfilt_owed)),
  '%same product%', 'a GR lead cannot settle a management debt');
create temporary table paused_owed as
  select id from public.owed_lead_replacements
   where origin_assignment_id = 'cccc0000-0000-0000-0000-000000000003';
select test_util.assert_raises_like(
  format($q$select public.fulfil_owed_replacement('%s', 'aaaa0000-0000-0000-0000-0000000057b2')$q$,
         (select id from paused_owed)),
  '%paused%', 'a paused management customer is refused');

-- Fulfilment ignores the daily curve and the cap.
update public.system_settings set value = 'true' where key = 'release_enabled';
update public.system_settings set value = '1' where key = 'release_max_per_day';
update public.customers set leads_received_this_month = 20, lead_balance = 0
  where id = '11111111-1111-1111-1111-111111111111';
select test_util.assert_eq(
  public.customer_release_allows('11111111-1111-1111-1111-111111111111'),
  false, 'Unfilt is refused by the release rule right now');
create temporary table unfilt_asg as
  select public.fulfil_owed_replacement((select id from unfilt_owed), 'aaaa0000-0000-0000-0000-0000000057b2') as id;
select test_util.assert_eq((select id is not null from unfilt_asg), true,
  'fulfilment ignores the curve, the cap and the empty balance');
update public.system_settings set value = 'false' where key = 'release_enabled';
update public.system_settings set value = '2' where key = 'release_max_per_day';
update public.customers set leads_received_this_month = 3, lead_balance = 9
  where id = '11111111-1111-1111-1111-111111111111';

-- ---------------------------------------------------------------------------
-- 8 — From stock: newest matching lead, null when nothing fits or the
--     customer cannot receive
-- ---------------------------------------------------------------------------
-- The second Unfilt debt (seeded in §6). Stock: STOCK-A (1/3, 1 day old,
-- held by Filt) and NEWEST (just now). Newest wins.
insert into public.leads
  (id, monday_item_id, lead_name, postcode, postcode_area, bedrooms,
   max_assignments, assignment_count, created_at, lead_quality_status)
values ('aaaa0000-0000-0000-0000-00000000ee55','m-newest','Newest','BS9 9ZZ','BS','2 bedrooms',3,0, now(),'passed');
create temporary table stock_asg as
  select public.fulfil_owed_from_stock(
    (select id from public.owed_lead_replacements
      where origin_assignment_id = 'dddd0000-0000-0000-0000-000000000001')) as id;
select test_util.assert_eq(
  (select lead_id from public.lead_assignments where id = (select id from stock_asg)),
  'aaaa0000-0000-0000-0000-00000000ee55'::uuid, 'from stock picks the NEWEST matching lead');
select test_util.assert_eq(
  (select public.fulfil_owed_from_stock((select id from paused_owed)) is null),
  true, 'a paused customer gets null, not an error');
select test_util.assert_eq(
  (select status from public.owed_lead_replacements where id = (select id from paused_owed)),
  'open', 'and their row stays open');
-- Filt owed again with nothing in BS 3+ left that they do not hold.
insert into public.owed_lead_replacements
  (customer_id, lead_type, origin_lead_id, origin_assignment_id, origin_status, price_paid)
values ('22222222-2222-2222-2222-222222222222','management',
        'aaaa0000-0000-0000-0000-00000000c0f1','dddd0000-0000-0000-0000-000000000002','new',15.00);
update public.leads set max_assignments = 1 where id = 'aaaa0000-0000-0000-0000-00000000ee55';
select test_util.assert_eq(
  (select public.fulfil_owed_from_stock(
     (select id from public.owed_lead_replacements
       where origin_assignment_id = 'dddd0000-0000-0000-0000-000000000002')) is null),
  true, 'nothing matching in stock returns null and waits');

-- ---------------------------------------------------------------------------
-- 9 — Ordinary routing still works afterwards
-- ---------------------------------------------------------------------------
insert into public.leads
  (id, monday_item_id, lead_name, postcode, postcode_area, bedrooms,
   max_assignments, assignment_count, lead_quality_status)
values ('aaaa0000-0000-0000-0000-00000000f1e5','m-fresh','Fresh','BS8 8HH','BS','3 bedrooms',3,0,'passed');
select test_util.assert_eq(
  (select count(*)::integer from public.get_unfiltered_candidates_for_lead('aaaa0000-0000-0000-0000-00000000f1e5', 10)
    where customer_id = '11111111-1111-1111-1111-111111111111'),
  1, 'a fresh lead still reaches Unfilt through the candidate function');
select public.assign_lead_to_customer(
  'aaaa0000-0000-0000-0000-00000000f1e5', '11111111-1111-1111-1111-111111111111', 15.00);
select test_util.assert_eq(
  (select lead_balance from public.customers where id = '11111111-1111-1111-1111-111111111111'),
  8, 'and still spends exactly one credit');

-- ---------------------------------------------------------------------------
-- 10 — ACLs and invariant 7
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('flag_stayful_conflict','fulfil_owed_replacement','fulfil_owed_from_stock',
                        'open_owed_replacements_for_lead','lead_retirement_reason','lead_pool_barred')
      and (has_function_privilege('anon', p.oid, 'execute')
        or has_function_privilege('authenticated', p.oid, 'execute'))),
  0, 'anon and authenticated can execute none of the 0155 functions');
select test_util.assert_eq(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('flag_stayful_conflict','fulfil_owed_replacement','fulfil_owed_from_stock',
                        'open_owed_replacements_for_lead','lead_retirement_reason','lead_pool_barred')
      and has_function_privilege('service_role', p.oid, 'execute')),
  6, 'service_role can execute all six');
select test_util.assert_eq(
  (select count(distinct p.proname)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('get_engagement_benchmarks','set_management_customer_goal',
                        'get_operator_proof','get_recent_wins_anonymised')
      and has_function_privilege('authenticated', p.oid, 'execute')),
  4, 'invariant 7: the four customer-callable functions still are');
select test_util.assert_eq(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'lead_retired_from_allocation'
      and p.prosrc like '%lead_retirement_reason%'
      and p.prosrc not like '%stayful_conflict_at%'),
  1, 'lead_retired_from_allocation still delegates and carries no arm of its own');

-- ---------------------------------------------------------------------------
-- Teardown
-- ---------------------------------------------------------------------------
delete from public.owed_lead_replacements;
delete from public.lead_outcome_reasons;
delete from public.lead_quality_claims;
delete from public.lead_events;
delete from public.lead_notes;
delete from public.lead_assignments;
delete from public.leads;
delete from public.customers;

\o
select '0155 BEHAVIOURAL TESTS PASSED' as result;
