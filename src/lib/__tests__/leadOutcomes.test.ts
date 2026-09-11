import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  OUTCOME_COPY,
  OUTCOME_GROUPS,
  groupOf,
  leadOutcomes,
  type OutcomeGateInputs,
  type OutcomeKey,
} from "@/lib/leadOutcomes";

const read = (p: string) =>
  readFileSync(resolve(__dirname, "..", "..", p), "utf8");

/**
 * ⚠️ Comments are stripped before any of the file-text guards below match.
 * `LeadOutcomePanel`'s own docblock explains why it must render from the
 * constants, and doing so quotes the labels it is forbidden to hard-code — so a
 * naive substring check fails on the explanation and trains the next person to
 * delete the explanation. §46 records the same trap one feature over.
 */
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const base: OutcomeGateInputs = {
  status: "new",
  pipelineStage: "cold",
  hasNotes: false,
  isOwnLead: false,
  isResoldLead: false,
  reportAvailable: false,
};

const at = (over: Partial<OutcomeGateInputs>) =>
  leadOutcomes({ ...base, ...over });

describe("the gates, moved verbatim from LeadDetail", () => {
  it("rejects a cold lead the operator has already rung", () => {
    // §5E: reject is gated on the pipeline stage, not the status, precisely so
    // an operator who merely rang is not locked out of passing on it.
    expect(at({ status: "contacted" }).canReject).toBe(true);
  });

  it("refuses to reject a settled lead in either direction", () => {
    expect(at({ status: "won" }).canReject).toBe(false);
    expect(at({ status: "rejected" }).canReject).toBe(false);
  });

  it("refuses to reject once anything has been built on the lead", () => {
    expect(at({ pipelineStage: "web_meeting_booked" }).canReject).toBe(false);
  });

  it("discards only an untouched, unnoted, new lead", () => {
    expect(at({}).canDiscard).toBe(true);
    expect(at({ hasNotes: true }).canDiscard).toBe(false);
    expect(at({ status: "contacted" }).canDiscard).toBe(false);
  });

  it("refuses discard on a resold lead even when it is new and unnoted", () => {
    // §32.6: it would reopen the slot on a lead already sold once, and
    // isOwnLead cannot catch the buyer — viewerScopedLead nulled the owner id.
    expect(at({ isResoldLead: true }).canDiscard).toBe(false);
  });

  it("offers none of the three on a lead the customer added themselves", () => {
    const o = at({ isOwnLead: true, reportAvailable: false });
    expect([o.canReject, o.canDiscard, o.canClose]).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("closes from any working state, including new", () => {
    for (const status of ["new", "contacted", "in_discussion"]) {
      expect(at({ status }).canClose).toBe(true);
    }
    expect(at({ status: "won" }).canClose).toBe(false);
  });

  it("locks the stage badge once and only once the lead is rejected", () => {
    expect(at({ status: "rejected" }).stageLocked).toBe(true);
    expect(at({ status: "contacted" }).stageLocked).toBe(false);
  });
});

describe("lifting reject and discard out of showActions is a no-op", () => {
  /**
   * ⚠️ The whole basis for moving them. `showActions` used to wrap both, and it
   * now gates only "Mark as contacted". These two equivalences are why that
   * changes nothing — asserted across a matrix rather than argued, because a
   * quiet widening here would offer reject on a lead that cannot take it.
   */
  const statuses = [
    "new",
    "contacted",
    "in_discussion",
    "won",
    "rejected",
    "not_relevant",
  ];
  const stages = ["cold", "web_meeting_booked", "abandoned", "contract_signed"];

  it("showActions && canReject is exactly canReject", () => {
    for (const status of statuses)
      for (const pipelineStage of stages)
        for (const hasNotes of [true, false])
          for (const isOwnLead of [true, false]) {
            const o = at({ status, pipelineStage, hasNotes, isOwnLead });
            expect(o.showActions && o.canReject).toBe(o.canReject);
          }
  });

  it("showActions && canDiscard is exactly canDiscard", () => {
    for (const status of statuses)
      for (const pipelineStage of stages)
        for (const hasNotes of [true, false])
          for (const isResoldLead of [true, false]) {
            const o = at({ status, pipelineStage, hasNotes, isResoldLead });
            expect(o.showActions && o.canDiscard).toBe(o.canDiscard);
          }
  });
});

describe("the grouping, which is what keeps the two apart", () => {
  it("never files the report with the operator's own decisions", () => {
    // §51.6. One group is about the state of the LEAD, the other about the
    // operator's DECISION; collapsing them is the fishing risk.
    expect(groupOf("report")).not.toBe(groupOf("reject"));
    expect(groupOf("reject")).toBe(groupOf("discard"));
    expect(groupOf("close")).toBe(groupOf("reject"));
  });

  it("puts the operator's own decisions first and the refundable one second", () => {
    expect(OUTCOME_GROUPS.map((g) => g.id)).toEqual([
      "not_pursuing",
      "lead_was_spent",
    ]);
  });

  it("lists every outcome exactly once across the groups", () => {
    const all = OUTCOME_GROUPS.flatMap((g) => [...g.options]);
    expect([...all].sort()).toEqual(["close", "discard", "reject", "report"]);
  });
});

describe("the copy", () => {
  it("gives every outcome a consequence", () => {
    for (const key of Object.keys(OUTCOME_COPY) as OutcomeKey[]) {
      expect(OUTCOME_COPY[key].label.trim().length).toBeGreaterThan(0);
      expect(OUTCOME_COPY[key].consequence.trim().length).toBeGreaterThan(0);
    }
  });

  it("carries the timing word that separates a bad lead from a lost deal", () => {
    // ⚠️ CLOSE_REASONS.sorted_elsewhere and the report's already_with_operator
    // are near-identical sentences with opposite money outcomes. One click
    // apart, only the timing distinguishes them.
    expect(OUTCOME_COPY.close.consequence).toContain("since");
    expect(OUTCOME_COPY.report.consequence).toContain("before you got through");
  });

  it("promises nothing on the refundable option", () => {
    // The consequence line is shown in a menu, unprompted. Naming a credit
    // there is the inducement §51.10 keeps out of the prompt.
    expect(OUTCOME_COPY.report.consequence).not.toMatch(
      /credit|refund|free|£/i,
    );
  });

  it("says plainly that reject is not replaced", () => {
    expect(OUTCOME_COPY.reject.consequence).toMatch(
      /isn't replaced|not replaced/,
    );
  });
});

describe("presentation", () => {
  it("renders nothing when there is no outcome left", () => {
    expect(
      at({ status: "won", pipelineStage: "contract_signed" }).presentation,
    ).toBe("none");
  });

  it("renders a lone outcome as itself, never as a menu of one", () => {
    // ⚠️ The case that actually arises: an already-rejected assignment, where
    // only the report survives. A panel headed "What happened with this lead?"
    // containing nothing but the refundable option reads as a prompt to claim.
    const o = at({ status: "rejected", reportAvailable: true });
    expect(o.available).toEqual(["report"]);
    expect(o.presentation).toBe("solo");
  });

  it("renders a panel once there are two", () => {
    expect(at({ reportAvailable: true }).presentation).toBe("panel");
  });
});

describe("the panel renders from the data", () => {
  /**
   * ⚠️ THE LOAD-BEARING RULE OF THE WHOLE COMPONENT. Every assertion above is
   * decorative if `LeadOutcomePanel` can quietly hard-code a different label or
   * a different order. §42.8 records what a guard asserted in words and never
   * in code cost: 91 follow-up runs destroyed six minutes after deploy.
   */
  const panel = code("components/dashboard/LeadOutcomePanel.tsx");

  it("maps the group and copy constants", () => {
    expect(panel).toContain("OUTCOME_GROUPS.map");
    expect(panel).toContain("OUTCOME_COPY[key].consequence");
  });

  it("hard-codes none of the labels", () => {
    for (const key of Object.keys(OUTCOME_COPY) as OutcomeKey[]) {
      expect(panel).not.toContain(OUTCOME_COPY[key].label);
    }
  });

  it("owns no second copy of the claim form", () => {
    expect(panel).toContain("DeadLeadClaimCard");
    expect(panel).not.toContain("/api/customer/dead-lead-claim");
  });
});

describe("what stays out of the panel", () => {
  const detail = code("components/dashboard/LeadDetail.tsx");

  it("keeps the win and the own-data deletion as their own controls", () => {
    // A win and deleting your own lead are different acts, and delete is gated
    // on isOwnLead, which none of the four outcomes share.
    expect(detail).toContain("Mark as signed");
    expect(detail).toContain("Delete this lead");
  });

  it("no longer renders the four outcomes itself", () => {
    expect(detail).not.toContain("Reject this lead");
    expect(detail).not.toContain("Discard lead");
    expect(detail).not.toContain("Didn&apos;t work out");
  });

  it("renders the report in exactly one place at a time", () => {
    // Two copies would be §51.6's own warning turned on itself. The placement
    // is derived ONCE and the card appears once; the panel's own copy of it
    // lives inside LeadOutcomePanel, which is the other half of the pair.
    expect(detail.match(/const deadLeadPlacement/g) ?? []).toHaveLength(1);
    expect(detail.match(/deadLeadPlacement === "banner"/g) ?? []).toHaveLength(
      1,
    );
    expect(detail.match(/<DeadLeadClaimCard/g) ?? []).toHaveLength(1);
  });
});
