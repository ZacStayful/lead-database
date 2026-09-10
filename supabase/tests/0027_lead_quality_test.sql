-- Behavioural tests for migration 0027, run against the migrated database.
\set ON_ERROR_STOP on
\pset pager off
-- Assertions report through NOTICE (stderr); the result rows themselves are
-- noise, so send query output to /dev/null and let the notices speak.
\o /dev/null

-- The helper lives in its own schema so it never lands in public, where it
-- would show up as drift when schema.sql is compared against the migrations.
create schema if not exists test_util;

create or replace function test_util.assert_eq(actual anyelement, expected anyelement, label text)
returns void language plpgsql as $$
begin
  if actual is distinct from expected then
    raise exception 'FAIL % — expected %, got %', label, expected, actual;
  end if;
  raise notice 'ok  %', label;
end $$;

-- ---------------------------------------------------------------------------
-- Seed: three operators, all active with credit, and one lead.
-- ---------------------------------------------------------------------------
delete from public.lead_quality_claims;
delete from public.lead_assignments;
delete from public.leads;
delete from public.customers;

insert into public.customers
  (id, business_name, contact_name, email, subscription_status, account_status,
   is_active, monthly_allocation, lead_balance, leads_received_this_month,
   billing_cycle_anchor)
values
  ('11111111-1111-1111-1111-111111111111','Alpha Lets','A','a@x.com','active','active',true,20,20,0,current_date),
  ('22222222-2222-2222-2222-222222222222','Beta Stays','B','b@x.com','active','active',true,20,20,0,current_date),
  ('33333333-3333-3333-3333-333333333333','Gamma Homes','C','c@x.com','active','active',true,20,20,0,current_date);

insert into public.leads (id, monday_item_id, lead_name, address, bedrooms, enquiry_date)
values ('aaaaaaaa-0000-0000-0000-000000000001','m1','Landlord One','12 Elm St, Leeds, LS1 1AA','3','2026-09-01');

-- ---------------------------------------------------------------------------
-- 1. max_assignments defaults to 3, and three operators can all be assigned.
-- ---------------------------------------------------------------------------
select test_util.assert_eq(max_assignments, 3, 'new leads default to 3 operators')
from public.leads where id='aaaaaaaa-0000-0000-0000-000000000001';

select public.assign_lead_to_customer('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',15.0) \gset a_
select public.assign_lead_to_customer('aaaaaaaa-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222',15.0) \gset b_
select public.assign_lead_to_customer('aaaaaaaa-0000-0000-0000-000000000001','33333333-3333-3333-3333-333333333333',15.0) \gset c_

select test_util.assert_eq(assignment_count, 3, 'all three slots filled')
from public.leads where id='aaaaaaaa-0000-0000-0000-000000000001';

-- A fourth is refused.
do $$
begin
  perform public.assign_lead_to_customer('aaaaaaaa-0000-0000-0000-000000000001',
    '11111111-1111-1111-1111-111111111111', 15.0);
  raise exception 'FAIL a fourth assignment should be refused';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  raise notice 'ok  a fourth assignment is refused';
end $$;

-- 2. Assignment spends a credit and grows the clean streak.
select test_util.assert_eq(lead_balance, 19, 'assignment spends one credit'),
       test_util.assert_eq(leads_received_this_month, 1, 'monthly counter incremented'),
       test_util.assert_eq(clean_leads_streak, 1, 'clean streak grows on assignment')
from public.customers where id='11111111-1111-1111-1111-111111111111';

-- ---------------------------------------------------------------------------
-- 3. An upheld claim: credit back, counter back, streak reset, allowance spent,
--    and — the important one — assignment_count UNCHANGED.
-- ---------------------------------------------------------------------------
update public.customers set clean_leads_streak = 12
  where id='11111111-1111-1111-1111-111111111111';

select * from public.apply_quality_claim(
  :'a_assign_lead_to_customer'::uuid,
  '11111111-1111-1111-1111-111111111111',
  'already_with_operator',
  'They signed with another agent a fortnight ago.',
  current_date, 2, 'auto_uphold', true, 'none'
) \gset claim1_

