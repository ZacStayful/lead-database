/**
 * Which endings a lead can be given, and what each one costs (§51.10).
 *
 * Until this existed, `LeadDetail` rendered four separate grey outline buttons —
 * Reject, Discard, "Didn't work out" and the §51 report — scattered down one
 * page, each with its consequence explained only AFTER it was clicked. Measured
 * on production: of 126 assignments eligible to report, 85 showed the
 * chargeable verb and the refundable one as adjacent grey buttons. §51.6 warns
 * that "two controls a click apart that read alike get used interchangeably",
 * and that is the fishing the whole feature guards against.
 *
 * ⚠️ THE GATES BELOW ARE MOVED VERBATIM, COMMENTS INCLUDED, from
 * LeadDetail.tsx. They are the only statement of who may end a lead how, and
 * they are here rather than in the component for one reason: `vitest.config.mts`
 * is PURE UNITS ONLY, no React, so a gate inside a component cannot be proved.
 * Nothing about their meaning changed in the move, and `leadOutcomes.test.ts`
 * asserts that across a generated matrix.
 *
 * ⚠️ Import-free by design, like `outcomeReasons.ts` — a "use client" panel
 * renders this copy (§21.8).
 */

import { FIT_REASONS, type FitReason } from "./outcomeReasons";

export type OutcomeKey = "reject" | "discard" | "close" | "report";
export type OutcomeGroupId = "not_pursuing" | "lead_was_spent";

export interface OutcomeGateInputs {
  status: string;
  pipelineStage: string;
  hasNotes: boolean;
  isOwnLead: boolean;
  isResoldLead: boolean;
  /**
   * Resolved server-side by `deadLeadClaimState`.
   *
   * ⚠️ SINCE 0139 THIS DECIDES ENABLED, NOT SHOWN. The report row renders on
   * every lead either way: an operator who saw the control last week and not
   * this week reads it as broken, and nobody learns the rule from a control
   * that silently comes and goes. What an ineligible lead gets instead is the
   * row, greyed, with the reason underneath (`reportUnavailableBecause`).
   */
  reportAvailable: boolean;
  /**
   * Why the report cannot be used, when it cannot. Rendered under the greyed
   * row. Null when the report is available.
   *
   * ⚠️ It may name the WINDOW, which is publishable policy, and must never name
   * the per-customer allowance (§51.3) — `deadLeadPolicy.test.ts` bans the
   * vocabulary from every file this copy passes through.
   */
  reportUnavailableBecause?: string | null;
}

export interface LeadOutcomes {
  canReject: boolean;
  canDiscard: boolean;
  canClose: boolean;
  stageLocked: boolean;
  /** "Mark as contacted" only — not an outcome, and it does not move. */
  showActions: boolean;
  /**
   * In render order.
   *
   * ⚠️ ACTIONABLE OUTCOMES ONLY, and that is what keeps `presentation` honest.
   * The report is always RENDERED, but a greyed row is not something the
   * operator can do, so counting it here would turn every dead-end lead into a
   * "panel" and defeat the menu-of-one rule below.
   */
  available: OutcomeKey[];
  /** Always true since 0139 — kept as a field so the panel reads from the gates. */
  reportShown: boolean;
  reportEnabled: boolean;
  reportUnavailableBecause: string | null;
  presentation: "panel" | "solo" | "none";
}

/**
 * ⚠️ THE ORDER IS THE RULE, not a layout preference.
 *
 * "You're not taking it forward" comes FIRST and the report second. Discovery
 * for the genuine case is the prompt's job (§51.10); inside a menu, the option
 * that returns money should not be what the eye lands on. The group headings do
 * the rest of §51.6's work — one group is about the operator's DECISION, the
 * other about the state of the LEAD.
 */
export const OUTCOME_GROUPS: readonly {
  id: OutcomeGroupId;
  heading: string;
  options: readonly OutcomeKey[];
}[] = [
  {
    id: "not_pursuing",
    heading: "You're not taking it forward",
    options: ["reject", "discard", "close"],
  },
  {
    id: "lead_was_spent",
    heading: "The lead was already spent before you got to it",
    options: ["report"],
  },
] as const;

/**
 * ⚠️ The consequence is stated HERE, at the point of choosing, rather than in a
 * confirmation after it. That is what stops two options being used
 * interchangeably, and it is the reason this copy lives beside the gates rather
 * than in the component.
 *
 * ⚠️ "since" in close and "before you got through" in report are load-bearing.
 * `CLOSE_REASONS.sorted_elsewhere` ("Already sorted with someone else") and the
 * report's `already_with_operator` ("They had already appointed another
 * operator") are near-identical sentences with OPPOSITE money outcomes. Nobody
 * noticed while they sat at opposite ends of the page; one click apart they are
 * indistinguishable without the timing. One is a bad lead, the other a lost
 * deal.
 */
export const OUTCOME_COPY: Record<
  OutcomeKey,
  { label: string; consequence: string }
