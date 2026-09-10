/**
 * What happens when an operator reports a lead as dead on arrival, and what
 * stops that becoming a way to fish for better leads.
 *
 * A dead lead is one where the landlord had already appointed another operator,
 * or withdrawn, BEFORE the operator reached them. Invariant 4 says every
 * delivered lead is chargeable and reject does not refund; §51 adds this as its
 * second exception, and it is the mirror of §39's: that one refunds because no
 * value was delivered, this one because the value delivered was void.
 *
 * ⚠️ ELIGIBILITY IS NOT DECIDED HERE. Whether the assignment can be claimed at
 * all — the claim window, the proof that it was actually worked, the won and
 * pool bars — lives in `claimable_dead_lead_assignments` (0137), in SQL,
 * because it has to agree with the row lock inside `apply_dead_lead_claim`.
 * §5E takes the same position for reject: one predicate, one place, so route
 * and function cannot disagree. This module decides only what SQL cannot —
 * the allowance, and what the co-assigned operators imply.
 *
 * ⚠️ THE ALLOWANCE IS NEVER SHOWN TO THE CUSTOMER, and none of the messages
 * below may name it. A published budget is a budget to play against: an
 * operator told they have two claims a month has been handed the exact number
 * of leads it is safe to write off without evidence. The mechanism only works
 * while the number is discovered rather than announced, so `deadLeadPolicy.test.ts`
 * asserts mechanically that no message contains "allowance", "quota", "budget"
 * or "limit".
 *
 * Going over the budget is not a refusal either. It sends the claim to admin
 * review, where a person reads the landlord's own words and decides. An
 * operator receiving genuinely dead leads is exactly who would exceed a budget,
 * and refusing them automatically would punish the customer this exists for.
 */

import { holdsProduct, type ProductCustomerFields } from "@/lib/products";
import type { LeadType } from "@/lib/types";
import {
  DEAD_LEAD_REASONS,
  MIN_DETAIL_LENGTH,
  type DeadLeadReason,
} from "@/lib/quality/deadLeadCopy";

// The customer-facing half lives in `deadLeadCopy.ts` so the claim form can
// import it without dragging `plans.ts` into the browser bundle (§21.8's rule
// for `featureRequest.ts`). Re-exported here so callers still have one import.
export {
  DEAD_LEAD_REASONS,
  DEAD_LEAD_REASON_LABELS,
  MIN_DETAIL_LENGTH,
} from "@/lib/quality/deadLeadCopy";
export type { DeadLeadReason } from "@/lib/quality/deadLeadCopy";

/**
 * How far back a claim can reach. Passed into
 * `claimable_dead_lead_assignments` rather than baked into the SQL default, so
 * the window this module reasons about and the window the database enforces are
 * one number.
 *
 * Two weeks because a claim is a statement about the landlord's state at a
 * moment: reported three months on, it cannot be traced to a source and cannot
 * be checked against what the landlord says now.
 */
export const CLAIM_WINDOW_DAYS = 14;

/** Chargeable leads taken without a claim that earn one extra claim of headroom. */
export const STREAK_LEADS_PER_BONUS = 10;

/** Ceiling on the earned half, so a long-standing account cannot bank a year of claims. */
export const MAX_EARNED_BONUS = 2;

export type ClaimDecision = "auto_uphold" | "review" | "ineligible";
export type Corroboration = "none" | "peer_agrees" | "peer_contradicts";

/** Another operator holding the same lead, and how their own claim went. */
export interface PeerAssignment {
  status?: string | null;
  pipeline_stage?: string | null;
  /** `lead_quality_claims.status` for that peer's claim, or null if they made none. */
  claim_status?: string | null;
}

export interface AllowanceFields {
  monthly_allocation?: number | null;
  gr_monthly_allocation?: number | null;
  quality_allowance_pct?: number | null;
  quality_claims_this_cycle?: number | null;
  clean_leads_streak?: number | null;
  quality_review_required?: boolean | null;
}

export type ClaimCustomer = AllowanceFields & ProductCustomerFields;

export interface DeadLeadClaimInputs {
  customer: ClaimCustomer;
  /** Other operators holding the same lead. Empty when it went to one operator. */
  peers: PeerAssignment[];
  reason: unknown;
  detail: unknown;
  contactedOn: unknown;
}

export interface DeadLeadClaimVerdict {
  decision: ClaimDecision;
  /** True only when an auto-uphold spends one of the hidden budget. */
  consumesAllowance: boolean;
  corroboration: Corroboration;
  /** Machine-readable outcome, safe to branch on in the route and the UI. */
  code: string;
  /** Customer-facing sentence. Never names the allowance — see the header. */
  message: string;
}

/**
 * The hidden budget: a share of what the customer is committed to each month,
 * plus headroom earned by taking leads without claiming.
 *
 * Sized on the allocation of every product they HOLD, not on the product of the
 * lead being claimed. One budget spans both (0137's own note on
 * `reset_monthly_counts`) because it bounds a customer's claiming behaviour
 * rather than a product's economics — and sizing it per claim would mean a
 * customer holding both products had a different budget depending on which lead
 * they happened to report first.
 *
 * `holdsProduct` is the gate for the same reason it always is (invariant 6): a
 * GR-only customer sits at `account_status = 'waitlisted'` for ever (§18A), and
 * a management-only one carries `gr_monthly_allocation` at its default of 10
 * whether or not they have ever held GR. Reading the columns without it would
 * hand both of them a budget for a product they do not have.
 */
export function committedAllocation(customer: ClaimCustomer): number {
  let total = 0;
  if (holdsProduct(customer, "management" as LeadType)) {
    total += Math.max(0, Math.trunc(customer.monthly_allocation ?? 0));
  }
  if (holdsProduct(customer, "guaranteed_rent" as LeadType)) {
    total += Math.max(0, Math.trunc(customer.gr_monthly_allocation ?? 0));
  }
  return total;
}

