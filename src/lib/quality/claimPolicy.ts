/**
 * Decides what happens when a customer reports a lead was dead on arrival.
 *
 * This module is deliberately pure — no database, no network — so the
 * anti-fishing rules can be unit-tested directly rather than through the route.
 * apply_quality_claim (migration 0027) commits whatever this returns.
 *
 * The mechanism that makes fishing unprofitable is a HIDDEN, EARNED allowance:
 * a per-cycle budget of upheld claims equal to a share of the customer's plan
 * plus credits earned by taking leads WITHOUT claiming. Claiming resets the
 * earned streak, so the budget shrinks exactly as it is spent. Claims beyond
 * the budget are never silently declined — they go to a human.
 *
 * None of these numbers are ever shown to the customer. What is stated plainly
 * in the dashboard guide is that claims are reviewed and are not automatically
 * upheld, which is true without publishing a gameable formula.
 */

/** Reasons that describe a lead which was already gone when it arrived. */
export type DeadLeadReason =
  | "already_with_operator"
  | "no_longer_interested"
  | "unreachable";

export const DEAD_LEAD_REASONS: DeadLeadReason[] = [
  "already_with_operator",
  "no_longer_interested",
  "unreachable",
];

export function isDeadLeadReason(value: unknown): value is DeadLeadReason {
  return DEAD_LEAD_REASONS.includes(value as DeadLeadReason);
}

export type ClaimDecision = "auto_uphold" | "review" | "ineligible";
export type Corroboration = "none" | "peer_agrees" | "peer_contradicts";

/** Why a claim was not actionable. Drives the customer-facing message. */
export type IneligibleCode =
  | "window_expired"
  | "not_worked"
  | "detail_too_short"
  | "missing_contact_date";

/** Why an actionable claim landed where it did. Admin-facing only. */
export type DecisionCode =
  | IneligibleCode
  | "forced_review"
  | "peer_contradicts"
  | "peer_agrees"
  | "within_allowance"
  | "over_allowance";

/** A claim must arrive within this many days of the lead being assigned. */
export const QUALITY_CLAIM_WINDOW_DAYS = 14;

/** Clean leads needed to earn one extra claim credit. */
export const CLEAN_STREAK_PER_CREDIT = 10;

/** Most earned credits a customer can bank on top of their base allowance. */
export const EARNED_CEILING = 2;

/** Minimum length of the "what did the landlord say" detail. */
export const MIN_DETAIL_LENGTH = 20;

/**
 * Pipeline stages that prove the landlord was still live when a co-assigned
 * operator worked them. 'cold' means nothing happened yet; 'abandoned' agrees
 * with the claim rather than contradicting it. A booked meeting counts even if
 * the landlord then failed to attend — the booking itself is the proof.
 */
const ENGAGED_STAGES = new Set([
  "interested_in_the_future",
  "web_meeting_booked",
  "web_meeting_no_show",
  "web_meeting_attended",
  "viewing_booked",
  "contract_sent",
  "contract_signed",
]);

/** Assignment statuses that show a peer got somewhere with the landlord. */
const ENGAGED_STATUSES = new Set(["in_discussion", "won"]);

/** Claim states that count as adjudicated, and so can corroborate. */
const SETTLED_CLAIM_STATES = new Set(["auto_upheld", "upheld"]);

/** A co-assigned operator's view of the same lead. */
export interface PeerAssignment {
  status: string;
  pipeline_stage: string;
  rejection_reason: string | null;
  /** Status of that peer's own quality claim, if they filed one. */
  claim_status: string | null;
}

export interface ClaimAssignment {
  assigned_at: string;
  status: string;
  pipeline_stage: string;
  rejection_reason: string | null;
}

export interface ClaimCustomer {
  monthly_allocation: number;
  quality_allowance_pct: number;
  quality_claims_this_cycle: number;
  clean_leads_streak: number;
  quality_review_required: boolean;
}

export interface ClaimInput {
  assignment: ClaimAssignment;
  customer: ClaimCustomer;
  peers: PeerAssignment[];
  /** Notes this customer has written on the lead. */
  noteCount: number;
  reason: DeadLeadReason;
  detail: string;
  contactedOn: string | null;
  now?: Date;
}

export interface ClaimDecisionResult {
  decision: ClaimDecision;
  consumesAllowance: boolean;
  corroboration: Corroboration;
  code: DecisionCode;
}

/**
 * The customer's claim budget for this cycle: a share of their plan, plus one
 * credit per run of clean leads, capped. Exported so admin can display it —
 * never surfaced to the customer.
 */
