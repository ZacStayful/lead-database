import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildCancelPush,
  GUARANTEED_RENT_SUFFIX,
  MONDAY_CANCEL_LABELS,
  mondayCancelReasonLabel,
  pickCancelItem,
  resolveCancelSource,
} from "@/lib/mondayCancel";
import {
  CANCEL_REASONS,
  STRIPE_CANCELLATION_FEEDBACK,
  cancelReasonLabel,
  composeCancellationComment,
} from "@/lib/cancelOptions";

/**
 * Cancellation reasons pushed to the Monday enquiries board (§72).
 */

describe("mondayCancelReasonLabel", () => {
  it.each([
    ["lead_quality", "Lead quality"],
    ["low_quality", "Lead quality"],
    ["at_capacity", "At capacity"],
    ["unused", "At capacity"],
    ["too_expensive", "Too expensive"],
    ["switched_provider", "Switched provider"],
    ["switched_service", "Switched provider"],
  ])("%s → %s", (key, label) => {
    expect(mondayCancelReasonLabel(key)).toBe(label);
  });

  it.each([
    "not_enough_leads",
    "closing_business",
    "other",
    "customer_service",
    "missing_features",
    "too_complex",
    "payment_failed",
    "toString",
    "",
  ])("%s → Other", (key) => {
    expect(mondayCancelReasonLabel(key)).toBe("Other");
  });

  it("null and undefined → Other", () => {
    expect(mondayCancelReasonLabel(null)).toBe("Other");
    expect(mondayCancelReasonLabel(undefined)).toBe("Other");
  });

  it("every key in both vocabularies lands on one of the five live board labels", () => {
    for (const key of [...Object.keys(CANCEL_REASONS), ...STRIPE_CANCELLATION_FEEDBACK]) {
      expect(MONDAY_CANCEL_LABELS).toContain(mondayCancelReasonLabel(key));
    }
  });

  it("the label list is the board's, literally (duplicated on purpose, §27.2)", () => {
    expect([...MONDAY_CANCEL_LABELS].sort()).toEqual(
      ["At capacity", "Lead quality", "Other", "Switched provider", "Too expensive"]
    );
  });
});

describe("buildCancelPush", () => {
  it("uses the FIRST reason when there are several", () => {
    expect(
      buildCancelPush({
        reasons: ["too_expensive", "lead_quality"],
        comment: null,
        leadType: "management",
      }).label
    ).toBe("Too expensive");
    expect(
      buildCancelPush({
        reasons: ["lead_quality", "too_expensive"],
        comment: null,
        leadType: "management",
      }).label
    ).toBe("Lead quality");
  });

  it("no reasons at all is Other", () => {
    expect(buildCancelPush({ reasons: [], comment: "x", leadType: "management" }).label).toBe(
      "Other"
    );
  });

  it("management comment is the trimmed text, unsuffixed", () => {
    expect(
      buildCancelPush({ reasons: ["other"], comment: "  gone  ", leadType: "management" })
        .comment
    ).toBe("gone");
    expect(
      buildCancelPush({ reasons: ["other"], comment: null, leadType: "management" }).comment
    ).toBe("");
  });

  it("guaranteed rent appends the product to the comment", () => {
    expect(
      buildCancelPush({ reasons: ["other"], comment: "gone", leadType: "guaranteed_rent" })
        .comment
    ).toBe(`gone ${GUARANTEED_RENT_SUFFIX}`);
    expect(
      buildCancelPush({ reasons: ["other"], comment: "  ", leadType: "guaranteed_rent" })
        .comment
    ).toBe(GUARANTEED_RENT_SUFFIX);
    expect(GUARANTEED_RENT_SUFFIX).toBe("(Guaranteed Rent)");
  });
});

