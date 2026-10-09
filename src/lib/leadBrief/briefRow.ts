import { prioritiesForStorage } from "@/lib/leadBrief/match";
import type { BriefPreview } from "@/lib/leadBrief/preview";

/**
 * A confirmed brief as one `customer_lead_briefs` row (0162). Pure, so the
 * shape that reaches the database is tested here rather than discovered by a
 * CHECK at insert time.
 *
 * Every computed column comes from the SERVER's preview, recomputed against
 * live supply at confirmation. Nothing here is taken from what the browser
 * sent back: the client only ever sees `previewForClient`, which carries no
 * outcode lists.
 *
 * Rules the 0162 CHECKs enforce, and this keeps:
 *   - `priorities` omits an unresolved threshold rather than writing JSON null
 *     (`prioritiesForStorage`);
 *   - `allocation` is the plan the brief was computed for (10 or 20), which is
 *     what decides the radius cap. After "Switch to 10 leads a month" (§24) it
 *     is 10 while `customers.monthly_allocation` is still 20 until renewal;
 *   - an active brief is a confirmed one, so `confirmed_at` is always set.
 */
export interface BriefRowInsert {
  customer_id: string;
  version: number;
  status: "active";
  origin: "customer";
  base_postcode: string;
  base_outcode: string;
  operating_mode: string;
  travel_limit_miles: number | null;
  allocation: number;
  priorities: ReturnType<typeof prioritiesForStorage>;
  essentials: string[];
  min_bedrooms: number | null;
  min_gross: number | null;
  priority_outcodes: string[];
  similar_areas: string[];
  service_radius_miles: number;
  service_outcodes: string[];
  first_pick_outcodes: string[];
  pace_outcodes: string[];
  mix_leans_nearby: boolean;
  expected_mix: Record<string, number>;
  locked_until: string | null;
  confirmed_at: string;
}

export function briefRowFromPreview(
  preview: BriefPreview,
  opts: { customerId: string; version: number; lockedUntil: string | null; now: Date }
): BriefRowInsert {
  const b = preview.brief;
  return {
    customer_id: opts.customerId,
    version: opts.version,
    status: "active",
    origin: "customer",
    base_postcode: b.basePostcode,
    base_outcode: b.baseOutcode,
    operating_mode: b.operatingMode,
    travel_limit_miles: b.travelLimitMiles,
    allocation: preview.plan,
    priorities: prioritiesForStorage(preview.priorities),
    essentials: [...b.essentials],
    min_bedrooms: b.minBedrooms,
    min_gross: b.minGross,
    priority_outcodes: [...b.priorityOutcodes],
    similar_areas: [...b.similarAreas],
    service_radius_miles: preview.serviceRadiusMiles,
    service_outcodes: [...preview.serviceOutcodes],
    first_pick_outcodes: [...preview.firstPickOutcodes],
    pace_outcodes: [...preview.paceOutcodes],
    mix_leans_nearby: preview.mixLeansNearby,
    expected_mix: { ...preview.expectedMix },
    locked_until: opts.lockedUntil,
    confirmed_at: opts.now.toISOString(),
  };
}

/** The next version number for a customer, from the versions already stored. */
export function nextBriefVersion(existing: number[]): number {
  return existing.reduce((m, v) => (Number.isInteger(v) && v > m ? v : m), 0) + 1;
}
