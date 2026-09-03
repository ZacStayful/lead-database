import { createHash } from "crypto";

/**
 * Helpers for /api/auth/forgot-password (§43).
 *
 * The route used to answer every failure with `{ok:true}` — a missing account,
 * a throttled repeat and a Supabase outage were indistinguishable, and all three
 * rendered as "check your inbox". A customer who had signed up with a different
 * address had no way to find that out. The route now distinguishes them, and the
 * distinguishing lives here so it can be unit tested: `vitest.config.mts` is
 * pure-units-only and the repo has no route-test harness.
 */

/** What went wrong when `generateLink` refused to mint a recovery token. */
export type LinkFailure = "no_user" | "transport";

/**
 * ⚠️ THE SAFETY PROPERTY OF THIS WHOLE FEATURE LIVES IN THIS FUNCTION.
 *
 * `no_user` is what tells a customer their address is not recognised. Returning
 * it for anything other than a positively identified missing user would, during
 * a Supabase outage or on a bad service-role key, tell EVERY customer on the
 * platform that their account does not exist — at exactly the moment they are
 * least able to check. So the recognition is an allowlist and every unrecognised
 * shape, including a bare string, a null, or an object we have never seen,
 * falls through to `transport`, which the route surfaces as a 500.
 *
 * The shapes are supabase-js `AuthApiError`s, which have varied across versions:
 * newer builds carry `code: "user_not_found"`, older ones only a 404, and some
 * paths return a 400 whose message names the condition.
 */
export function classifyGenerateLinkError(err: unknown): LinkFailure {
  if (typeof err !== "object" || err === null) return "transport";

  const e = err as { code?: unknown; status?: unknown; message?: unknown };

  if (typeof e.code === "string" && e.code === "user_not_found") return "no_user";
  if (e.status === 404) return "no_user";

  // A 400 is ambiguous — it is also what an unparseable address and a
  // misconfigured project return — so it only counts when the message says so.
  if (
    e.status === 400 &&
    typeof e.message === "string" &&
    /user not found|no user|not registered/i.test(e.message)
  ) {
    return "no_user";
  }

  return "transport";
}

/**
 * Subjects reach the database as SHA-256 hashes and never as addresses. A
 * plaintext rate-limit table would quietly become a list of every email anyone
 * has typed into a public form.
 */
export function hashResetSubject(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Ceilings, kept in TypeScript so they can be tuned without a migration —
 * `consume_reset_budget` deliberately has no opinion about them.
 *
 * The 60-second window preserves what the old in-memory Map was for: stopping
 * the endpoint being used to flood somebody's inbox. The hourly windows are the
 * new part, and they are what make disclosure safe — they bound how fast the
 * route can be walked to find out which addresses exist.
 */
export const RESET_SHORT_WINDOW_SECONDS = 60;
export const RESET_LONG_WINDOW_SECONDS = 3600;
export const RESET_EMAIL_PER_SHORT_WINDOW = 1;
export const RESET_EMAIL_PER_LONG_WINDOW = 5;
export const RESET_IP_PER_LONG_WINDOW = 20;

export type ResetBudgetCounts = {
  email_short?: number | null;
  email_long?: number | null;
  ip_long?: number | null;
};

/**
 * Whether this attempt is over any ceiling, and what to tell the person.
 *
 * The message names the actual wait rather than a vague "try again later" —
 * §15's rule about never collapsing a seconds-long personal cooldown into
 * something that reads like an hour-long outage.
 */
export function resetBudgetRefusal(counts: ResetBudgetCounts): string | null {
  if ((counts.email_short ?? 0) > RESET_EMAIL_PER_SHORT_WINDOW) {
    return "We've just sent a reset link to that address. Check your inbox and spam folder, then try again in a minute.";
  }
  if ((counts.email_long ?? 0) > RESET_EMAIL_PER_LONG_WINDOW) {
    return "That address has requested too many reset links in the last hour. Please wait an hour, or email zac@stayful.co.uk and we'll help you in.";
  }
  if ((counts.ip_long ?? 0) > RESET_IP_PER_LONG_WINDOW) {
    return "Too many reset requests from this connection. Please wait an hour, or email zac@stayful.co.uk and we'll help you in.";
  }
  return null;
}
