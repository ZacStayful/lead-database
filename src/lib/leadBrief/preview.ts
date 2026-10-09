import { deliverableAtConfidence } from "@/lib/filterForecast";
import { computeFirstPicks, computePaceOutcodes, tierForOutcode } from "@/lib/leadBrief/areas";
import { computeBottleneck, type Bottleneck } from "@/lib/leadBrief/bottleneck";
import {
  leadShare,
  meetsEssentials,
  otherBriefCoverage,
  weightedSupplyByOutcode,
} from "@/lib/leadBrief/eligibility";
import { computeExpectedMix } from "@/lib/leadBrief/expectedMix";
import {
  areaOfOutcode,
  distancesFrom,
  distancesFromNearest,
  outcodesWithin,
} from "@/lib/leadBrief/geo";
import {
  normaliseBriefInput,
  type BriefInput,
  type BriefInputIssue,
  type NormalisedBrief,
} from "@/lib/leadBrief/input";
import { evaluateLead, labelFor, resolvePriorities, type MatchContext } from "@/lib/leadBrief/match";
import {
  BRIEF_PLANS,
  PREVIEW_FIRST_PICKS,
  type BriefPlan,
  type OperatingMode,
  type TravelLimit,
} from "@/lib/leadBrief/plans";
import { computeServiceArea, type ServiceArea } from "@/lib/leadBrief/serviceArea";
import { computeSimilarAreas, type SimilarArea } from "@/lib/leadBrief/similarAreas";
import { computeTradeoffs, type Tradeoff } from "@/lib/leadBrief/tradeoffs";
import type {
  BriefPriority,
  BriefSupply,
  CompetitionTier,
  MatchLabel,
} from "@/lib/leadBrief/types";

/**
 * The engine's one entry point (A4): a brief preview from a plain input and a
 * supply snapshot. Pure — the supply is loaded server-side by
 * `loadBriefSupply` (supply.ts) and passed in, which is what lets the
 * pre-payment funnel (batch 02) run it before anyone has a customer row, and
 * lets every rule be tested with fixtures.
 *
 * A4 names the signature `computeBriefPreview(input, plan)`; a pure function
 * cannot fetch, so it takes the supply as a third argument (C21, approved).
 *
 * ⚠️ THE RESULT IS SERVER-SIDE. It carries the service and behind-pace outcode
 * lists and forecast counts. Anything sent to a browser goes through
 * `previewForClient`, which strips every volume and count (A4, locked
 * decision 9).
 */

export interface PlanCoverage {
  plan: BriefPlan;
  radiusMiles: number;
  /** SERVER-ONLY: whether this plan's area reaches the target (Phase 6 reads it). */
  meetsTarget: boolean;
}

export interface BriefPreview {
  brief: NormalisedBrief;
  plan: BriefPlan;
  capMiles: number;
  serviceRadiusMiles: number;
  /** SERVER-ONLY: every outcode in the service area. */
  serviceOutcodes: string[];
  priorityOutsideCap: string[];
  /**
   * SERVER-ONLY. Whether the area reaches the plan × 1.3 target. False is not
   * a failure: the plan is always filled, a short month rolls over, and the
   * mix leans to Nearby (A3). It feeds the stored brief and the admin side,
   * never the customer (previewForClient leaves it out).
   */
  meetsTarget: boolean;
  /** SERVER-ONLY, stored as customer_lead_briefs.mix_leans_nearby (A3). */
  mixLeansNearby: boolean;
  /** Nearest first. */
  firstPickOutcodes: string[];
  /** The nearest few first picks with their tiers, for display. */
  firstPickTiers: { outcode: string; tier: CompetitionTier | null }[];
  /** SERVER-ONLY: nearest first (A11). */
  paceOutcodes: string[];
  priorities: BriefPriority[];
  expectedMix: Record<MatchLabel, number>;
  similarAreas: SimilarArea[];
  priorityAreaTiers: { outcode: string; tier: CompetitionTier | null }[];
  tradeoffs: Tradeoff[];
  /** A5: both plans, side by side. */
  coverage: PlanCoverage[];
  /** The customer's essentials holding the area back, or null. Never supply (bottleneck.ts). */
  bottleneck: Bottleneck | null;
  /** SERVER-ONLY diagnostics. */
  supplyCheck: { target: number; deliverable: number; weeks: number };
}

export type PreviewResult =
  | { ok: true; preview: BriefPreview }
  | { ok: false; issues: BriefInputIssue[] };

