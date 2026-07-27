-- ============================================================================
-- Backfill management_lifetime_leads_received from assignment history.
--
-- 0050 added the odometer with DEFAULT 0, which is correct for a column that
-- only counts forward — but it leaves every existing subscriber starting from
-- zero, and the goals page reads the won count live from lead_assignments over
-- all history. An eight-month customer who has signed three landlords would
-- therefore see, on one screen:
--
--     Won clients        3 of 5 won
--     Leads received so far        0
--
-- Three clients won from zero leads. That is not a conservative estimate, it is
-- a self-contradiction, and it would greet every existing customer on the day
-- the tab appears. This seeds the odometer so the page is coherent from the
-- first render.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS COUNTS, AND WHAT IT CANNOT
-- ---------------------------------------------------------------------------
-- One row per (lead, customer) in lead_assignments, restricted to leads whose
-- lead_type is 'management'. That includes admin-placed and reclaimed leads,
-- both of which 0050 also counts going forward, so the backfill and the live
-- increments agree about what "received" means.
--
-- It CANNOT see discarded leads: discard_lead_assignment (0010) deletes the
-- row outright, so a lead that was delivered and then discarded leaves no
-- trace to count. The backfill therefore UNDERSTATES history slightly.
--
-- That error runs in the safe direction. A lower "leads received so far" means
-- a higher "leads still needed" and a longer estimated time — the page promises
-- less than the customer has actually had, never more. Discard also requires
-- status = 'new' AND no notes, so it is a narrow path and the shortfall should
-- be small in practice.
--
-- ---------------------------------------------------------------------------
-- WHY greatest(), AND WHY THIS IS SAFE TO RE-RUN
-- ---------------------------------------------------------------------------
-- The odometer is monotonic by contract: it must never decrease. Assigning the
-- computed count outright would break that if this ever ran a second time
-- after some leads had been discarded — the live counter would be higher than
-- the recomputed count, and the customer's "leads received" would visibly go
-- backwards. greatest() makes the statement idempotent and monotonic: running
-- it once, twice, or a year later can only ever hold the value steady or raise
-- it.
--
-- It also removes any ordering hazard between this migration and 0050. If a
-- lead happens to be assigned between the two running, the live increment is
-- preserved rather than overwritten.
-- ============================================================================

update public.customers c
   set management_lifetime_leads_received = greatest(
         history.received,
         c.management_lifetime_leads_received
       ),
       updated_at = now()
  from (
    select la.customer_id, count(*)::integer as received
      from public.lead_assignments la
      join public.leads l on l.id = la.lead_id
     where l.lead_type = 'management'
     group by la.customer_id
  ) as history
 where c.id = history.customer_id
   and history.received > c.management_lifetime_leads_received;
