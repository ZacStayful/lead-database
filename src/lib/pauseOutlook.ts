import { PAUSE_REASON_UNKNOWN, pauseReasonLabel } from "@/lib/pauseOptions";

/**
 * Whether a paused customer looks likely to come back.
 *
 * STATED RULES, NOT A MODEL. Zero customers have ever cancelled and there is no
 * pause history, so there is nothing to fit — the same position get_customer_risk()
 * took in 0066 and for the same reason. These rules are informed guesses, and the
 * outcome linkage (get_pause_outcomes) is what will eventually let them be
 * checked against reality.
 *
 * Three deliberate refusals:
 *
 *  - No numeric score. A percentage implies a fitted model and would be read as
 *    one.
 *  - A reason alone never lands a customer in "unlikely". Someone who signed
 *    landlords and paused because the leads weren't right is telling us
 *    something about the leads, not about their intent to return.
 *  - "Unclear" is a real band and is never collapsed into "likely" to make the
 *    admin tab look decisive. An honest empty middle is the point, the same way
 *    recycling_basis distinguishes observed from estimated.
 *
 * Every band carries its own reason text. A rules-based verdict the admin cannot
 * audit is indistinguishable from a guess, and this one will be wrong sometimes.
 */

export type PauseBand = "not_returning" | "likely" | "unlikely" | "unclear";

export const PAUSE_BAND_LABEL: Record<PauseBand, string> = {
  not_returning: "Not returning",
  likely: "Likely to return",
  unlikely: "Unlikely to return",
  unclear: "Unclear",
};

/** Reasons that describe a temporary condition rather than a verdict on us. */
const TEMPORARY_REASONS = new Set(["seasonal", "at_capacity"]);

/** Reasons that are a judgement on the product, price or supply. */
const VERDICT_REASONS = new Set([
  "lead_quality",
  "not_enough_leads",
  "too_expensive",
]);

/**
 * Engagement thresholds, measured over the 30 days before the pause.
 *
 * Events and notes ONLY — never status = 'contacted' or first_contacted_at. The
 * PATCH route lets an operator set contacted by hand and CLAUDE.md §18 records
 * that 31 of 87 assignments sit there that way; both customers paused at the
 * time of writing had all 10 assignments marked contacted while one had 31
 * engagement events and 15 notes and the other had 3 and 1. It measures
 * record-keeping, not work — the same trap §10 flags for win rate.
 */
const STRONG_EVENTS = 10;
const STRONG_NOTES = 3;

export interface PauseFacts {
  customer_id: string;
  has_wins: boolean;
  wins: number;
  lifetime_delivered: number;
  engagement_before: number;
  notes_before: number;
  worked_rate: number | null;
  pause_count: number;
  tenure_days: number;
}

/** What Stripe says right now about whether this subscription will bill again. */
export interface BillingHealth {
  /** null when we could not reach Stripe — never treated as healthy. */
  willBill: boolean | null;
  cancelAtPeriodEnd: boolean;
  cancelled: boolean;
  nextChargeAt: string | null;
  error?: string;
}

export interface PauseOutlook {
  band: PauseBand;
  /** Why this band, in words the admin can check against the row. */
  reason: string;
}

function hasStrongEngagement(facts: PauseFacts | undefined): boolean {
  if (!facts) return false;
  return facts.engagement_before >= STRONG_EVENTS || facts.notes_before >= STRONG_NOTES;
}

function describeEngagement(facts: PauseFacts | undefined): string {
  if (!facts) return "no engagement data";
  return `${facts.engagement_before} engagement event${
    facts.engagement_before === 1 ? "" : "s"
  } and ${facts.notes_before} note${facts.notes_before === 1 ? "" : "s"} before pausing`;
}

/**
 * Band a paused customer.
 *
 * `health` outranks every rule below it: a scheduled or completed cancellation
 * is a fact about what the customer has already decided, not an inference from
 * their behaviour.
 */
export function pauseOutlook(
  reasons: string[],
  facts: PauseFacts | undefined,
  health: BillingHealth | undefined
): PauseOutlook {
  if (health?.cancelled) {
    return {
      band: "not_returning",
      reason: "Stripe subscription is already cancelled",
    };
  }
  if (health?.cancelAtPeriodEnd) {
    return {
      band: "not_returning",
      reason: "Cancellation is scheduled in Stripe — billing will not resume",
    };
  }

  const given = reasons.filter((r) => r !== PAUSE_REASON_UNKNOWN);
  const temporary = given.filter((r) => TEMPORARY_REASONS.has(r));
  const verdict = given.filter((r) => VERDICT_REASONS.has(r));
  const strong = hasStrongEngagement(facts);
  const wins = facts?.has_wins ?? false;

  // Checked before "likely" so that a customer who ticked both a temporary and a
  // verdict reason, with nothing behind them, does not get the benefit of the
  // temporary one.
  if (verdict.length > 0 && !wins && !strong) {
    return {
      band: "unlikely",
      reason: `Cited ${verdict
        .map(pauseReasonLabel)
        .join(" and ")
        .toLowerCase()}, no signed clients, and ${describeEngagement(facts)}`,
    };
  }

  if (wins) {
    return {
      band: "likely",
      reason: `Signed ${facts?.wins} client${
        facts?.wins === 1 ? "" : "s"
      } from their leads — proven return on the product`,
    };
  }
  if (strong) {
    return {
      band: "likely",
      reason: `Worked their leads actively — ${describeEngagement(facts)}`,
    };
  }
  if (temporary.length > 0) {
    return {
      band: "likely",
      reason: `Cited ${temporary
        .map(pauseReasonLabel)
        .join(" and ")
        .toLowerCase()} — a temporary condition, not a verdict on the product`,
    };
  }

  if (given.length === 0) {
    return {
      band: "unclear",
      reason: `No reason recorded (paused before we asked), and ${describeEngagement(
        facts
      )}`,
    };
  }
  return {
    band: "unclear",
    reason: `Cited ${given
      .map(pauseReasonLabel)
      .join(" and ")
      .toLowerCase()}, with ${describeEngagement(facts)}`,
  };
}

export const PAUSE_BANDS: PauseBand[] = [
  "likely",
  "unlikely",
  "not_returning",
  "unclear",
];
