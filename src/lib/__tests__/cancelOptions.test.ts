import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CANCEL_NOTE_MAX_LENGTH,
  CANCEL_REASONS,
  CANCEL_REASON_TO_STRIPE_FEEDBACK,
  STRIPE_CANCELLATION_FEEDBACK,
  cancelColumns,
  cancelReasonLabel,
  composeCancellationComment,
  isCancelReason,
  isCancelReasonList,
  stripeFeedbackFor,
  type CancelReason,
} from "@/lib/cancelOptions";

const ALL_REASONS = Object.keys(CANCEL_REASONS) as CancelReason[];

describe("CANCEL_REASONS → Stripe feedback mapping", () => {
  it("maps every reason to a member of Stripe's enum", () => {
    for (const reason of ALL_REASONS) {
      expect(STRIPE_CANCELLATION_FEEDBACK).toContain(
        CANCEL_REASON_TO_STRIPE_FEEDBACK[reason]
      );
    }
  });

  it("has a label for every reason", () => {
    for (const reason of ALL_REASONS) {
      expect(CANCEL_REASONS[reason].length).toBeGreaterThan(0);
      expect(cancelReasonLabel(reason)).toBe(CANCEL_REASONS[reason]);
    }
  });

  it("renders an unknown stored value verbatim rather than crashing", () => {
    expect(cancelReasonLabel("unknown_pre_0077")).toBe("unknown_pre_0077");
  });
});

describe("stripeFeedbackFor collapses multi-reason picks deterministically", () => {
  it("returns the single reason's mapping", () => {
    expect(stripeFeedbackFor(["too_expensive"])).toBe("too_expensive");
    expect(stripeFeedbackFor(["switched_provider"])).toBe("switched_service");
    expect(stripeFeedbackFor(["closing_business"])).toBe("unused");
    expect(stripeFeedbackFor(["other"])).toBe("other");
  });

  it("prefers switched_service over everything", () => {
    expect(
      stripeFeedbackFor(["too_expensive", "switched_provider", "other"])
    ).toBe("switched_service");
  });

  it("prefers too_expensive over quality and circumstance reasons", () => {
    expect(stripeFeedbackFor(["at_capacity", "too_expensive"])).toBe(
      "too_expensive"
    );
  });

  it("prefers low_quality over unused", () => {
    expect(stripeFeedbackFor(["lead_quality", "at_capacity"])).toBe(
      "low_quality"
    );
    expect(stripeFeedbackFor(["not_enough_leads", "closing_business"])).toBe(
      "low_quality"
    );
  });

  it("is order-independent", () => {
    expect(stripeFeedbackFor(["other", "too_expensive"])).toBe(
      stripeFeedbackFor(["too_expensive", "other"])
    );
  });
});

describe("validators", () => {
  it("accepts every defined reason and rejects everything else", () => {
    for (const reason of ALL_REASONS) expect(isCancelReason(reason)).toBe(true);
    expect(isCancelReason("seasonal")).toBe(false); // pause-only reason
    expect(isCancelReason("")).toBe(false);
    expect(isCancelReason(null)).toBe(false);
    expect(isCancelReason(42)).toBe(false);
  });

  it("requires a non-empty array of valid reasons", () => {
    expect(isCancelReasonList(["too_expensive", "other"])).toBe(true);
    expect(isCancelReasonList([])).toBe(false);
    expect(isCancelReasonList(["too_expensive", "nope"])).toBe(false);
    expect(isCancelReasonList("too_expensive")).toBe(false);
  });
});

describe("composeCancellationComment", () => {
  it("joins labels and appends the note", () => {
    expect(composeCancellationComment(["too_expensive"], null)).toBe(
      "Too expensive"
    );
    expect(
      composeCancellationComment(["too_expensive", "lead_quality"], "moving on")
    ).toBe("Too expensive; The leads weren't the right fit. Note: moving on");
  });

  it("never exceeds the note cap, even with a maximal note", () => {
    const long = "x".repeat(CANCEL_NOTE_MAX_LENGTH);
    const composed = composeCancellationComment(ALL_REASONS, long);
    expect(composed.length).toBeLessThanOrEqual(CANCEL_NOTE_MAX_LENGTH);
    expect(composed.endsWith("…")).toBe(true);
  });
});

describe("cancelColumns keeps the products apart (invariant 6)", () => {
  it("management resolves only management columns", () => {
    const cols = cancelColumns("management");
    for (const value of Object.values(cols)) {
      expect(value.startsWith("gr_")).toBe(false);
    }
  });

  it("guaranteed_rent resolves only gr_ columns", () => {
    const cols = cancelColumns("guaranteed_rent");
    for (const value of Object.values(cols)) {
      expect(value.startsWith("gr_")).toBe(true);
    }
  });
});

describe("0101's CHECK constraint matches CANCEL_REASONS", () => {
  it("lists exactly the same values, character for character", () => {
    // The lib's header warns the two must match and nothing enforces it
    // mechanically — this is the mechanism. A drift here is a 500 on submit in
    // production, so it should be a red test here first.
    const sql = readFileSync(
      join(
        process.cwd(),
        "supabase/migrations/0101_self_serve_cancellation.sql"
      ),
      "utf8"
    );
    const constraint = sql.match(
      /subscription_cancellations_reasons_valid[\s\S]*?array\[([\s\S]*?)\]::text\[\]/
    );
    expect(constraint).not.toBeNull();
    const sqlReasons = Array.from(constraint![1].matchAll(/'([^']+)'/g)).map(
      (m) => m[1]
    );
    expect(sqlReasons).toEqual(ALL_REASONS);
  });
});
