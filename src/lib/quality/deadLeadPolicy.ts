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
  DEAD_LEAD_CONTROL_LABEL,
  DEAD_LEAD_PROMPT_HEADING,
  DEAD_LEAD_PROMPT_BODY,
  DEAD_LEAD_PROMPT_DISMISS,
  DEAD_LEAD_CONFIRM_CONSEQUENCE,
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

/**
 * How many separate visits to a lead before the page offers the report
 * prominently (§51.10).
 *
 * Three, because one visit is a drive-by and the prompt must not read as an
 * invitation to write off any lead you did not fancy. `/api/customer/events`
 * dedupes identical (assignment, event_type) rows inside 60 seconds, so three
 * rows is three genuinely separate visits rather than a refresh spree.
 */
export const DEAD_LEAD_PROMPT_MIN_OPENS = 3;

/**
 * ⚠️ OFF BY ONE, DELIBERATELY, AND THIS IS NOT A BUG TO FIX.
 *
 * `LeadDetail` records `detail_opened` in a mount effect — AFTER the server
 * component has already resolved its data. So on the operator's Nth visit the
 * server sees N-1 rows, and testing for MIN_OPENS would first fire on the
 * FOURTH visit rather than the third.
 *
 * Written as MIN_OPENS - 1 rather than as a literal 2 so a later "correction"
 * of one without the other fails `deadLeadPolicy.test.ts` instead of silently
 * costing every operator a visit. The alternative — re-checking on the client
 * after the event posts — is a second round trip and a block of content
 * appearing under the reader mid-page.
 */
export const DEAD_LEAD_PROMPT_PRIOR_OPENS = DEAD_LEAD_PROMPT_MIN_OPENS - 1;

/**
 * Whether to offer the report prominently, rather than leaving it in the
 * outcome panel.
 *
 * ⚠️ A CONTACT ATTEMPT IS REQUIRED, and it is the most important clause here.
 * The form asks "In their words" and "When did you speak to them?". An operator
 * with three opens and no phone, WhatsApp or email click has read the lead
 * three times and never rung it — prompting them to report what the landlord
 * said is asking them to invent it, and invented reasons poison precisely the
 * dataset this exists to build. Measured on production: of 126 assignments
 * eligible to report, only 30 had ever had any contact event. §42 says the same
 * thing from the other side — 342 of 356 open assignments have never had a
 * single contact action, against 666 opens.
 *
 * This is discovery, NOT a gate. Eligibility is unchanged and lives in SQL,
 * where one event of any kind already qualifies; nothing downstream trusts this
 * answer. So a prompt that can in principle be manufactured by reloading costs
 * nothing — the claim behind it still passes the reason CHECK, the detail
 * floor, the peer rules, the hidden allowance and, over all of it, a person.
 */
export function shouldPromptDeadLead(input: {
  claimable: boolean;
  claimStatus: string | null;
  priorOpens: number;
  hasContactEvent: boolean;
}): boolean {
  if (!input.claimable) return false;
  if (input.claimStatus) return false;
  if (!input.hasContactEvent) return false;
  return input.priorOpens >= DEAD_LEAD_PROMPT_PRIOR_OPENS;
}

/**
 * Narrow an admin-supplied claim allowance to something the column can hold.
 *
 * ⚠️ THIS IS A FRACTION AND MUST NEVER BE FLOORED. Every other number on the
 * admin allocation form is a whole count and goes through
 * `Math.max(0, Math.floor(x))`; copying that here turns the default 0.10 into
 * 0 and silently zeroes the base budget of whoever was saved. It lives in this
 * module rather than inline in the route so the rule is provable under
 * `vitest.config.mts`, which is pure units only — the same argument §33 makes
 * for lifting the credit decision out of the Stripe webhook.
 *
 * Clamped to 0..1: a budget larger than the allocation it is a share of is not
 * a meaningful setting. Returns null for anything that is not a finite number,
 * so the caller leaves the column alone rather than writing a guess.
 */
export function normaliseAllowancePct(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

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
  return Math.min(
    Math.floor(streak / STREAK_LEADS_PER_BONUS),
    MAX_EARNED_BONUS,
  );
}

/**
 * Claims this customer may have upheld automatically this cycle.
 *
 * ⚠️ Never rendered anywhere. It exists so the route can decide, and so admin
 * can see why a claim landed in the queue.
 */
export function claimBudget(customer: ClaimCustomer): number {
  const pct = Number(customer.quality_allowance_pct ?? 0.1);
  const base =
    Number.isFinite(pct) && pct > 0
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
  input: DeadLeadClaimInputs,
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
      "Tell us which of the three applies, so we can trace where the lead came from.",
    );
  }

  const detail = typeof input.detail === "string" ? input.detail.trim() : "";
  if (detail.length < MIN_DETAIL_LENGTH) {
    return ineligible(
      "detail_too_short",
      `Tell us what the landlord actually said, in at least ${MIN_DETAIL_LENGTH} characters. It is what lets us trace the lead back to its source.`,
    );
  }

  const contactedOn =
    typeof input.contactedOn === "string" ? input.contactedOn.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(contactedOn)) {
    return ineligible(
      "contacted_on_required",
      "Tell us roughly when you spoke to them.",
    );
  }

  const peers = Array.isArray(input.peers) ? input.peers : [];

  if (input.customer.quality_review_required === true) {
    return {
      decision: "review",
      consumesAllowance: false,
      corroboration: "none",
      code: "customer_under_review",
      message:
        "Thanks — we are looking into this one and will come back to you.",
    };
  }

  if (peers.some(peerIsLive)) {
    return {
      decision: "review",
      consumesAllowance: false,
      corroboration: "peer_contradicts",
      code: "peer_contradicts",
      message:
        "Thanks — we are looking into this one and will come back to you.",
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

  const used = Math.max(
    0,
    Math.trunc(input.customer.quality_claims_this_cycle ?? 0),
  );
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
