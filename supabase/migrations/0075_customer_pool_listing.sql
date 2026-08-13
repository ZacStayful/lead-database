-- ============================================================================
-- 0075 — What a customer sees in their expired leads pool.
--
-- The read side of the claim. Visibility is NOT re-stated here: the function
-- calls customer_can_see_pool_lead (0074), the same predicate claim_pool_lead
-- enforces under its row lock. A lead can therefore never be listed but
-- unclaimable, or claimable but unlisted — the arrangement §5E describes for
-- reject, applied to the pool.
--
-- ---------------------------------------------------------------------------
-- LEAD AGE, AND WHY IT IS NOT SIMPLY THE ENQUIRY DATE
-- ---------------------------------------------------------------------------
-- The brief asks the card to show "days since the enquiry". leads.enquiry_date
-- is free text from Monday of uneven quality, which is why safe_enquiry_date()
-- exists (0062) and why CLAUDE.md §11 records that the column is rendered
-- nowhere in the product, admin included — lead age is measured from
-- lead_assignments.assigned_at everywhere else.
--
-- Neither of those works here. A pool lead has no assignment belonging to the
-- viewer, so assigned_at is not available; and an unparseable enquiry date
-- would render a blank where the operator most needs a number, because age is
-- the main thing that tells them whether a landlord is worth ringing.
--
-- So: the parsed enquiry date where it parses, leads.created_at where it does
-- not, and a flag saying which. The UI labels the fallback honestly rather than
-- passing an ingest date off as an enquiry date.
--
-- NOTHING ABOUT PREVIOUS HOLDERS IS RETURNED. Not how many operators held the
-- lead, not what they did, not that they did nothing. It is not in the row set
-- at all, so no future UI change can leak it. The brief is explicit, and it is
-- also the right call: "three operators passed on this" is an argument against
-- ringing, and the whole premise is that they never rang.
-- ============================================================================

create or replace function public.get_customer_pool_leads(
  p_customer_id uuid,
  p_lead_type   public.lead_type
)
returns table (
  lead_id            uuid,
  lead_type          public.lead_type,
  lead_name          text,
  address            text,
  phone              text,
  email              text,
  lead_profile       text,
  bedrooms           text,
  postcode           text,
  desired_rent       text,
  enquiry_date       date,
  enquiry_date_known boolean,
  lead_age_days      integer,
  days_in_pool       integer,
  pool_entered_at    timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    l.id,
    l.lead_type,
    l.lead_name,
    l.address,
    l.phone,
    l.email,
    l.lead_profile,
    l.bedrooms,
    l.postcode,
    l.desired_rent,
    public.safe_enquiry_date(l.enquiry_date),
    (public.safe_enquiry_date(l.enquiry_date) is not null),
    (current_date - coalesce(public.safe_enquiry_date(l.enquiry_date), l.created_at::date)),
    (extract(epoch from now() - l.pool_entered_at) / 86400)::integer,
    l.pool_entered_at
  from public.leads l
  where l.lead_type = p_lead_type
    and public.customer_can_see_pool_lead(l.id, p_customer_id)
  -- Freshest into the pool first. A lead that went cold yesterday is a better
  -- call than one that went cold six weeks ago, and the operator scanning the
  -- list should meet the live ones before the dregs.
  order by l.pool_entered_at desc, l.created_at desc;
$$;

revoke execute on function public.get_customer_pool_leads(uuid, public.lead_type)
  from public, anon, authenticated;
grant execute on function public.get_customer_pool_leads(uuid, public.lead_type)
  to service_role;