export function computeBriefPreview(
  input: BriefInput,
  plan: BriefPlan,
  supply: BriefSupply,
  opts: { today?: string } = {}
): PreviewResult {
  const normalised = normaliseBriefInput(input);
  if (!normalised.ok) return normalised;
  const brief = normalised.brief;

  // normaliseBriefInput refuses a base with no centroid, so this is non-null.
  const baseDistances = distancesFrom(brief.baseOutcode)!;
  const today = opts.today ?? new Date().toISOString().slice(0, 10);

  const areaFor = (b: NormalisedBrief, p: BriefPlan): ServiceArea =>
    computeServiceArea({
      plan: p,
      travelLimitMiles: b.travelLimitMiles,
      baseOutcode: b.baseOutcode,
      priorityOutcodes: b.priorityOutcodes,
      similarAreas: b.similarAreas,
      baseDistances,
      weightedSupply: weightedSupplyByOutcode(b, supply),
      weeks: supply.weeks,
    });

  const service = areaFor(brief, plan);
  const coverage: PlanCoverage[] = BRIEF_PLANS.map((p) => {
    const a = p === plan ? service : areaFor(brief, p);
    return { plan: p, radiusMiles: a.radiusMiles, meetsTarget: a.meetsTarget };
  });

  // First picks and the pace ring are ordered by distance from the customer's
  // nearest area, not from the base alone.
  const nearestDistances = distancesFromNearest(service.centres)!;
  const firstPickOutcodes = computeFirstPicks({
    nearestDistances,
    reachMiles: brief.travelLimitMiles,
    supply,
    today,
  });
  const paceOutcodes = computePaceOutcodes({
    capMiles: service.capMiles,
    baseDistances,
    nearestDistances,
    serviceOutcodes: service.outcodes,
    firstPickOutcodes,
  });

  const serviceSet = new Set(service.outcodes);
  const firstSet = new Set(firstPickOutcodes);
  const areaLeads = supply.leads.filter(
    (l) => l.outcode !== null && serviceSet.has(l.outcode) && meetsEssentials(l, brief)
  );
  const eligibleLeads = supply.leads.filter(
    (l) =>
      l.outcode !== null &&
      (serviceSet.has(l.outcode) || firstSet.has(l.outcode)) &&
      meetsEssentials(l, brief)
  );

  const priorities = resolvePriorities({
    brief,
    serviceRadiusMiles: service.radiusMiles,
    areaLeads,
    allLeads: supply.leads,
  });
  const ctx: MatchContext = {
    baseOutcode: brief.baseOutcode,
    priorityOutcodes: brief.priorityOutcodes,
    similarAreas: brief.similarAreas,
    capMiles: service.capMiles,
  };

  // Expected mix, over everything this brief could receive. "First sale" is
  // assumed for a first-pick lead here; routing applies the real test (D6).
  const coverageCounts = otherBriefCoverage(supply.otherBriefs);
  const labelWeights: Partial<Record<MatchLabel, number>> = {};
  let eligibleWeight = 0;
  for (const lead of eligibleLeads) {
    const share = leadShare(lead, supply.contention, coverageCounts);
    const { label } = labelFor(evaluateLead(lead, priorities, ctx), {
      inFirstPick: firstSet.has(lead.outcode!),
      isFirstSale: true,
      paceOnly: false,
    });
    labelWeights[label] = (labelWeights[label] ?? 0) + share;
    eligibleWeight += share;
  }
  const mixDeliverable = deliverableAtConfidence(eligibleWeight, supply.weeks, plan).expected;
  const expectedMix = computeExpectedMix({ plan, deliverable: mixDeliverable, labelWeights });

  const ownAreas = [brief.baseOutcode, ...brief.priorityOutcodes].map(areaOfOutcode);
  const similarAreas = computeSimilarAreas({
    referenceAreas: Array.from(new Set(ownAreas)),
    // Reachable: an area with an outcode inside the cap of the base, the same
    // test that decides which of a ticked area's outcodes join the area.
    reachableAreas: new Set(outcodesWithin(baseDistances, service.capMiles).map(areaOfOutcode)),
    leads: supply.leads,
    fallbackReferenceLeads: areaLeads,
    competition: supply.competition,
  });

  const priorityAreaTiers = [brief.baseOutcode, ...brief.priorityOutcodes].map((outcode) => ({
    outcode,
    tier: tierForOutcode(outcode, supply.competition),
  }));

  const tradeoffs = computeTradeoffs({
    brief,
    current: service,
    areaFor: (b) => areaFor(b, plan),
  });

  const bottleneck = computeBottleneck({ brief, plan, current: service, areaFor });

  return {
    ok: true,
    preview: {
      brief,
      plan,
      capMiles: service.capMiles,
      serviceRadiusMiles: service.radiusMiles,
      serviceOutcodes: service.outcodes,
      priorityOutsideCap: service.priorityOutsideCap,
      meetsTarget: service.meetsTarget,
      mixLeansNearby: !service.meetsTarget,
      firstPickOutcodes,
      firstPickTiers: firstPickOutcodes.slice(0, PREVIEW_FIRST_PICKS).map((outcode) => ({
        outcode,
        tier: tierForOutcode(outcode, supply.competition),
      })),
      paceOutcodes,
      priorities,
      expectedMix,
      similarAreas,
      priorityAreaTiers,
      tradeoffs,
      coverage,
      bottleneck,
      supplyCheck: { target: service.target, deliverable: service.deliverable, weeks: supply.weeks },
    },
  };
}

