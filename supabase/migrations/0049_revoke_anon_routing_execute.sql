-- ============================================================================
-- Re-revoke EXECUTE on get_next_customers_for_lead.
--
-- 0028 blanket-revoked EXECUTE across the public schema so no browser-facing
-- role could call a privileged function. 0038 then did:
--
--     drop function if exists public.get_next_customers_for_lead(...);
--     create or replace function public.get_next_customers_for_lead(...)
--
-- Dropping a function discards its ACL, and the recreated function picked up
-- PostgreSQL's default grant to PUBLIC. The 0028 lockdown has therefore been
-- silently undone for this one function ever since — it is the only function in
-- the schema still reachable by anon or authenticated, and Supabase's database
-- linter has been flagging it (lints 0028/0029).
--
-- WHAT WAS EXPOSED
-- ----------------
-- It is SECURITY DEFINER and surfaced on PostgREST as
-- /rest/v1/rpc/get_next_customers_for_lead. An unauthenticated caller holding a
-- valid lead id could enumerate which customers are next in line to receive it.
-- It returns customer UUIDs only — no names, no email, no lead data — and lead
-- ids are not public, so the severity is low. It is still an information leak
-- about the allocation queue that was never intended.
--
-- WHY THIS IS SAFE TO APPLY
-- -------------------------
-- Every caller in the application uses the service-role client
-- (createAdminClient), which bypasses these grants entirely. There is no
-- browser .rpc() call to this function anywhere in the codebase. Revoking
-- changes no application behaviour.
--
-- Uses an explicit signature rather than a blanket schema-wide revoke so this
-- migration cannot accidentally strip a grant something else depends on —
-- notably get_engagement_benchmarks(), which is INTENTIONALLY callable by
-- authenticated.
-- ============================================================================

revoke execute on function public.get_next_customers_for_lead(
  uuid, integer, uuid[], public.lead_type
) from public, anon, authenticated;

grant execute on function public.get_next_customers_for_lead(
  uuid, integer, uuid[], public.lead_type
) to service_role;