> = {
  reject: {
    label: "Reject this lead",
    consequence:
      "Records that you're passing on it. It still counts toward your leads this month and isn't replaced.",
  },
  discard: {
    label: "Discard lead",
    consequence:
      "Puts it back for another operator. Only while you haven't added a note or moved the status, and it still counts toward your leads this month.",
  },
  close: {
    label: "Didn't work out",
    consequence:
      "You reached the landlord and it's finished — they've since gone elsewhere, or they were never interested. Closes it for you, and we stop offering this landlord to anyone else.",
  },
  report: {
    label: "This landlord was already gone",
    consequence:
      "They had already appointed someone, or stopped letting, before you got through. We'll ask what they said and trace it back to where the lead came from.",
  },
};

/** Reject and discard share the fit list; close and report have their own. */
export const OUTCOME_REASONS: Partial<
  Record<OutcomeKey, Record<string, string>>
> = {
  reject: FIT_REASONS,
  discard: FIT_REASONS,
};

export type { FitReason };

export function groupOf(key: OutcomeKey): OutcomeGroupId {
  const group = OUTCOME_GROUPS.find((g) => g.options.includes(key));
  // Every key is in exactly one group, asserted by test.
  return group ? group.id : "not_pursuing";
}

export function leadOutcomes(i: OutcomeGateInputs): LeadOutcomes {
  const { status, pipelineStage, hasNotes, isOwnLead, isResoldLead } = i;

  // A RESOLD lead is excluded too, and the buyer is who that catches. Discard
  // decrements assignment_count, which would reopen the slot on a lead already
  // sold once (§32.6) — the API refuses it and 0107 raises inside the function,
  // so offering the button here would only ever produce a 400. `isOwnLead` does
  // not cover them: viewerScopedLead has nulled the owner id they cannot see,
  // which is exactly the point of it.
  const canDiscard =
    status === "new" && !hasNotes && !isOwnLead && !isResoldLead;

  // Once this customer has rejected the lead the stage is read-only. Rejection
  // is their own settled decision on their own assignment — another operator
  // holding the same lead is unaffected.
  const stageLocked = status === "rejected";

  // Reject is gated on the pipeline stage, not the status (0043). A lead still
  // at 'cold' has had nothing built on it — no meeting, no viewing, no contract
  // — so passing on it costs nothing downstream, even if the status has already
  // moved to 'contacted' (which now also happens automatically, e.g. on a phone
  // click). Terminal outcomes are excluded: rejecting a signed lead would
  // destroy a conversion record. Mirrors reject_lead_assignment exactly.
  const canReject =
    pipelineStage === "cold" &&
    status !== "won" &&
    status !== "rejected" &&
    !isOwnLead;

  // Close is available from any working state, including 'new' — an operator
  // can ring a landlord without the status ever moving, and that is exactly the
  // case the other two exits refuse.
  const canClose =
    !isOwnLead &&
    (status === "new" || status === "contacted" || status === "in_discussion");

  // Unchanged by ownership: the block also carries "Mark as contacted", which
  // an owned lead wants exactly as much as an allocated one.
  //
  // ⚠️ It no longer gates reject or discard, and that is a NO-OP rather than a
  // widening. `showActions && canReject ≡ canReject`, because canReject already
  // excludes 'rejected' and showActions is true whenever status is 'new';
  // `showActions && canDiscard ≡ canDiscard`, because canDiscard requires
  // status === 'new', which makes showActions true. Both equivalences are
  // asserted across a generated matrix in leadOutcomes.test.ts.
  const showActions = status === "new" || canReject;

  const available: OutcomeKey[] = [];
  for (const group of OUTCOME_GROUPS) {
    for (const key of group.options) {
      if (key === "reject" && canReject) available.push(key);
      if (key === "discard" && canDiscard) available.push(key);
      if (key === "close" && canClose) available.push(key);
      if (key === "report" && i.reportAvailable) available.push(key);
    }
  }

  // ⚠️ A menu of one is a wasted click, and in the case that actually arises —
  // an already-rejected assignment, where canReject is false and only the
  // report survives — a panel headed "What happened with this lead?" containing
  // nothing but the refundable option reads as a prompt to claim.
  //
  // ⚠️ Since 0139 the report is RENDERED on every lead, so this counts the
  // actionable options only. A greyed report is not a choice, and counting it
  // would turn the dead-end case above into exactly the panel this avoids. The
  // "none" branch therefore still means "nothing to do here", and the panel
  // shows the greyed report under a heading only when something else is live.
  const presentation =
    available.length === 0 ? "none" : available.length === 1 ? "solo" : "panel";

  return {
    canReject,
    canDiscard,
    canClose,
    stageLocked,
    showActions,
    available,
    reportShown: true,
    reportEnabled: i.reportAvailable,
    reportUnavailableBecause: i.reportAvailable
      ? null
      : (i.reportUnavailableBecause ?? null),
    presentation,
  };
}

/** The one entry point's label. */
export const OUTCOME_ENTRY_LABEL = "What happened with this lead?";
export const OUTCOME_ENTRY_HINT =
  "Only what still applies to this lead is here.";
