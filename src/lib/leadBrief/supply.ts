import type { SupabaseClient } from "@supabase/supabase-js";
import {
  INGEST_EPOCH_ISO,
  LeadVolumeUnavailableError,
  fetchAreaContention,
  fetchRetiredLeadIds,
  isRetired,
  parseBedrooms,
  weeksElapsedSince,
  type RawLeadVolumeRow,
} from "@/lib/filterPrediction";
import { outcodeOfPostcode } from "@/lib/leadBrief/geo";
import { capMilesFor, isTravelLimit } from "@/lib/leadBrief/plans";
import type {
  BriefSupply,
  CompetitionTier,
  OtherBrief,
  SupplyLead,
} from "@/lib/leadBrief/types";

/**
 * Load the supply snapshot the engine reads. SERVER-SIDE ONLY: never import
 * this from a client component. Everything it returns is a map of where leads
 * come from (A4, locked decision 9), and it needs the service role.
 *
 * ⚠️ AN UNREADABLE BOOK THROWS, NEVER READS AS EMPTY (§58). The leads, the
 * pool claims, the areas legacy filters name and the other customers' briefs
 * all throw on a read error: an empty lead list would widen every new brief to
 * its cap, and an empty list of filtered areas or other briefs would hand out
 * first picks that already belong to someone. Two reads fail OPEN:
 *   - contention, inside fetchAreaContention, exactly as the filter forecast
 *     does (an unshared, optimistic quote — the forecast's accepted trade);
 *   - competition tiers: none means no area is ever called low competition.
 *
 * ⚠️ That is why the filtered areas are read here and NOT taken from the
 * contention map: fetchAreaContention swallows its error into an empty map,
 * and an empty map would make every area look uncovered.
 *
 * The window is the filter forecast's: every lead since INGEST_EPOCH_ISO.
 */

export class BriefSupplyUnavailableError extends Error {
  constructor(detail: string) {
    super(`Brief supply unavailable: ${detail}`);
    this.name = "BriefSupplyUnavailableError";
  }
}

interface LeadRow extends RawLeadVolumeRow {
  postcode: string | null;
  avg_nightly_rate: number | string | null;
  occupancy_rate: number | string | null;
  lead_quality_status: string | null;
  lead_quality_override_at: string | null;
}