/** Earned headroom: one claim per unbroken run of leads taken without claiming. */
export function earnedBonus(customer: ClaimCustomer): number {
  const streak = Math.max(0, Math.trunc(customer.clean_leads_streak ?? 0));
  return Math.min(Math.floor(streak / STREAK_LEADS_PER_BONUS), MAX_EARNED_BONUS);
}

/**
 * Claims this customer may have upheld automatically this cycle.
 *
 * ⚠️ Never rendered anywhere. It exists so the route can decide, and so admin
 * can see why a claim landed in the queue.
 */
export function claimBudget(customer: ClaimCustomer): number {
  const pct = Number(customer.quality_allowance_pct ?? 0.1);
  const base = Number.isFinite(pct) && pct > 0
    ? Math.round(committedAllocation(customer) * pct)
    : 0;
  return Math.max(0, base) + earnedBonus(customer);
}

function isReason(v: unknown): v is DeadLeadReason {
  return (
    typeof v === "string" &&
    (DEAD_LEAD_REASONS as readonly string[]).includes(v)
  );
}

/**
 * Whether a co-assigned operator is visibly still working the same lead.
 *
 * `in_discussion` and `won` are statuses only real progress produces, and any
 * pipeline stage past `cold` means the operator has built something on the
 * lead. Either is evidence the landlord was reachable and interested when this
 * lead was sold — which is the one thing that can genuinely contradict a claim
 * that they were already gone.
 */
function peerIsLive(peer: PeerAssignment): boolean {
  const status = peer.status ?? null;
  if (status === "in_discussion" || status === "won") return true;
  const stage = peer.pipeline_stage ?? null;
  return Boolean(stage) && stage !== "cold";
}

/** Whether a peer's own claim has been SETTLED in favour of the lead being dead. */
function peerAgrees(peer: PeerAssignment): boolean {
  return peer.claim_status === "auto_upheld" || peer.claim_status === "upheld";
}

/**
 * Decide what to do with a claim the database has already agreed is claimable.
 *
 * First match wins, and the order is the rule:
 *
 *   1. The submission itself is incomplete. Nothing is written and the customer
 *      is told exactly what is missing, so they can claim properly rather than
 *      losing the chance.
 *   2. Admin has put this customer under review. A per-customer switch, so a
 *      pattern of claims can be watched without changing the policy for
 *      everybody.
 *   3. A peer is visibly still working the lead. One operator with it live is
 *      evidence it was not dead on arrival, so a person decides — this is never
 *      an automatic refusal, because two operators can honestly disagree about
 *      one landlord.
 *   4. A peer's own claim was already upheld. Agreeing with a settled claim is
 *      free: it costs no budget, so telling the truth about a lead somebody
 *      else has already proved dead is cheaper than fishing. ⚠️ Only SETTLED
 *      claims corroborate. An `under_review` peer claim must not, or two
 *      customers holding one lead could agree their way to unlimited free
 *      credits without a person ever seeing either claim.
 *   5. Inside the budget, uphold and spend one. Beyond it, review.
 *
 * ⚠️ Contradiction is tested BEFORE corroboration. When one peer has the lead
 * live and another has written it off, the live one is the stronger signal and
 * the claim wants a person's eyes.
 */
export function decideDeadLeadClaim(
  input: DeadLeadClaimInputs
): DeadLeadClaimVerdict {
  const ineligible = (code: string, message: string): DeadLeadClaimVerdict => ({
    decision: "ineligible",
    consumesAllowance: false,
    corroboration: "none",
    code,
    message,
  });

  if (!isReason(input.reason)) {
    return ineligible(
      "reason_required",
      "Tell us which of the three applies, so we can trace where the lead came from."
    );
  }

  const detail = typeof input.detail === "string" ? input.detail.trim() : "";
  if (detail.length < MIN_DETAIL_LENGTH) {
    return ineligible(
      "detail_too_short",
      `Tell us what the landlord actually said, in at least ${MIN_DETAIL_LENGTH} characters. It is what lets us trace the lead back to its source.`
    );
  }

  const contactedOn =
    typeof input.contactedOn === "string" ? input.contactedOn.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(contactedOn)) {
    return ineligible(
      "contacted_on_required",
      "Tell us roughly when you spoke to them."
    );
  }

  const peers = Array.isArray(input.peers) ? input.peers : [];

  if (input.customer.quality_review_required === true) {
    return {
      decision: "review",
      consumesAllowance: false,
      corroboration: "none",
      code: "customer_under_review",
      message: "Thanks — we are looking into this one and will come back to you.",
    };
  }

  if (peers.some(peerIsLive)) {
    return {
      decision: "review",
      consumesAllowance: false,
      corroboration: "peer_contradicts",
      code: "peer_contradicts",
      message: "Thanks — we are looking into this one and will come back to you.",
    };
  }

  if (peers.some(peerAgrees)) {
    return {
      decision: "auto_uphold",
      consumesAllowance: false,
      corroboration: "peer_agrees",
      code: "corroborated",
      message:
        "Thanks — that matches what another operator found. The credit is back on your account.",
    };
  }

  const used = Math.max(0, Math.trunc(input.customer.quality_claims_this_cycle ?? 0));
  if (used < claimBudget(input.customer)) {
    return {
      decision: "auto_uphold",
      consumesAllowance: true,
      corroboration: "none",
      code: "upheld",
      message: "Thanks — the credit is back on your account.",
    };
  }

  return {
    decision: "review",
    consumesAllowance: false,
    corroboration: "none",
    code: "needs_review",
    message: "Thanks — we are looking into this one and will come back to you.",
  };
}