describe("resolveCancelSource", () => {
  const stripeFields = {
    cancellation_feedback: "low_quality",
    cancellation_comment: "Not receiving enough leads. Note: slow",
  };

  it("our audit row outranks Stripe's feedback — the convergence rule", () => {
    const r = resolveCancelSource({
      leadType: "management",
      auditRow: { reasons: ["not_enough_leads"], note: "slow" },
      customer: stripeFields,
      labelFor: cancelReasonLabel,
    });
    expect(r).toEqual({ reasons: ["not_enough_leads"], comment: "slow", from: "audit" });
    // And therefore the board reads Other, not Stripe's Lead quality.
    expect(buildCancelPush({ ...r!, leadType: "management" }).label).toBe("Other");
  });

  it("with no note, the audit path uses the reason labels — never the Stripe comment", () => {
    const reasons = ["lead_quality", "switched_provider"] as const;
    const r = resolveCancelSource({
      leadType: "management",
      auditRow: { reasons: [...reasons], note: "  " },
      customer: { cancellation_feedback: "x", cancellation_comment: "from stripe" },
      labelFor: cancelReasonLabel,
    });
    // Identical to what Stripe is sent, so both sources read the same.
    expect(r?.comment).toBe(composeCancellationComment([...reasons], null));
    expect(r?.comment).toBe("The leads weren't the right fit; Using a different lead source");
  });

  it("falls back to Stripe's feedback on management when there is no row", () => {
    expect(
      resolveCancelSource({
        leadType: "management",
        auditRow: null,
        customer: stripeFields,
        labelFor: cancelReasonLabel,
      })
    ).toEqual({
      reasons: ["low_quality"],
      comment: stripeFields.cancellation_comment,
      from: "stripe",
    });
  });

  it("an empty audit row does not shadow Stripe", () => {
    expect(
      resolveCancelSource({
        leadType: "management",
        auditRow: { reasons: [], note: "x" },
        customer: stripeFields,
        labelFor: cancelReasonLabel,
      })?.from
    ).toBe("stripe");
  });

  it("guaranteed rent never reads the management-only Stripe columns (invariant 6)", () => {
    expect(
      resolveCancelSource({
        leadType: "guaranteed_rent",
        auditRow: null,
        customer: stripeFields,
        labelFor: cancelReasonLabel,
      })
    ).toBeNull();
    expect(
      resolveCancelSource({
        leadType: "guaranteed_rent",
        auditRow: { reasons: ["at_capacity"], note: null },
        customer: stripeFields,
        labelFor: cancelReasonLabel,
      })?.reasons
    ).toEqual(["at_capacity"]);
  });

  it("nothing recorded anywhere is null", () => {
    expect(
      resolveCancelSource({
        leadType: "management",
        auditRow: null,
        customer: { cancellation_feedback: null, cancellation_comment: null },
        labelFor: cancelReasonLabel,
      })
    ).toBeNull();
  });
});

describe("pickCancelItem", () => {
  const items = [
    { id: "1", emails: ["a@x.com"] },
    { id: "2", emails: ["b@x.com", "shared@x.com"] },
    { id: "3", emails: ["shared@x.com"] },
  ];

  it("matches case-insensitively, including a two-address cell", () => {
    expect(pickCancelItem("  A@X.com ", null, items)).toEqual({ itemId: "1" });
    expect(pickCancelItem("b@x.com", null, items)).toEqual({ itemId: "2" });
  });

  it("no match → skip, never create", () => {
    expect(pickCancelItem("nobody@x.com", null, items)).toEqual({
      itemId: null,
      reason: "no_match",
    });
  });

  it("no email → the linked item, else skip", () => {
    expect(pickCancelItem(null, "1", items)).toEqual({ itemId: "1" });
    expect(pickCancelItem(null, null, items)).toEqual({ itemId: null, reason: "no_email" });
  });

  it("no email match → the linked item (the account and board emails differ)", () => {
    expect(pickCancelItem("contact@elsewhere.com", "3", items)).toEqual({ itemId: "3" });
  });

  it("several matches → the linked item, else refuse to guess", () => {
    expect(pickCancelItem("shared@x.com", "3", items)).toEqual({ itemId: "3" });
    expect(pickCancelItem("shared@x.com", null, items)).toEqual({
      itemId: null,
      reason: "ambiguous",
    });
    // A linked id that is not among the hits does not break the tie.
    expect(pickCancelItem("shared@x.com", "1", items)).toEqual({
      itemId: null,
      reason: "ambiguous",
    });
  });

  it("a linked id never overrides a single email match", () => {
    expect(pickCancelItem("a@x.com", "3", items)).toEqual({ itemId: "1" });
  });
});

