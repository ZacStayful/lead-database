-- ============================================================================
-- Lock down the 0043 trigger functions.
--
-- 0043 revoked EXECUTE on mark_assignment_contacted but not on the four thin
-- trigger wrappers that call it. They are SECURITY DEFINER, so they were left
-- granted to PUBLIC (and therefore to anon and authenticated) and surfaced on
-- PostgREST as /rest/v1/rpc/<name> — which the Supabase database linter flags
-- under 0028/0029.
--
-- Practical exposure was nil: PostgreSQL refuses to invoke a function returning
-- `trigger` outside trigger context ("trigger functions can only be called as
-- triggers"), so a caller gets an error rather than an effect. This is
-- housekeeping, not an incident.
--
-- Fixed anyway for two reasons: it keeps the 0028 convention intact (privileged
-- functions are service-role only, no exceptions to reason about later), and it
-- clears the linter so a REAL finding is not lost in a list of known-benign
-- warnings.
--
-- Idempotent: revoking an absent grant is a no-op.
-- ============================================================================

revoke execute on function public.trg_note_marks_contacted()  from public, anon, authenticated;
revoke execute on function public.trg_file_marks_contacted()  from public, anon, authenticated;
revoke execute on function public.trg_stage_marks_contacted() from public, anon, authenticated;
revoke execute on function public.trg_event_marks_contacted() from public, anon, authenticated;

-- The triggers themselves run as the table owner, not as the invoking role, so
-- revoking EXECUTE does not affect firing. Granted to service_role only for
-- symmetry with every other privileged function in the schema.
grant execute on function public.trg_note_marks_contacted()  to service_role;
grant execute on function public.trg_file_marks_contacted()  to service_role;
grant execute on function public.trg_stage_marks_contacted() to service_role;
grant execute on function public.trg_event_marks_contacted() to service_role;
