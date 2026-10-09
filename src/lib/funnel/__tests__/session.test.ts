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
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  advanceStep,
  entryPointToWrite,
  FUNNEL_ENTRY_POINTS,
  FUNNEL_OFFER_ORDERS,
  FUNNEL_PREVIEW_LIMIT,
  FUNNEL_PREVIEW_WINDOW_SECONDS,
  FUNNEL_STEPS,
  funnelEnabledFrom,
  isAlreadySetUp,
  isFirstAnswer,
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

  it("reads the named fields, normalised; a caller from before batch 03 gets null routes", () => {
    const r = parseSessionRequest(ok);
    expect(r).toEqual({
      ok: true,
      value: {
        mondayItemId: "13049622496",
        name: "Jane Smith",
        email: "jane@example.com",
        phone: "+447700900123",
        entryPoint: null,
        offerOrder: null,
      },
    });
  });

  it("ignores every other field in the body", () => {
    const r = parseSessionRequest({ ...ok, step: "paid", customer_id: "x", token_hash: "f".repeat(64), first_answered_at: "x" });
    expect(r.ok && Object.keys(r.value).sort()).toEqual([
      "email",
      "entryPoint",
      "mondayItemId",
      "name",
      "offerOrder",
      "phone",
    ]);
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

describe("parseSessionRequest — entry_point and offer_order (batch 03, 0166)", () => {
  const ok = { name: "Jane Smith", email: "jane@example.com" };

  it("accepts every entry point on 0166's list", () => {
    for (const entry_point of FUNNEL_ENTRY_POINTS) {
      const r = parseSessionRequest({ ...ok, entry_point });
      expect(r.ok && r.value.entryPoint).toBe(entry_point);
    }
  });

  it("trims and lower-cases what n8n sends", () => {
    const r = parseSessionRequest({ ...ok, entry_point: " Instant ", offer_order: "FUNNEL_FIRST" });
    expect(r.ok && [r.value.entryPoint, r.value.offerOrder]).toEqual(["instant", "funnel_first"]);
  });

  it("refuses an unknown entry point or offer order, loudly", () => {
    for (const entry_point of ["website", "no-show", "post call", 3, true]) {
      expect(parseSessionRequest({ ...ok, entry_point })).toEqual({ ok: false, error: "entry_point_invalid" });
    }
    for (const offer_order of ["random", "call-first", 1]) {
      expect(parseSessionRequest({ ...ok, entry_point: "instant", offer_order })).toEqual({
        ok: false,
        error: "offer_order_invalid",
      });
    }
  });

  it("reads absent, null and empty as none", () => {
    for (const v of [undefined, null, ""]) {
      const r = parseSessionRequest({ ...ok, entry_point: v, offer_order: v });
      expect(r.ok && [r.value.entryPoint, r.value.offerOrder]).toEqual([null, null]);
    }
  });

  it("keeps the offer order only for the instant message (locked decision 4)", () => {
    for (const offer_order of FUNNEL_OFFER_ORDERS) {
      const instant = parseSessionRequest({ ...ok, entry_point: "instant", offer_order });
      expect(instant.ok && instant.value.offerOrder).toBe(offer_order);
    }
    for (const entry_point of ["chase", "no_show", "post_call", undefined]) {
      const other = parseSessionRequest({ ...ok, entry_point, offer_order: "funnel_first" });
      expect(other.ok && other.value.offerOrder).toBeNull();
    }
  });

  it("holds both lists equal to 0166's CHECKs", () => {
    const sql = readFileSync("supabase/migrations/0166_funnel_routes.sql", "utf8");
    const list = (name: string) => {
      const m = sql.match(new RegExp(`${name} in \\(([^)]*)\\)`));
      expect(m, `missing CHECK list for ${name}`).not.toBeNull();
      return m![1].split(",").map((v) => v.trim().replace(/'/g, ""));
    };
    expect(list("entry_point")).toEqual([...FUNNEL_ENTRY_POINTS]);
    expect(list("offer_order")).toEqual([...FUNNEL_OFFER_ORDERS]);
  });
});

describe("entryPointToWrite (E1)", () => {
  const fresh = { entry_point: "instant", first_answered_at: null, answers: {} };

  it("moves the entry point while nothing has been answered", () => {
    expect(entryPointToWrite(fresh, "chase")).toBe("chase");
    expect(entryPointToWrite({ ...fresh, entry_point: null }, "no_show")).toBe("no_show");
  });

  it("is frozen from the first answer", () => {
    expect(entryPointToWrite({ ...fresh, first_answered_at: "2026-10-09T10:00:00Z" }, "post_call")).toBeNull();
  });

  it("is frozen by stored answers even without the stamp (a session answered before 0166)", () => {
    expect(entryPointToWrite({ ...fresh, answers: { basePostcode: "YO10 5DD" } }, "chase")).toBeNull();
    expect(entryPointToWrite({ ...fresh, answers: { travelLimitMiles: null } }, "chase")).toBeNull();
  });

  it("writes nothing when nothing changes or nothing was sent", () => {
    expect(entryPointToWrite(fresh, "instant")).toBeNull();
    expect(entryPointToWrite(fresh, null)).toBeNull();
    expect(entryPointToWrite({ ...fresh, answers: null }, null)).toBeNull();
  });
});

describe("isFirstAnswer", () => {
  it("is a save carrying any question field, null included, before the stamp", () => {
    expect(isFirstAnswer(null, { basePostcode: "YO10 5DD" })).toBe(true);
    expect(isFirstAnswer(null, { travelLimitMiles: null })).toBe(true);
    expect(isFirstAnswer(null, { minBedrooms: null })).toBe(true);
  });

  it("is not a plan-only save, or anything after the first", () => {
    expect(isFirstAnswer(null, {})).toBe(false);
    expect(isFirstAnswer("2026-10-09T10:00:00Z", { basePostcode: "YO10 5DD" })).toBe(false);
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