// ── File-text guards on the wiring (§42.8: anchor on the real files) ─────────

const code = (src: string) =>
  src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

const webhook = code(readFileSync("src/app/api/webhook/stripe/route.ts", "utf8"));
const cancelRoute = code(
  readFileSync("src/app/api/customer/subscription/cancel/route.ts", "utf8")
);
const sync = code(readFileSync("src/lib/cancellationMondaySync.ts", "utf8"));
const monday = code(readFileSync("src/lib/monday.ts", "utf8"));
const pure = readFileSync("src/lib/mondayCancel.ts", "utf8");

describe("wiring", () => {
  it("the webhook push is gated on feedback newly set by THIS event, management only", () => {
    expect(webhook).toMatch(
      /const newlyCapturedFeedback =\s*!isGuaranteedRent &&\s*typeof update\.cancellation_feedback === "string" &&\s*update\.cancellation_feedback\.length > 0;/
    );
    expect(webhook).toContain("if (newlyCapturedFeedback && existing?.id) {");
  });

  it("the webhook push sits inside its own try/catch", () => {
    const at = webhook.indexOf("await pushCancellationToMonday(");
    expect(at).toBeGreaterThan(-1);
    const before = webhook.slice(webhook.lastIndexOf("if (newlyCapturedFeedback", at), at);
    expect(before).toMatch(/try \{\s*const pushed = $/);
    const after = webhook.slice(at, at + 700);
    expect(after).toContain("} catch (err) {");
  });

  it("the webhook push scopes the audit lookup to this subscription", () => {
    const at = webhook.indexOf("await pushCancellationToMonday(");
    expect(webhook.slice(at, at + 300)).toContain("stripeSubscriptionId: sub.id");
  });

  it("the cancel route pushes AFTER the audit row is written, inside try/catch", () => {
    const audit = cancelRoute.indexOf("await recordCancellationRequested(");
    const push = cancelRoute.indexOf("await pushCancellationToMonday(");
    expect(audit).toBeGreaterThan(-1);
    expect(push).toBeGreaterThan(audit);
    expect(cancelRoute.slice(push - 60, push)).toMatch(/try \{\s*const pushed = $/);
    // Only on a cancellation, never on "keep".
    const keepBranch = cancelRoute.indexOf("await closeOpenCancellation(");
    expect(push).toBeLessThan(keepBranch);
  });

  it("the sync never creates a board item", () => {
    expect(sync).not.toMatch(/createEnquiryContact|create_item|createBoardContact/);
  });

  it("the linked-item fallback is only trusted when the link is on the enquiries board", () => {
    expect(sync).toMatch(
      /customer\.monday_item_id && customer\.monday_board_id === enquiryBoardId\(\)/
    );
    expect(sync).toContain("pickCancelItem(customer.email, linkedItemId, board.items)");
  });

  it("the audit lookup ignores reverted rows and other subscriptions", () => {
    const start = sync.indexOf('.from("subscription_cancellations")');
    const slice = sync.slice(start, start + 500);
    expect(slice).toContain('.eq("stripe_subscription_id", params.stripeSubscriptionId)');
    expect(slice).toContain('.is("reverted_at", null)');
    expect(slice).toContain('.eq("lead_type", params.leadType)');
  });

  it("the write reads first, suppresses an unchanged push, and never creates labels", () => {
    const start = monday.indexOf("export async function setEnquiryCancellation(");
    const end = monday.indexOf("export interface EnquiryBoardItem", start);
    const fn = monday.slice(start, end);
    expect(fn).toContain('skipped: "unchanged"');
    expect(fn.indexOf('skipped: "unchanged"')).toBeLessThan(
      fn.indexOf("change_multiple_column_values")
    );
    expect(fn).toContain("create_labels_if_missing: false");
    expect(monday).toContain('const ENQUIRY_CANCEL_REASON_COLUMN = "color_mm7n8j39";');
    expect(monday).toContain('const ENQUIRY_CANCEL_COMMENT_COLUMN = "long_text_mm7nz39f";');
  });

  it("mondayCancel.ts stays import-free", () => {
    expect(pure).not.toMatch(/^\s*import\s/m);
  });
});