select test_util.assert_eq(lead_balance, 20, 'upheld claim restores the credit'),
       test_util.assert_eq(leads_received_this_month, 0, 'upheld claim rolls back the counter'),
       test_util.assert_eq(quality_claims_this_cycle, 1, 'upheld claim spends allowance'),
       test_util.assert_eq(clean_leads_streak, 0, 'upheld claim resets the clean streak')
from public.customers where id='11111111-1111-1111-1111-111111111111';

select test_util.assert_eq(assignment_count, 3, 'the claimed slot is NOT reopened')
from public.leads where id='aaaaaaaa-0000-0000-0000-000000000001';

select test_util.assert_eq(status, 'rejected', 'upheld claim rejects the assignment'),
       test_util.assert_eq(rejection_reason, 'already_with_operator', 'reason recorded'),
       test_util.assert_eq((rejected_at is not null), true, 'rejected_at stamped')
from public.lead_assignments where id = :'a_assign_lead_to_customer'::uuid;

-- 4. Claiming the same assignment twice is an idempotent no-op.
select applied from public.apply_quality_claim(
  :'a_assign_lead_to_customer'::uuid,
  '11111111-1111-1111-1111-111111111111',
  'already_with_operator', 'Trying again to double-dip on the credit.',
  current_date, 1, 'auto_uphold', true, 'none'
) \gset dup_
select test_util.assert_eq(:'dup_applied'::boolean, false, 'a second claim is a no-op');
select test_util.assert_eq(lead_balance, 20, 'a second claim does not double-refund')
from public.customers where id='11111111-1111-1111-1111-111111111111';
select test_util.assert_eq(count(*)::int, 1, 'only one claim row exists')
from public.lead_quality_claims
where lead_assignment_id = :'a_assign_lead_to_customer'::uuid;

-- ---------------------------------------------------------------------------
-- 5. The lead is 'suspect' after one claim, 'dead' only when all three agree.
-- ---------------------------------------------------------------------------
select public.flag_lead_dead_if_unanimous('aaaaaaaa-0000-0000-0000-000000000001');
select test_util.assert_eq(quality_flag, 'suspect', 'one claim marks the lead suspect')
from public.leads where id='aaaaaaaa-0000-0000-0000-000000000001';

select applied from public.apply_quality_claim(
  :'b_assign_lead_to_customer'::uuid, '22222222-2222-2222-2222-222222222222',
  'already_with_operator', 'Same story — they went with someone else.',
  current_date, 1, 'auto_uphold', false, 'peer_agrees') \gset b1_
select public.flag_lead_dead_if_unanimous('aaaaaaaa-0000-0000-0000-000000000001');
select test_util.assert_eq(quality_flag, 'suspect', 'two of three is still only suspect')
from public.leads where id='aaaaaaaa-0000-0000-0000-000000000001';

-- Corroborated claims cost no allowance.
select test_util.assert_eq(quality_claims_this_cycle, 0, 'a corroborated claim spends no allowance')
from public.customers where id='22222222-2222-2222-2222-222222222222';

select applied from public.apply_quality_claim(
  :'c_assign_lead_to_customer'::uuid, '33333333-3333-3333-3333-333333333333',
  'already_with_operator', 'Landlord confirmed they appointed another agent.',
  current_date, 1, 'auto_uphold', false, 'peer_agrees') \gset c1_
select public.flag_lead_dead_if_unanimous('aaaaaaaa-0000-0000-0000-000000000001');
select test_util.assert_eq(quality_flag, 'dead', 'unanimous claims mark the lead dead')
from public.leads where id='aaaaaaaa-0000-0000-0000-000000000001';

-- 6. A dead lead is never assigned again.
do $$
begin
  perform public.assign_lead_to_customer('aaaaaaaa-0000-0000-0000-000000000001',
    '11111111-1111-1111-1111-111111111111', 15.0);
  raise exception 'FAIL a dead lead must not be assignable';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  raise notice 'ok  a dead lead is never assigned again';
end $$;

