import type { ParsedBriefBody } from "@/lib/leadBrief/briefRequest";
import type { BriefInputIssue, NormalisedBrief } from "@/lib/leadBrief/input";
import { BRIEF_PLANS, type BriefPlan, type TravelLimit } from "@/lib/leadBrief/plans";
import {
  computeBriefPreview,
  previewForClient,
  type BriefPreview,
  type ClientBriefPreview,
} from "@/lib/leadBrief/preview";
import type { BriefSupply } from "@/lib/leadBrief/types";

/**
 * The funnel's preview (batch 02 Phase 2): the Lead Brief engine run for BOTH
 * plans before anybody has paid. Pure: the supply is loaded by the route
 * (loadBriefSupply with no customer to exclude) and passed in.
 *
 * ⚠️ THE ONLY THING THAT LEAVES IS `previewForClient` (01 A4, 02 locked
 * decision 7). The server preview carries the service, first-pick and
 * behind-pace outcode lists, the forecast and the supply check; none of that
 * may reach a browser, and this page is reachable by anyone holding a link.
 * `funnelPreviewBody` is built field by field and a test pins its key set.
 */

export type FunnelPreviewResult =
  | {
      ok: true;
      previews: Record<BriefPlan, BriefPreview>;
      /** The similar areas the previews were computed with (ticked or pre-ticked). */
      similarAreas: string[];
    }
  | { ok: false; issues: BriefInputIssue[] };

/**
 * Both plans, side by side, the way the plan screen shows them.
 *
 * Pre-ticking follows the questionnaire (`computeBriefForCustomer`,
 * leadBrief/briefServer.ts): on the first preview the body carries no similar
 * areas, so the engine's recommended area is ticked and the preview recomputed,
 * and the radius shown already includes it (A8). The recommendation is taken
 * from the 10-lead plan, whose 40-mile cap is the smaller: an area reachable
 * there is reachable on the 20-lead plan too, so ONE ticked list serves both
 * columns and the visitor never sees a box ticked under one plan and not the
 * other.
 */
export function computeFunnelPreviews(
  parsed: ParsedBriefBody,
  supply: BriefSupply,
  opts: { today?: string } = {}
): FunnelPreviewResult {
  const [smaller] = BRIEF_PLANS;
  const first = computeBriefPreview(parsed.input, smaller, supply, opts);
  if (!first.ok) return first;

  let similarAreas = [...first.preview.brief.similarAreas];
  if (!parsed.similarAreasGiven) {
    const recommended = first.preview.similarAreas.find((s) => s.recommended);
    similarAreas = recommended ? [recommended.area] : [];
  }
  const input = { ...parsed.input, similarAreas };

  const previews = {} as Record<BriefPlan, BriefPreview>;
  for (const plan of BRIEF_PLANS) {
    const unchanged = plan === smaller && sameList(similarAreas, first.preview.brief.similarAreas);
    const r = unchanged ? first : computeBriefPreview(input, plan, supply, opts);
    if (!r.ok) return r;
    previews[plan] = r.preview;
  }
  return { ok: true, previews, similarAreas };
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** What the preview route returns and what funnel_sessions.preview_snapshot stores. */
export interface FunnelPreviewBody {
  /** One per plan, in plan order (10 then 20). */
  plans: ClientBriefPreview[];
  /** The ticked similar areas, so the screen knows which boxes the server ticked. */
  similarAreas: string[];
}

export const FUNNEL_PREVIEW_BODY_KEYS = ["plans", "similarAreas"] as const;

/**
 * funnel_sessions.preview_snapshot read back for resume and for the partner
 * summary. It was written by `funnelPreviewBody`, so this only checks the
 * outline the screens rely on (both plans present, each with its radius and
 * coverage) and returns null for anything else: a snapshot that cannot be
 * shown is treated as no preview, and the visitor previews again.
 */
export function readPreviewSnapshot(raw: unknown): FunnelPreviewBody | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.plans) || !Array.isArray(r.similarAreas)) return null;
  const plans = r.plans as unknown[];
  const shown = BRIEF_PLANS.map((plan) =>
    plans.find((p) => !!p && typeof p === "object" && (p as { plan?: unknown }).plan === plan)
  );
  const usable = shown.every((p) => {
    const c = p as Record<string, unknown> | undefined;
    return (
      !!c &&
      typeof c.serviceRadiusMiles === "number" &&
      typeof c.basePostcode === "string" &&
      Array.isArray(c.coverage)
    );
  });
  if (!usable) return null;
  return {
    plans: shown as ClientBriefPreview[],
    similarAreas: (r.similarAreas as unknown[]).flatMap((a) => (typeof a === "string" ? [a] : [])),
  };
}

export function funnelPreviewBody(
  result: Extract<FunnelPreviewResult, { ok: true }>
): FunnelPreviewBody {
  return {
    plans: BRIEF_PLANS.map((plan) => previewForClient(result.previews[plan])),
    similarAreas: [...result.similarAreas],
  };
}

/**
 * The answers as funnel_sessions.answers stores them (C1): the normalised
 * brief's own fields, read one by one, never the request body. This is what
 * the onboarding confirmation is prefilled from after payment (Phase 5), and
 * it reads back through the same closed parser (`parseBriefBody`).
 */
export interface FunnelAnswers {
  basePostcode: string;
  priorityOutcodes: string[];
  travelLimitMiles: TravelLimit;
  minBedrooms: number | null;
  minGross: number | null;
  similarAreas: string[];
}

export function funnelAnswers(brief: NormalisedBrief): FunnelAnswers {
  return {
    basePostcode: brief.basePostcode,
    priorityOutcodes: [...brief.priorityOutcodes],
    travelLimitMiles: brief.travelLimitMiles,
    minBedrooms: brief.minBedrooms,
    minGross: brief.minGross,
    similarAreas: [...brief.similarAreas],
  };
}

/**
 * 02 Phase 2: "After the first preview, the base postcode is locked for that
 * token. Changing it means contacting Zac." Compared in canonical form, so
 * "yo105dd" and "YO10 5DD" are the same postcode and a typo in spacing is
 * never a refusal.
 */
export function postcodeLockRefuses(locked: string | null | undefined, requested: string): boolean {
  return !!locked && locked !== requested;
}