export function allowanceBudget(customer: ClaimCustomer): number {
  const base = Math.round(
    (customer.monthly_allocation ?? 0) * (customer.quality_allowance_pct ?? 0)
  );
  const earned = Math.min(
    Math.floor((customer.clean_leads_streak ?? 0) / CLEAN_STREAK_PER_CREDIT),
    EARNED_CEILING
  );
  return Math.max(base, 0) + earned;
}

function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24);
}

/** True once the customer has actually worked the lead. */
function hasWorkedLead(assignment: ClaimAssignment, noteCount: number): boolean {
  return (
    noteCount > 0 ||
    assignment.status !== "new" ||
    assignment.pipeline_stage !== "cold"
  );
}

/** A peer who got engagement proves the lead was not dead on arrival. */
function peerContradicts(peers: PeerAssignment[]): boolean {
  return peers.some(
    (p) =>
      ENGAGED_STATUSES.has(p.status) || ENGAGED_STAGES.has(p.pipeline_stage)
  );
}

/**
 * A peer whose own dead-lead claim was upheld corroborates this one. Only
 * settled claims count: an unadjudicated claim is not evidence, and requiring
 * adjudication means a corroborating claim has already passed a budget or a
 * human, so two customers cannot agree their way to unlimited free claims.
 */
function peerAgrees(peers: PeerAssignment[]): boolean {
  return peers.some(
    (p) =>
      isDeadLeadReason(p.rejection_reason) &&
      p.claim_status !== null &&
      SETTLED_CLAIM_STATES.has(p.claim_status)
  );
}

/**
 * Decide a dead-lead claim. Rules run in order and the first that matches wins.
 */
export function decideClaim(input: ClaimInput): ClaimDecisionResult {
  const { assignment, customer, peers, noteCount, detail, contactedOn } = input;
  const now = input.now ?? new Date();

  const ineligible = (code: IneligibleCode): ClaimDecisionResult => ({
    decision: "ineligible",
    consumesAllowance: false,
    corroboration: "none",
    code,
  });

  // 1. Eligibility. A claim has to be timely and backed by actual work, which
  //    is what makes a false claim cost something.
  const assignedAt = new Date(assignment.assigned_at);
  if (
    Number.isFinite(assignedAt.getTime()) &&
    daysBetween(assignedAt, now) > QUALITY_CLAIM_WINDOW_DAYS
  ) {
    return ineligible("window_expired");
  }
  if (!hasWorkedLead(assignment, noteCount)) {
    return ineligible("not_worked");
  }
  if ((detail ?? "").trim().length < MIN_DETAIL_LENGTH) {
    return ineligible("detail_too_short");
  }
  if (!contactedOn) {
    return ineligible("missing_contact_date");
  }

  // 2. Admin has put this customer under manual review.
  if (customer.quality_review_required) {
    return {
      decision: "review",
      consumesAllowance: false,
      corroboration: "none",
      code: "forced_review",
    };
  }

  // 3. Contradiction beats corroboration: if any co-assigned operator got
  //    engagement, the lead was live and a human should look.
  if (peerContradicts(peers)) {
    return {
      decision: "review",
      consumesAllowance: false,
      corroboration: "peer_contradicts",
      code: "peer_contradicts",
    };
  }

  // 4. Corroboration. Agreeing with a settled peer claim is free, so telling
  //    the truth costs a customer less than fishing does.
  if (peerAgrees(peers)) {
    return {
      decision: "auto_uphold",
      consumesAllowance: false,
      corroboration: "peer_agrees",
      code: "peer_agrees",
    };
  }

  // 5. The budget. Over it, the claim is reviewed by a human, never dropped.
  if (customer.quality_claims_this_cycle < allowanceBudget(customer)) {
    return {
      decision: "auto_uphold",
      consumesAllowance: true,
      corroboration: "none",
      code: "within_allowance",
    };
  }

  return {
    decision: "review",
    consumesAllowance: false,
    corroboration: "none",
    code: "over_allowance",
  };
}

/**
 * Customer-facing copy for a claim that could not be actioned. Each message
 * names the specific thing that is missing. None of them mention a quota,
 * a budget, or how many claims the customer has left.
 */
export function ineligibleMessage(code: IneligibleCode): string {
  switch (code) {
    case "window_expired":
      return `This lead was assigned more than ${QUALITY_CLAIM_WINDOW_DAYS} days ago, so it can no longer be reported. Please tell us sooner next time and we'll look into it.`;
    case "not_worked":
      return "Add a note about your contact attempt first, then report it. We can only look into leads that have been worked.";
    case "detail_too_short":
      return "Please tell us a little more about what the landlord said, so we can trace where the lead went wrong.";
    case "missing_contact_date":
      return "Please add the date you spoke to the landlord.";
  }
}