-- ---------------------------------------------------------------------------
-- 7. find_replacement_lead: open slots only, never one they hold, never dead,
--    and it honours the filter.
-- ---------------------------------------------------------------------------
insert into public.leads (id, monday_item_id, lead_name, address, bedrooms, enquiry_date, created_at)
values
  ('aaaaaaaa-0000-0000-0000-000000000002','m2','Fresh Leeds','5 Oak Rd, Leeds, LS2 2BB','4','2026-09-08', now()),
  ('aaaaaaaa-0000-0000-0000-000000000003','m3','Older York','7 Ash Ln, York, YO1 1CC','1','2026-09-02', now() - interval '5 days');

select public.find_replacement_lead('11111111-1111-1111-1111-111111111111','management',null) \gset r_
select test_util.assert_eq(:'r_find_replacement_lead'::uuid,
  'aaaaaaaa-0000-0000-0000-000000000002'::uuid, 'replacement picks the freshest open lead');

select public.find_replacement_lead('11111111-1111-1111-1111-111111111111','management',
  '{"cities":["York"]}'::jsonb) \gset rc_
select test_util.assert_eq(:'rc_find_replacement_lead'::uuid,
  'aaaaaaaa-0000-0000-0000-000000000003'::uuid, 'the city filter is honoured');

select public.find_replacement_lead('11111111-1111-1111-1111-111111111111','management',
  '{"min_bedrooms":4}'::jsonb) \gset rb_
select test_util.assert_eq(:'rb_find_replacement_lead'::uuid,
  'aaaaaaaa-0000-0000-0000-000000000002'::uuid, 'the bedrooms filter is honoured');

select test_util.assert_eq(public.find_replacement_lead('11111111-1111-1111-1111-111111111111','management',
  '{"cities":["Nowhere"]}'::jsonb), null::uuid, 'no match returns null, so the caller credits instead');

-- A lead they already hold is never offered back.
select public.assign_lead_to_customer('aaaaaaaa-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111',15.0);
select test_util.assert_eq(public.find_replacement_lead('11111111-1111-1111-1111-111111111111','management',
  '{"min_bedrooms":4}'::jsonb), null::uuid, 'a lead they already hold is not offered');

-- ---------------------------------------------------------------------------
-- 8. leads_with_open_slots: oldest first, excludes dead leads.
-- ---------------------------------------------------------------------------
select test_util.assert_eq((select count(*)::int from public.leads_with_open_slots(10)
                  where lead_id='aaaaaaaa-0000-0000-0000-000000000001'), 0,
                 'the dead lead is not in the backfill queue');
select test_util.assert_eq((select lead_id from public.leads_with_open_slots(10) limit 1),
                 'aaaaaaaa-0000-0000-0000-000000000003'::uuid,
                 'the backfill queue is oldest-first');

-- ---------------------------------------------------------------------------
-- 9. apply_lead_rejection with restore no longer reopens the slot either.
-- ---------------------------------------------------------------------------
insert into public.leads (id, monday_item_id, lead_name) values
  ('aaaaaaaa-0000-0000-0000-000000000004','m4','Bad Contact');
select public.assign_lead_to_customer('aaaaaaaa-0000-0000-0000-000000000004','22222222-2222-2222-2222-222222222222',15.0) \gset ic_

select applied from public.apply_lead_rejection(
  :'ic_assign_lead_to_customer'::uuid, '22222222-2222-2222-2222-222222222222',
  'management', 'invalid_contact', '{"outcome":"claim_confirmed"}'::jsonb, true, false) \gset ic1_

select test_util.assert_eq(assignment_count, 1, 'invalid_contact does not reopen the slot either')
from public.leads where id='aaaaaaaa-0000-0000-0000-000000000004';
select test_util.assert_eq((select rejected_at is not null from public.lead_assignments
                  where id = :'ic_assign_lead_to_customer'::uuid), true,
                 'invalid_contact stamps rejected_at');

-- ---------------------------------------------------------------------------
-- 10. resolve_quality_claim: one decision only, and it applies the uphold.
-- ---------------------------------------------------------------------------
insert into public.leads (id, monday_item_id, lead_name) values
  ('aaaaaaaa-0000-0000-0000-000000000005','m5','Review Me');
select public.assign_lead_to_customer('aaaaaaaa-0000-0000-0000-000000000005','33333333-3333-3333-3333-333333333333',15.0) \gset rv_