function num(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * The retirement test the filter forecast applies (isRetired), plus the
 * quality-gate arm of lead_retirement_reason (0111, 0155) that isRetired does
 * not mirror (§11). Added here rather than in isRetired so the existing
 * customers' filter forecasts do not move.
 */
export function leadIsSupply(row: LeadRow, claimed: Set<string>): boolean {
  if (isRetired(row, claimed)) return false;
  if (row.lead_quality_status === "failed" && row.lead_quality_override_at === null) return false;
  return true;
}

export function toSupplyLead(row: LeadRow): SupplyLead {
  return {
    outcode: outcodeOfPostcode(row.postcode),
    area: row.postcode_area?.trim().toUpperCase() || null,
    bedrooms: parseBedrooms(row.bedrooms),
    gross: num(row.gross_annual_income),
    nightly: num(row.avg_nightly_rate),
    occupancy: num(row.occupancy_rate),
  };
}

async function fetchSupplyLeads(admin: SupabaseClient): Promise<SupplyLead[]> {
  let claimed: Set<string>;
  try {
    claimed = await fetchRetiredLeadIds(admin);
  } catch (e) {
    throw new BriefSupplyUnavailableError(
      e instanceof LeadVolumeUnavailableError ? e.message : String(e)
    );
  }
  const out: SupplyLead[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("leads")
      .select(
        "id, postcode, postcode_area, bedrooms, lead_type, created_at, gross_annual_income, avg_nightly_rate, occupancy_rate, pool_expired_at, pool_entered_at, pool_entry_basis, stayful_conflict_at, lead_quality_status, lead_quality_override_at"
      )
      .eq("lead_type", "management")
      // Customer-owned leads are not marketplace supply (§30.8).
      .is("owner_customer_id", null)
      .gte("created_at", INGEST_EPOCH_ISO)
      // Stable order: .range() is LIMIT/OFFSET (§28.8).
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new BriefSupplyUnavailableError(error.message);
    if (!data || data.length === 0) break;
    for (const row of data as unknown as LeadRow[]) {
      if (leadIsSupply(row, claimed)) out.push(toSupplyLead(row));
    }
    if (data.length < PAGE) break;
  }
  return out;
}

interface BriefRow {
  customer_id: string;
  base_outcode: string;
  travel_limit_miles: number | null;
  allocation: number;
  service_outcodes: string[] | null;
  first_pick_outcodes: string[] | null;
  locked_until: string | null;
  customer:
    | { is_active: boolean | null; subscription_status: string | null }
    | { is_active: boolean | null; subscription_status: string | null }[]
    | null;
}

/**
 * Other customers' ACTIVE briefs, for first picks and brief-vs-brief
 * contention. Only customers still on a live management subscription count:
 * a cancelled customer's brief must not keep first picks from anyone.
 */
export function toOtherBriefs(rows: BriefRow[]): OtherBrief[] {
  const out: OtherBrief[] = [];
  for (const r of rows) {
    const c = Array.isArray(r.customer) ? r.customer[0] : r.customer;
    if (!c || c.is_active === false) continue;
    if (c.subscription_status !== "active" && c.subscription_status !== "past_due") continue;
    const travel = isTravelLimit(r.travel_limit_miles) ? r.travel_limit_miles : null;
    out.push({
      customerId: r.customer_id,
      baseOutcode: r.base_outcode,
      capMiles: capMilesFor(r.allocation <= 10 ? 10 : 20, travel),
      serviceOutcodes: r.service_outcodes ?? [],
      firstPickOutcodes: r.first_pick_outcodes ?? [],
      lockedUntil: r.locked_until,
    });
  }
  return out;
}

async function fetchOtherBriefs(
  admin: SupabaseClient,
  excludeCustomerId: string | null
): Promise<OtherBrief[]> {
  let query = admin
    .from("customer_lead_briefs")
    .select(
      "customer_id, base_outcode, travel_limit_miles, allocation, service_outcodes, first_pick_outcodes, locked_until, customer:customers!inner(is_active, subscription_status)"
    )
    .eq("status", "active");
  if (excludeCustomerId) query = query.neq("customer_id", excludeCustomerId);
  const { data, error } = await query;
  if (error) throw new BriefSupplyUnavailableError(error.message);
  return toOtherBriefs((data ?? []) as unknown as BriefRow[]);
}

/**
 * Postcode areas named by an active legacy filter — the population
 * fetchAreaContention counts (live management subscription, filter on), read
 * here so a failure THROWS. A bedroom-only filter names no area (C7).
 */
async function fetchFilteredAreas(
  admin: SupabaseClient,
  excludeCustomerId: string | null
): Promise<string[]> {
  let query = admin
    .from("customers")
    .select("id, filter_areas")
    .in("filter_status", ["active", "pending_lift"])
    .eq("account_status", "active")
    .eq("subscription_status", "active");
  if (excludeCustomerId) query = query.neq("id", excludeCustomerId);
  const { data, error } = await query;
  if (error) throw new BriefSupplyUnavailableError(error.message);
  const areas = new Set<string>();
  for (const r of (data ?? []) as { filter_areas: string[] | null }[]) {
    for (const a of r.filter_areas ?? []) {
      const key = a?.trim().toUpperCase();
      if (key) areas.add(key);
    }
  }
  return Array.from(areas).sort();
}

/** Admin-set tiers only (D5, C9). A read error yields none, logged. */
async function fetchCompetition(admin: SupabaseClient): Promise<Record<string, CompetitionTier>> {
  const { data, error } = await admin
    .from("area_competition")
    .select("area_kind, area_code, tier")
    .eq("source", "admin");
  if (error) {
    console.error("[lead-brief] competition tiers unreadable; showing none", error.message);
    return {};
  }
  const out: Record<string, CompetitionTier> = {};
  for (const r of (data ?? []) as { area_kind: string; area_code: string; tier: string }[]) {
    if (r.tier === "high" || r.tier === "medium" || r.tier === "low") {
      out[`${r.area_kind}:${r.area_code}`] = r.tier;
    }
  }
  return out;
}

export async function loadBriefSupply(
  admin: SupabaseClient,
  opts: { excludeCustomerId?: string | null; now?: Date } = {}
): Promise<BriefSupply> {
  const exclude = opts.excludeCustomerId ?? null;
  const [leads, contention, filteredAreas, otherBriefs, competition] = await Promise.all([
    fetchSupplyLeads(admin),
    fetchAreaContention(admin, "management", exclude),
    fetchFilteredAreas(admin, exclude),
    fetchOtherBriefs(admin, exclude),
    fetchCompetition(admin),
  ]);
  return {
    weeks: weeksElapsedSince(INGEST_EPOCH_ISO, opts.now ?? new Date()),
    leads,
    contention: {
      byBand: contention.byBand,
      everywhereByBand: contention.everywhereByBand,
      maxPerLead: contention.maxPerLead,
    },
    filteredAreas,
    otherBriefs,
    competition,
  };
}
