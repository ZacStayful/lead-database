import { hasCentroid } from "@/lib/leadBrief/geo";
import {
  isTravelLimit,
  operatingModeFor,
  type OperatingMode,
  type TravelLimit,
} from "@/lib/leadBrief/plans";
import { PRIORITY_KEYS, type EssentialKey, type PriorityKey } from "@/lib/leadBrief/types";
import { isGrossThreshold } from "@/lib/filterPrediction";

/**
 * A brief as the customer gives it (A4, A8). Deliberately NOT a customers row:
 * the pre-payment funnel (batch 02) runs the engine before anyone has paid.
 */
export interface BriefInput {
  /** As typed: a full postcode ("YO10 5DD", "yo105dd") or just the outcode. */
  basePostcode: string;
  /** A8 Q1 "Add another area": outcodes, as typed. */
  priorityOutcodes?: string[];
  /** A8 Q2: 10, 25, 50, or null for anywhere. */
  travelLimitMiles: TravelLimit;
  /** A8 Q3 essentials. Null or absent means not an essential. */
  minBedrooms?: number | null;
  minGross?: number | null;
  /**
   * The priority ranking, most important first. Absent means the A8 default.
   * The questionnaire never asks for it; the "Your brief" editor (Phase 5) may.
   */
  ranking?: PriorityKey[];
  /** Thresholds the customer set explicitly (Phase 5). Absent means "typical". */
  thresholds?: Partial<Record<PriorityKey, number>>;
  /** Similar areas the customer accepted: postcode areas. */
  similarAreas?: string[];
}

export interface NormalisedBrief {
  /** Canonical: "YO10 5DD", or "YO10" when only the outcode was given. */
  basePostcode: string;
  baseOutcode: string;
  priorityOutcodes: string[];
  travelLimitMiles: TravelLimit;
  operatingMode: OperatingMode;
  essentials: EssentialKey[];
  minBedrooms: number | null;
  minGross: number | null;
  ranking: PriorityKey[];
  thresholds: Partial<Record<PriorityKey, number>>;
  similarAreas: string[];
}

export type BriefInputIssue =
  | { code: "base_postcode_unrecognised" }
  | { code: "base_outcode_unplaceable"; outcode: string }
  | { code: "travel_limit_invalid" }
  | { code: "min_bedrooms_invalid" }
  | { code: "min_gross_invalid" }
  | { code: "priority_outcode_unrecognised"; value: string }
  | { code: "similar_area_invalid"; value: string }
  | { code: "ranking_invalid" }
  | { code: "threshold_invalid"; key: PriorityKey };

export type NormaliseResult =
  | { ok: true; brief: NormalisedBrief }
  | { ok: false; issues: BriefInputIssue[] };

const FULL_POSTCODE = /^([A-Z]{1,2}[0-9][A-Z0-9]?)([0-9][A-Z]{2})$/;
const OUTCODE_ONLY = /^[A-Z]{1,2}[0-9][A-Z0-9]?$/;
const POSTCODE_AREA = /^[A-Z]{1,2}$/;

/**
 * A typed postcode to its canonical form and outcode, or null. Spaces are
 * ignored, so "YO10 5DD", "yo105dd" and " YO10  5DD " all give "YO10 5DD";
 * "YO10" on its own gives the outcode. The canonical form satisfies
 * customer_lead_briefs_base_postcode_format (0162).
 */
export function parseBasePostcode(
  raw: string
): { basePostcode: string; baseOutcode: string } | null {
  const s = raw.toUpperCase().replace(/\s+/g, "");
  const full = FULL_POSTCODE.exec(s);
  if (full) return { basePostcode: `${full[1]} ${full[2]}`, baseOutcode: full[1] };
  if (OUTCODE_ONLY.test(s)) return { basePostcode: s, baseOutcode: s };
  return null;
}

/**
 * A8: location first, then the chosen essentials, then revenue, bedrooms and
 * occupancy. The essentials are taken in that same order, so the default is
 * always a reordering of one list and never depends on the order the boxes
 * were ticked in.
 */
