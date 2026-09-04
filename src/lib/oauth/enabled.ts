/**
 * The OAuth kill switch.
 *
 * A SECOND switch beside `api_enabled`, following `pool_enabled` (0073) and
 * `escalation_enabled` (0062), for two reasons. It lets OAuth be turned off
 * without taking API keys down with it — those are different failure modes with
 * different customers behind them — and it ships FALSE, which is what let the
 * resource-server and authorization-server halves land in separate deploys
 * without ever advertising an endpoint that did not exist yet.
 *
 * ⚠️ WHEN IT IS OFF, THE DISCOVERY DOCUMENTS 404 rather than 503. That is
 * deliberate: a 404 is exactly what a client saw before any of this existed, so
 * it falls back to whatever it did then. A document that advertises four
 * endpoints which each answer 503 is a worse answer than no document, because
 * the client has already committed to us by the time it finds out.
 *
 * It deliberately does NOT gate the grant-management routes — a customer must be
 * able to disconnect an app while OAuth is switched off, exactly as key
 * management ignores `api_enabled`.
 *
 * The 30-second cache and the fail-direction are lifted from `apiEnabled()` in
 * caller.ts, with ONE difference: this fails CLOSED on a read error where that
 * fails open. An unreachable settings table must not take a working API down —
 * but it also must not switch a feature ON that somebody has deliberately left
 * off, and during rollout "off" is the state that matters.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { KILL_SWITCH_CACHE_MS } from "@/lib/api/limits";

let cache: { enabled: boolean; readAt: number } | null = null;

/** Exported for tests, which must not inherit a cached value between cases. */
export function resetOauthEnabledCache(): void {
  cache = null;
}

export async function oauthEnabled(): Promise<boolean> {
  const now = Date.now();
  if (cache && now - cache.readAt < KILL_SWITCH_CACHE_MS) return cache.enabled;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("system_settings")
    .select("value")
    .eq("key", "oauth_enabled")
    .maybeSingle();

  if (error) {
    console.error("[oauth] oauth_enabled read failed, treating as disabled", error);
    return false;
  }

  // An UNSEEDED key reads as disabled, the opposite of api_enabled's `?? "true"`.
  // Same reasoning as the error case: the safe default for a feature being
  // rolled out is off.
  const enabled = ((data as { value?: string } | null)?.value ?? "false").trim() === "true";
  cache = { enabled, readAt: now };
  return enabled;
}