select claim_id from public.apply_quality_claim(
  :'rv_assign_lead_to_customer'::uuid, '33333333-3333-3333-3333-333333333333',
  'no_longer_interested', 'They have taken the property off the market entirely.',
  current_date, 1, 'review', false, 'none') \gset rev_

select test_util.assert_eq(status, 'under_review', 'a reviewed claim waits for a human')
from public.lead_quality_claims where id = :'rev_claim_id'::uuid;
select test_util.assert_eq(status, 'new', 'a reviewed claim leaves the assignment alone')
from public.lead_assignments where id = :'rv_assign_lead_to_customer'::uuid;

select public.resolve_quality_claim(:'rev_claim_id'::uuid, true, null, 'Checked with the landlord.', true) \gset res_
select test_util.assert_eq(:'res_resolve_quality_claim'::boolean, true, 'the first decision applies');
select test_util.assert_eq(status, 'rejected', 'upholding on review rejects the assignment')
from public.lead_assignments where id = :'rv_assign_lead_to_customer'::uuid;

select public.resolve_quality_claim(:'rev_claim_id'::uuid, true, null, 'Double click.', true) \gset res2_
select test_util.assert_eq(:'res2_resolve_quality_claim'::boolean, false, 'a second decision is refused');

-- ---------------------------------------------------------------------------
-- 11. An ineligible report is stored but changes nothing on the assignment.
-- ---------------------------------------------------------------------------
insert into public.leads (id, monday_item_id, lead_name) values
  ('aaaaaaaa-0000-0000-0000-000000000006','m6','Untouched');
select public.assign_lead_to_customer('aaaaaaaa-0000-0000-0000-000000000006','11111111-1111-1111-1111-111111111111',15.0) \gset el_

select applied from public.apply_quality_claim(
  :'el_assign_lead_to_customer'::uuid, '11111111-1111-1111-1111-111111111111',
  'unreachable', 'no', null, 0, 'ineligible', false, 'none') \gset inel_

select test_util.assert_eq(rejection_reason, null::text, 'an ineligible report leaves the assignment claimable')
from public.lead_assignments where id = :'el_assign_lead_to_customer'::uuid;
select test_util.assert_eq(count(*)::int, 1, 'the ineligible report is still recorded as feedback')
from public.lead_quality_claims
where lead_assignment_id = :'el_assign_lead_to_customer'::uuid and status='ineligible';

-- A proper claim afterwards replaces it and works normally.
select applied from public.apply_quality_claim(
  :'el_assign_lead_to_customer'::uuid, '11111111-1111-1111-1111-111111111111',
  'unreachable', 'Six calls and two emails over ten days, nothing back.',
  current_date, 6, 'auto_uphold', true, 'none') \gset ok_
select test_util.assert_eq(:'ok_applied'::boolean, true, 'a proper claim can follow an ineligible report');
select test_util.assert_eq(count(*)::int, 1, 'the ineligible row is replaced, not duplicated')
from public.lead_quality_claims
where lead_assignment_id = :'el_assign_lead_to_customer'::uuid;

-- ---------------------------------------------------------------------------
-- 12. reset_monthly_counts zeroes the allowance counter on the anchor day.
-- ---------------------------------------------------------------------------
update public.customers
  set quality_claims_this_cycle = 5,
      leads_received_this_month = 7,
      billing_cycle_anchor = current_date;
select public.reset_monthly_counts();
select test_util.assert_eq(quality_claims_this_cycle, 0, 'the allowance resets with the cycle'),
       test_util.assert_eq(leads_received_this_month, 0, 'the monthly counter still resets')
from public.customers where id='11111111-1111-1111-1111-111111111111';

-- Not the anchor day: nothing resets.
update public.customers
  set quality_claims_this_cycle = 4,
      billing_cycle_anchor = current_date - interval '10 days';
select public.reset_monthly_counts();
select test_util.assert_eq(quality_claims_this_cycle, 4, 'the allowance holds outside the anchor day')
from public.customers where id='11111111-1111-1111-1111-111111111111';

\o
\echo '== ALL BEHAVIOURAL TESTS PASSED =='