export function defaultRanking(essentials: EssentialKey[]): PriorityKey[] {
  const tail: PriorityKey[] = ["revenue", "bedrooms", "occupancy"];
  const chosen = tail.filter((k) => (essentials as string[]).includes(k));
  const rest = tail.filter((k) => !chosen.includes(k));
  return ["location", ...chosen, ...rest];
}

function isRanking(v: unknown): v is PriorityKey[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > PRIORITY_KEYS.length) return false;
  const seen = new Set<string>();
  for (const k of v) {
    if (typeof k !== "string" || !(PRIORITY_KEYS as string[]).includes(k) || seen.has(k)) {
      return false;
    }
    seen.add(k);
  }
  return true;
}

export function normaliseBriefInput(input: BriefInput): NormaliseResult {
  const issues: BriefInputIssue[] = [];

  const base = parseBasePostcode(input.basePostcode ?? "");
  if (!base) {
    issues.push({ code: "base_postcode_unrecognised" });
  } else if (!hasCentroid(base.baseOutcode)) {
    // A real outcode we cannot place (M50 is one): no distance can be measured
    // from it, so no service area can be built around it.
    issues.push({ code: "base_outcode_unplaceable", outcode: base.baseOutcode });
  }

  if (!isTravelLimit(input.travelLimitMiles)) issues.push({ code: "travel_limit_invalid" });

  const minBedrooms = input.minBedrooms ?? null;
  if (
    minBedrooms !== null &&
    !(Number.isInteger(minBedrooms) && minBedrooms >= 1 && minBedrooms <= 10)
  ) {
    issues.push({ code: "min_bedrooms_invalid" });
  }
  const minGross = input.minGross ?? null;
  if (minGross !== null && !isGrossThreshold(minGross)) {
    issues.push({ code: "min_gross_invalid" });
  }

  const priorityOutcodes: string[] = [];
  for (const raw of input.priorityOutcodes ?? []) {
    const parsed = parseBasePostcode(String(raw));
    if (!parsed || !hasCentroid(parsed.baseOutcode)) {
      issues.push({ code: "priority_outcode_unrecognised", value: String(raw) });
      continue;
    }
    const oc = parsed.baseOutcode;
    if (oc !== base?.baseOutcode && !priorityOutcodes.includes(oc)) priorityOutcodes.push(oc);
  }

  const similarAreas: string[] = [];
  for (const raw of input.similarAreas ?? []) {
    const a = String(raw).trim().toUpperCase();
    if (!POSTCODE_AREA.test(a)) {
      issues.push({ code: "similar_area_invalid", value: String(raw) });
      continue;
    }
    if (!similarAreas.includes(a)) similarAreas.push(a);
  }

  const essentials: EssentialKey[] = [];
  if (minGross !== null) essentials.push("revenue");
  if (minBedrooms !== null) essentials.push("bedrooms");

  let ranking = defaultRanking(essentials);
  if (input.ranking !== undefined) {
    if (isRanking(input.ranking)) ranking = [...input.ranking];
    else issues.push({ code: "ranking_invalid" });
  }

  const thresholds: Partial<Record<PriorityKey, number>> = {};
  for (const [k, v] of Object.entries(input.thresholds ?? {})) {
    const key = k as PriorityKey;
    if (!(PRIORITY_KEYS as string[]).includes(k) || typeof v !== "number" || !(v > 0)) {
      issues.push({ code: "threshold_invalid", key });
      continue;
    }
    thresholds[key] = v;
  }

  if (issues.length > 0 || !base) return { ok: false, issues };

  return {
    ok: true,
    brief: {
      basePostcode: base.basePostcode,
      baseOutcode: base.baseOutcode,
      priorityOutcodes,
      travelLimitMiles: input.travelLimitMiles,
      operatingMode: operatingModeFor(input.travelLimitMiles),
      essentials,
      minBedrooms,
      minGross,
      ranking,
      thresholds,
      similarAreas,
    },
  };
}
