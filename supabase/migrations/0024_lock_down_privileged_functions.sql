-- ============================================================================
-- Lock down privileged SECURITY DEFINER functions.
--
-- Vulnerability this closes: every RPC in the public schema was created without
-- an EXECUTE grant of its own, so Postgres's default grant to PUBLIC stood, and
-- Supabase's PostgREST exposes public-schema functions to the anon and
-- authenticated roles reachable with the browser anon key
-- (NEXT_PUBLIC_SUPABASE_ANON_KEY). Because these functions are SECURITY DEFINER
-- (they run as the owner and bypass RLS) and several perform NO caller check, a
-- logged-in customer could call them straight from the browser console and
-- bypass every server-side authorization check. Worst cases:
--   * increment_lead_balance(stripe_customer_id, amount) -> self-grant unlimited
--     paid lead credit (customer can read their own stripe_customer_id via RLS).
--   * discard_lead_assignment(id) -> delete ANY customer's lead assignment (IDOR
--     + data destruction; the function does no ownership check).
--   * assign_lead_to_customer / apply_lead_rejection -> mutate balances outside
--     the intended server path.
--
-- These functions are ONLY ever invoked by the server via the service-role
-- client (createAdminClient) — grep confirms zero browser/client .rpc() calls —
-- so revoking EXECUTE from the browser-facing roles breaks nothing.
--
-- Why revoke rather than physically move the functions to a non-exposed schema:
-- the server calls them through supabase-js .rpc(), which routes via PostgREST,
-- and PostgREST only exposes the public schema. Relocating them to an unexposed
-- schema would break the service-role calls too; exposing that schema instead
-- puts them right back within anon's reach, where the EXECUTE grant is again the
-- only thing that matters. Revoking EXECUTE is therefore both the working and
-- the security-effective realization of "the browser cannot call these".
-- ============================================================================

-- Existing functions: strip the default PUBLIC grant (and the roles that inherit
-- it) and hand execution to the service role only. Blanket form so it covers
-- every overload — including the lead-type-aware assign/reject/next-customer
-- variants added in 0015/0017 and credit_invoice from 0023 — without having to
-- enumerate signatures.
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;

-- Future functions created in this schema by the migration role inherit the
-- locked-down default, so a new privileged RPC can't silently reopen the hole.
alter default privileges in schema public
  revoke execute on functions from public, anon, authenticated;
alter default privileges in schema public
  grant execute on functions to service_role;
