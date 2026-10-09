import type { NormalisedBrief } from "@/lib/leadBrief/input";
import { PLAN_MAX_MILES, type BriefPlan } from "@/lib/leadBrief/plans";
import type { ServiceArea } from "@/lib/leadBrief/serviceArea";
import { essentialThreshold, relaxBrief, relaxedThreshold } from "@/lib/leadBrief/tradeoffs";
import type { EssentialKey } from "@/lib/leadBrief/types";

/**
 * The filter bottleneck: the one case the brief tells a customer about when
 * their area cannot cover the plan.
 *
 * ⚠️ THE PLAN IS ALWAYS FILLED. Every lead a customer pays for is delivered,
 * and a short month rolls over (locked decision 2, A1). A thin area widens to
 * the cap, is stored, and the mix leans to Nearby (A3), with nothing shown to
 * the customer about supply. So this fires ONLY when the customer's own
 * essentials are what hold the area back:
 *
 *   - with the essentials, the area at the cap cannot reach the target, and
 *   - without them, it can (the same ×1.3 target the area is sized by).
 *
 * When even no essentials cannot reach it, the gap is supply. That is an admin
 * matter (the Lead Reach page and its weekly alert), never a customer message,
 * and this returns null.
 *
 * The result names which essential is the cause and how far to relax it: each
 * essential's ladder is walked down one step at a time (revenue down
 * GROSS_THRESHOLDS, bedrooms one fewer, then the essential dropped) and stops
 * at the first step that lets the area cover the plan. If no single essential
 * is enough but relaxing both is, both are named, each dropped.
 *
 * The A7 options ride along, each offered only when it would actually work.
 * The wording is Phase 3 copy: always a gain, never "drop your requirement"
 * (A6, A9).
 */
export interface BottleneckCause {
  essential: EssentialKey;
  /** The first relaxed threshold that lets the area cover the plan; null means include every value. */
  relaxTo: number | null;
}

export interface Bottleneck {
  /** Fewest steps first. */
  causes: BottleneckCause[];
  /** Widen your area: a larger travel limit, up to the plan maximum, would cover the plan. */
  canWiden: boolean;
  /** Switch to 10 leads a month: the 10-lead plan would be covered with these essentials. */
  canSwitchToSmallerPlan: boolean;
  /** Book a call is always offered. There is no waitlist (A7). */
  canBookCall: true;
}

export function computeBottleneck(args: {
  brief: NormalisedBrief;
  plan: BriefPlan;
  current: ServiceArea;
  /** Recompute the service area for a modified brief and plan (same supply). */
  areaFor: (brief: NormalisedBrief, plan: BriefPlan) => ServiceArea;
}): Bottleneck | null {
  const { brief, plan, current } = args;
  if (current.meetsTarget || brief.essentials.length === 0) return null;

  const covers = (b: NormalisedBrief) => args.areaFor(b, plan).meetsTarget;

  let withoutEssentials = brief;
  for (const e of brief.essentials) withoutEssentials = relaxBrief(withoutEssentials, e, null);
  if (!covers(withoutEssentials)) return null;

  const found: (BottleneckCause & { steps: number })[] = [];
  for (const essential of brief.essentials) {
    let threshold = essentialThreshold(brief, essential);
    let steps = 0;
    while (threshold !== null) {
      const next = relaxedThreshold(essential, threshold);
      steps++;
      if (covers(relaxBrief(brief, essential, next))) {
        found.push({ essential, relaxTo: next, steps });
        break;
      }
      threshold = next;
    }
  }
  found.sort((a, b) => a.steps - b.steps);

  const causes: BottleneckCause[] =
    found.length > 0
      ? found.map(({ essential, relaxTo }) => ({ essential, relaxTo }))
      : brief.essentials.map((essential) => ({ essential, relaxTo: null }));

  return {
    causes,
    canWiden:
      brief.travelLimitMiles !== null &&
      brief.travelLimitMiles < PLAN_MAX_MILES[plan] &&
      covers({ ...brief, travelLimitMiles: null }),
    canSwitchToSmallerPlan: plan === 20 && args.areaFor(brief, 10).meetsTarget,
    canBookCall: true,
  };
}