/**
 * What a browser may see (A4, locked decision 9). Radii, figures, tiers, the
 * trade-offs and the mix as a split of the customer's own allocation — and
 * nothing that counts leads: no service or behind-pace outcode lists, no
 * forecast, no supply. The first picks are named only as the nearest few.
 *
 * ⚠️ NOTHING HERE SAYS THE AREA FALLS SHORT. The plan is always filled and a
 * short month rolls over, so `meetsTarget` and `mixLeansNearby` stay
 * server-side and the coverage rows carry radii only. The one shortfall a
 * customer is told about is their own essentials (`bottleneck`).
 *
 * Built field by field, never by spreading the preview, so a field added to
 * BriefPreview later cannot reach a client by accident (the §27.2 rule). A
 * test pins the exact key set.
 */
export interface ClientBriefPreview {
  plan: BriefPlan;
  basePostcode: string;
  baseOutcode: string;
  operatingMode: OperatingMode;
  travelLimitMiles: TravelLimit;
  serviceRadiusMiles: number;
  /** A5: the radius for each plan. */
  coverage: { plan: BriefPlan; radiusMiles: number }[];
  priorityAreas: { outcode: string; tier: CompetitionTier | null }[];
  priorityOutsideCap: string[];
  firstPicks: { outcode: string; tier: CompetitionTier | null }[];
  moreFirstPicks: boolean;
  similarAreas: SimilarArea[];
  tradeoffs: Tradeoff[];
  expectedMix: Record<MatchLabel, number>;
  priorities: BriefPriority[];
  bottleneck: Bottleneck | null;
}

export function previewForClient(preview: BriefPreview): ClientBriefPreview {
  return {
    plan: preview.plan,
    basePostcode: preview.brief.basePostcode,
    baseOutcode: preview.brief.baseOutcode,
    operatingMode: preview.brief.operatingMode,
    travelLimitMiles: preview.brief.travelLimitMiles,
    serviceRadiusMiles: preview.serviceRadiusMiles,
    coverage: preview.coverage.map((c) => ({ plan: c.plan, radiusMiles: c.radiusMiles })),
    priorityAreas: preview.priorityAreaTiers.map((p) => ({ outcode: p.outcode, tier: p.tier })),
    priorityOutsideCap: [...preview.priorityOutsideCap],
    firstPicks: preview.firstPickTiers.map((p) => ({ outcode: p.outcode, tier: p.tier })),
    moreFirstPicks: preview.firstPickOutcodes.length > PREVIEW_FIRST_PICKS,
    similarAreas: preview.similarAreas.map((s) => ({
      area: s.area,
      city: s.city,
      tier: s.tier,
      figures: { ...s.figures },
      reference: { ...s.reference },
      recommended: s.recommended,
    })),
    tradeoffs: preview.tradeoffs.map((t) => ({
      essential: t.essential,
      from: t.from,
      to: t.to,
      radiusMiles: t.radiusMiles,
      milesSaved: t.milesSaved,
    })),
    expectedMix: { ...preview.expectedMix },
    priorities: preview.priorities.map((p) => ({ key: p.key, threshold: p.threshold })),
    bottleneck: preview.bottleneck
      ? {
          causes: preview.bottleneck.causes.map((c) => ({ essential: c.essential, relaxTo: c.relaxTo })),
          canWiden: preview.bottleneck.canWiden,
          canSwitchToSmallerPlan: preview.bottleneck.canSwitchToSmallerPlan,
          canBookCall: preview.bottleneck.canBookCall,
        }
      : null,
  };
}
