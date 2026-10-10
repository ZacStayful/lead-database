import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A customer's brief versions as the editor needs them (Lead Brief Phase 5):
 * the active row, and the one change in flight, if any (0164 allows one: a
 * scheduled area change or a wider area pending confirmation). SERVER-SIDE
 * ONLY — these rows carry the outcode lists, which never reach a browser (A4).
 */
export interface BriefVersionRow {
  id: string;
  version: number;
  status: "active" | "scheduled" | "pending_confirmation";
  base_postcode: string;
  base_outcode: string;
  travel_limit_miles: number | null;
  allocation: number;
  priorities: unknown;
  essentials: string[] | null;
  min_bedrooms: number | null;
  min_gross: number | null;
  priority_outcodes: string[] | null;
  similar_areas: string[] | null;
  service_radius_miles: number;
  created_at: string;
  /** 'customer', 'recompute' or 'admin' (0162). */
  origin: string;
  confirmed_at: string | null;
  /** First picks are held until this date (0162). */
  locked_until: string | null;
  /** When a pending_confirmation version takes effect (0167). */
  effective_at: string | null;
}

export const BRIEF_VERSION_COLUMNS =
  "id, version, status, base_postcode, base_outcode, travel_limit_miles, allocation, priorities, essentials, min_bedrooms, min_gross, priority_outcodes, similar_areas, service_radius_miles, created_at, origin, confirmed_at, locked_until, effective_at";

export interface BriefVersions {
  active: BriefVersionRow | null;
  scheduled: BriefVersionRow | null;
  pending: BriefVersionRow | null;
}

export class BriefVersionsUnavailableError extends Error {}

/** Throws BriefVersionsUnavailableError on a read error: never an empty brief. */
export async function loadBriefVersions(admin: SupabaseClient, customerId: string): Promise<BriefVersions> {
  const { data, error } = await admin
    .from("customer_lead_briefs")
    .select(BRIEF_VERSION_COLUMNS)
    .eq("customer_id", customerId)
    .in("status", ["active", "scheduled", "pending_confirmation"]);
  if (error) throw new BriefVersionsUnavailableError(error.message);
  const rows = (data ?? []) as BriefVersionRow[];
  return {
    active: rows.find((r) => r.status === "active") ?? null,
    scheduled: rows.find((r) => r.status === "scheduled") ?? null,
    pending: rows.find((r) => r.status === "pending_confirmation") ?? null,
  };
}
