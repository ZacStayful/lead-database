import type { BriefPlan, TravelLimit } from "@/lib/leadBrief/plans";
import type { BriefConfirmationInitial } from "@/lib/funnel/confirmationRules";
import { readStoredAnswers } from "@/lib/funnel/answers";
import { readPreviewSnapshot } from "@/lib/funnel/preview";

export type { BriefConfirmationInitial } from "@/lib/funnel/confirmationRules";
export { radiusChangedSincePayment } from "@/lib/funnel/confirmationRules";

/**
 * What a funnel payer's brief confirmation opens on (batch 02 Phase 5, C1).
 *
 * The answers and the preview they paid against live on funnel_sessions, not
 * as a pending brief (C1, decided 9 Oct: no Lead Brief schema change). The
 * onboarding page reads them through this and hands the wizard a prefilled
 * start. The wizard asks the server for the preview again (locked decision 6:
 * the preview is non-binding and recalculated), and says so when the radius
 * has changed from `shownRadiusMiles`.
 *
 * Null when the stored answers cannot be previewed (no base postcode, or the
 * travel question never answered): the payer then answers the questions as
 * any brief customer does, which is the honest fallback. Pure.
 */
export function funnelConfirmationInitial(
  answersRaw: unknown,
  snapshotRaw: unknown,
  plan: BriefPlan
): BriefConfirmationInitial | null {
  const draft = readStoredAnswers(answersRaw);
  // A key that is absent means unanswered; null "Anywhere" is an answer.
  if (!draft.basePostcode || !("travelLimitMiles" in draft)) return null;
  const snapshot = readPreviewSnapshot(snapshotRaw);
  const shown = snapshot?.plans.find((p) => p.plan === plan);
  return {
    basePostcode: draft.basePostcode,
    priorityOutcodes: draft.priorityOutcodes ?? [],
    travelLimitMiles: draft.travelLimitMiles as TravelLimit,
    minBedrooms: draft.minBedrooms ?? null,
    minGross: draft.minGross ?? null,
    similarAreas: draft.similarAreas ?? snapshot?.similarAreas ?? [],
    shownRadiusMiles: typeof shown?.serviceRadiusMiles === "number" ? shown.serviceRadiusMiles : null,
  };
}
