/**
 * The Stayful-pipeline conflict index, cached per process (§64).
 *
 * `ingestLead` runs ~250 times in one 09:00 sync and in batches from the
 * five-minute poll; each call needs the same ~180 pipeline items. One Monday
 * read every ten minutes serves all of them.
 *
 * ⚠️ INGEST FAILS OPEN. A failed settings read or a failed Monday read yields
 * `index: null`, logged loudly, and the caller sells the lead unchecked. The
 * money path must not halt on a Monday blip (the `lead_is_closed` argument in
 * autoAssignLead), and the fifteen-minute sweep — which refuses to conclude
 * anything on the same failure — is the backstop. The two directions are
 * deliberately different (§18.3 for the sweep's).
 *
 * Own module rather than the sweep's: ingest.ts imports this, the sweep
 * imports ingest.ts, and a cycle is what that would otherwise be.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchStayfulPipelineIndex } from "@/lib/monday";
import { resolveSettingsGate, type SettingsRow } from "@/lib/cron/settingsGate";
import {
  buildStayfulPipelineIndex,
  type StayfulPipelineIndex,
} from "@/lib/stayfulConflict";

/** Pinned to a literal by the guard test; never derived. */
export const STAYFUL_INDEX_TTL_MS = 600_000;

export const STAYFUL_CONFLICT_SETTING = "stayful_conflict_enabled";

export interface StayfulConflictContext {
  enabled: boolean;
  index: StayfulPipelineIndex | null;
  error?: string;
}

let cache: { at: number; value: StayfulConflictContext } | null = null;

/** Test seam. */
export function resetStayfulConflictCache(): void {
  cache = null;
}

export async function loadStayfulConflictContext(
  admin: SupabaseClient,
  opts: { force?: boolean; now?: number } = {}
): Promise<StayfulConflictContext> {
  const now = opts.now ?? Date.now();
  if (!opts.force && cache && now - cache.at < STAYFUL_INDEX_TTL_MS) {
    return cache.value;
  }

  const { data: rows, error } = await admin
    .from("system_settings")
    .select("key, value")
    .in("key", [STAYFUL_CONFLICT_SETTING]);
  const gate = resolveSettingsGate(rows as SettingsRow[] | null, error);

  let value: StayfulConflictContext;
  if (!gate.ok && gate.reason === "read_failed") {
    console.error("[stayful-conflict] system_settings unreadable; ingest proceeds unchecked");
    value = { enabled: false, index: null, error: "settings_read_failed" };
  } else {
    const config = gate.ok ? gate.config : new Map<string, string>();
    const enabled = config.get(STAYFUL_CONFLICT_SETTING) === "true";
    if (!enabled) {
      value = { enabled: false, index: null };
    } else {
      const fetched = await fetchStayfulPipelineIndex();
      if (!fetched.ok) {
        console.error(
          "[stayful-conflict] pipeline board unreadable; ingest proceeds unchecked",
          fetched.error
        );
        value = { enabled: true, index: null, error: fetched.error };
      } else {
        value = { enabled: true, index: buildStayfulPipelineIndex(fetched.items) };
      }
    }
  }

  // A failure is cached too, for the same ten minutes: one Monday outage
  // must not turn 250 ingest calls into 250 failed reads.
  cache = { at: now, value };
  return value;
}
