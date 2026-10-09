import type { TravelLimit } from "@/lib/leadBrief/plans";

/**
 * The client half of a funnel payer's brief confirmation (batch 02 Phase 5,
 * C1). ⚠️ IMPORT-FREE AT RUNTIME: BriefWizard is a client component, and the
 * server half (confirmation.ts) reads the funnel's stored answers through
 * modules the browser has no need of.
 */
export interface BriefConfirmationInitial {
  basePostcode: string;
  priorityOutcodes: string[];
  travelLimitMiles: TravelLimit;
  minBedrooms: number | null;
  minGross: number | null;
  similarAreas: string[];
  /** The radius the payer was shown for their plan, or null if the snapshot is unreadable. */
  shownRadiusMiles: number | null;
}

/** True when the recalculated preview's radius differs from the one shown before payment. */
export function radiusChangedSincePayment(initial: BriefConfirmationInitial | null | undefined, nowMiles: number): boolean {
  return !!initial && initial.shownRadiusMiles !== null && initial.shownRadiusMiles !== nowMiles;
}
