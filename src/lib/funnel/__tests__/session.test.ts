/**
 * The funnel's pure rules (batch 02 Phase 2).
 *
 * WHAT BREAKS IF THESE FAIL
 * -------------------------
 * The rate limit is what stops one link being used to read our supply a
 * thousand times. "Already set up" is what stops a paying customer being sold
 * the product they hold. The body parser is what stops n8n writing a row 0165
 * would refuse, or a Guaranteed Rent enquirer being sold Management.
 */
import { describe, expect, it } from "vitest";
import {
  advanceStep,
  FUNNEL_PREVIEW_LIMIT,
  FUNNEL_PREVIEW_WINDOW_SECONDS,
  FUNNEL_STEPS,
  funnelEnabledFrom,
  isAlreadySetUp,
  namesOtherProduct,
  parseSessionRequest,
  previewAllowed,
  sessionPhone,
} from "@/lib/funnel/session";

describe("the preview rate limit", () => {
  it("is 20 a token per 24 hours (02 Phase 2), pinned literally", () => {
    expect(FUNNEL_PREVIEW_LIMIT).toBe(20);
    expect(FUNNEL_PREVIEW_WINDOW_SECONDS).toBe(86400);
  });

  it("allows the 20th preview and refuses the 21st", () => {
    expect(previewAllowed(1)).toBe(true);
    expect(previewAllowed(20)).toBe(true);
    expect(previewAllowed(21)).toBe(false);
    expect(previewAllowed(500)).toBe(false);
  });

  it("refuses a count it cannot trust", () => {
    expect(previewAllowed(null)).toBe(false);
    expect(previewAllowed(undefined)).toBe(false);
    expect(previewAllowed(0)).toBe(false);
  });
});

describe("funnelEnabledFrom", () => {
  it("is on only for the literal true", () => {
    expect(funnelEnabledFrom("true")).toBe(true);
    expect(funnelEnabledFrom(" true ")).toBe(true);
    for (const v of ["false", "TRUE", "1", "yes", "", null, undefined]) {
      expect(funnelEnabledFrom(v)).toBe(false);
    }
  });
});

describe("isAlreadySetUp", () => {
  const row = (over: Record<string, string>) => ({
    account_status: "waitlisted",
    subscription_status: "inactive",
    gr_subscription_status: "inactive",
    ...over,
  }) as Parameters<typeof isAlreadySetUp>[0];

  it("is true for an active or paid Management customer", () => {
    expect(isAlreadySetUp(row({ account_status: "active" }))).toBe(true);
    expect(isAlreadySetUp(row({ subscription_status: "active" }))).toBe(true);
    expect(isAlreadySetUp(row({ subscription_status: "past_due" }))).toBe(true);
  });

  it("is false for an enquirer, a leaver and a Guaranteed Rent-only customer", () => {
    expect(isAlreadySetUp(row({}))).toBe(false);
    expect(isAlreadySetUp(row({ account_status: "cancelled", subscription_status: "canceled" }))).toBe(false);
    // A GR-only subscriber sits at account_status 'waitlisted' (§18A) and may buy Management.
    expect(isAlreadySetUp(row({ gr_subscription_status: "active" }))).toBe(false);
    expect(isAlreadySetUp(null)).toBe(false);
  });
});

describe("parseSessionRequest", () => {
  const ok = { monday_item_id: "13049622496", name: "  Jane   Smith ", email: " Jane@Example.COM ", phone: "07700 900123" };

  it("reads the four named fields, normalised", () => {
    const r = parseSessionRequest(ok);
    expect(r).toEqual({
      ok: true,
      value: { mondayItemId: "13049622496", name: "Jane Smith", email: "jane@example.com", phone: "+447700900123" },
    });
  });

  it("ignores every other field in the body", () => {
    const r = parseSessionRequest({ ...ok, step: "paid", customer_id: "x", token_hash: "f".repeat(64) });
    expect(r.ok && Object.keys(r.value).sort()).toEqual(["email", "mondayItemId", "name", "phone"]);
  });

  it("refuses what 0165 would refuse", () => {
    expect(parseSessionRequest({ ...ok, email: "not-an-email" })).toEqual({ ok: false, error: "email_invalid" });
    expect(parseSessionRequest({ ...ok, name: "   " })).toEqual({ ok: false, error: "name_missing" });
    expect(parseSessionRequest({ ...ok, monday_item_id: "item-12" })).toEqual({
      ok: false,
      error: "monday_item_id_invalid",
    });
    expect(parseSessionRequest(null)).toEqual({ ok: false, error: "email_invalid" });
  });

  it("accepts a numeric Monday id and no id at all", () => {
    const n = parseSessionRequest({ ...ok, monday_item_id: 13049622496 });
    expect(n.ok && n.value.mondayItemId).toBe("13049622496");
    const none = parseSessionRequest({ ...ok, monday_item_id: undefined });
    expect(none.ok && none.value.mondayItemId).toBeNull();
  });

  it("caps the name at the CHECK's 200 characters", () => {
    const r = parseSessionRequest({ ...ok, name: "x".repeat(250) });
    expect(r.ok && r.value.name).toHaveLength(200);
  });

  it("refuses Guaranteed Rent in any spelling (02 locked decision 1)", () => {
    for (const product of ["guaranteed_rent", "Guaranteed rent", "guaranteed-rent", "gr"]) {
      expect(parseSessionRequest({ ...ok, product })).toEqual({ ok: false, error: "management_only" });
    }
    expect(parseSessionRequest({ ...ok, product: "management" }).ok).toBe(true);
  });
});

describe("namesOtherProduct", () => {
  it("absent means Management", () => {
    expect(namesOtherProduct({})).toBe(false);
    expect(namesOtherProduct({ product: "" })).toBe(false);
    expect(namesOtherProduct(null)).toBe(false);
  });

  it("reads the three spellings a caller might use", () => {
    expect(namesOtherProduct({ lead_type: "guaranteed_rent" })).toBe(true);
    expect(namesOtherProduct({ leadType: "guaranteed_rent" })).toBe(true);
    expect(namesOtherProduct({ product: 7 })).toBe(true);
  });
});

describe("sessionPhone", () => {
  it("stores a UK mobile as E.164, and anything else as sent (§57.8)", () => {
    expect(sessionPhone("+4407304208011")).toBe("+447304208011");
    expect(sessionPhone("01904 123456")).toBe("01904 123456");
    expect(sessionPhone("+31 6 12345678")).toBe("+31 6 12345678");
  });

  it("drops what is not a phone number at all", () => {
    expect(sessionPhone("")).toBeNull();
    expect(sessionPhone(null)).toBeNull();
    expect(sessionPhone("x".repeat(41))).toBeNull();
  });
});

describe("advanceStep", () => {
  it("only moves forward", () => {
    expect(advanceStep("started", "previewed")).toBe("previewed");
    expect(advanceStep("checkout_started", "previewed")).toBe("checkout_started");
    expect(advanceStep("paid", "previewed")).toBe("paid");
  });

  it("follows 0165's step list in order", () => {
    expect([...FUNNEL_STEPS]).toEqual(["started", "questions_done", "previewed", "checkout_started", "paid"]);
  });
});
