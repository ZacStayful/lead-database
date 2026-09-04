import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  hashSha256,
  normaliseEmailForMeta,
  normalisePhoneForMeta,
  splitNameForMeta,
} from "../hash";
import { buildMetaUserData } from "../userData";
import { buildLeadEvent, buildPurchaseEvent, coerceEventId } from "../events";
import { sendMetaConversion } from "../capi";
import { isTrackedPath } from "../paths";

describe("hashSha256", () => {
  it("matches a known SHA-256 vector", () => {
    // ⚠️ A HARDCODED VECTOR, not a round-trip against our own function. Getting
    // the hash wrong is invisible in production — no error, just a permanent
    // 0% match rate — so this must be checked against an outside answer.
    expect(hashSha256("test@example.com")).toBe(
      "973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b"
    );
  });
});

describe("normaliseEmailForMeta", () => {
  it("trims and lowercases before hashing", () => {
    expect(normaliseEmailForMeta("  Test@Example.COM ")).toBe("test@example.com");
  });

  it("rejects a malformed address rather than hashing garbage", () => {
    expect(normaliseEmailForMeta("not-an-email")).toBeNull();
    expect(normaliseEmailForMeta("")).toBeNull();
    expect(normaliseEmailForMeta(null)).toBeNull();
  });

  it("omits `em` entirely rather than emitting an empty hash", () => {
    const data = buildMetaUserData({ email: "not-an-email" });
    expect(data.em).toBeUndefined();
    expect("em" in data).toBe(false);
  });
});

describe("normalisePhoneForMeta", () => {
  it("handles the +44-plus-full-national shape (46% of the live book)", () => {
    // The shape leadQuality.ts documents at length. A naive implementation
    // returns 007304208011 and loses these silently.
    expect(normalisePhoneForMeta("+4407304208011")).toBe("447304208011");
  });

  it("lands every UK spelling on the same value", () => {
    expect(normalisePhoneForMeta("+447711387707")).toBe("447711387707");
    expect(normalisePhoneForMeta("07711387707")).toBe("447711387707");
    expect(normalisePhoneForMeta("07711 387707")).toBe("447711387707");
    expect(normalisePhoneForMeta("(07711) 387-707")).toBe("447711387707");
  });

  it("keeps an explicit foreign number — Meta is global", () => {
    expect(normalisePhoneForMeta("+31612345678")).toBe("31612345678");
  });

  it("keeps a UK landline — Meta does not require a mobile", () => {
    expect(normalisePhoneForMeta("02071234567")).toBe("442071234567");
  });

  it("drops placeholders and blanks", () => {
    expect(normalisePhoneForMeta("0000 0000000")).toBeNull();
    expect(normalisePhoneForMeta("")).toBeNull();
    expect(normalisePhoneForMeta(null)).toBeNull();
  });

  it("never emits a +, a space or a leading zero", () => {
    for (const raw of ["+4407304208011", "07711387707", "+31612345678", "02071234567"]) {
      const out = normalisePhoneForMeta(raw)!;
      expect(out).toMatch(/^[1-9]\d+$/);
    }
  });
});

describe("splitNameForMeta", () => {
  it("takes the LAST token as the surname, not everything after the first", () => {
    // "jane smith" would never match a profile's last_name of "smith".
    expect(splitNameForMeta("Sarah Jane Smith")).toEqual({ fn: "sarah", ln: "smith" });
  });

  it("sends a first name alone for a single-token name", () => {
    expect(splitNameForMeta("Adam")).toEqual({ fn: "adam", ln: null });
  });

  it("drops junk before it becomes a permanent non-matching hash", () => {
    expect(splitNameForMeta("asdf")).toEqual({ fn: null, ln: null });
    expect(splitNameForMeta("n/a")).toEqual({ fn: null, ln: null });
    expect(splitNameForMeta("natalyanaq@gmail.com")).toEqual({ fn: null, ln: null });
    expect(splitNameForMeta("")).toEqual({ fn: null, ln: null });
  });
});

describe("buildMetaUserData", () => {
  it("hashes PII and leaves the browser signals PLAIN", () => {
    const data = buildMetaUserData({
      email: "test@example.com",
      phone: "07711387707",
      fullName: "Sarah Smith",
      fbp: "fb.1.1700000000000.1234567890",
      fbc: "fb.1.1700000000000.IwAR123",
      ipAddress: "203.0.113.9",
      userAgent: "Mozilla/5.0",
    });

    expect(data.em).toEqual([hashSha256("test@example.com")]);
    expect(data.ph).toEqual([hashSha256("447711387707")]);
    expect(data.fn).toEqual([hashSha256("sarah")]);
    expect(data.ln).toEqual([hashSha256("smith")]);
    expect(data.country).toEqual([hashSha256("gb")]);

    // ⚠️ These four must arrive verbatim. Hashing any of them is a silent,
    // permanent non-match with no error anywhere.
    expect(data.fbp).toBe("fb.1.1700000000000.1234567890");
    expect(data.fbc).toBe("fb.1.1700000000000.IwAR123");
    expect(data.client_ip_address).toBe("203.0.113.9");
    expect(data.client_user_agent).toBe("Mozilla/5.0");
  });

  it("emits every hashed field as an array", () => {
    const data = buildMetaUserData({ email: "a@b.com" });
    expect(Array.isArray(data.em)).toBe(true);
  });
});

describe("buildLeadEvent", () => {
  it("builds the documented shape and echoes the dedup id", () => {
    const event = buildLeadEvent({
      eventId: "abc12345",
      userData: {},
      contentName: "lead_10",
    });
    expect(event.event_name).toBe("Lead");
    expect(event.action_source).toBe("website");
    expect(event.event_id).toBe("abc12345");
    expect(event.custom_data).toEqual({ content_name: "lead_10" });
  });

  it("stamps event_time in SECONDS, not milliseconds", () => {
    // Milliseconds reads as roughly the year 57,000 and Meta rejects it in the
    // response body rather than the status code.
    const event = buildLeadEvent({ eventId: "abc12345", userData: {} });
    expect(Math.abs(event.event_time - Date.now() / 1000)).toBeLessThan(5);
  });
});

describe("buildPurchaseEvent", () => {
  it("converts pence to pounds and derives the event id from the invoice", () => {
    const event = buildPurchaseEvent({
      invoiceId: "in_123",
      amountPaidPence: 25000,
      currency: "gbp",
      userData: {},
    });
    expect(event.custom_data?.value).toBe(250);
    expect(event.custom_data?.currency).toBe("GBP");
    expect(event.event_id).toBe("stripe_invoice_in_123");
  });

  it("handles the post-call-coupon amount", () => {
    const event = buildPurchaseEvent({
      invoiceId: "in_9",
      amountPaidPence: 13500,
      userData: {},
    });
    expect(event.custom_data?.value).toBe(135);
  });
});

describe("coerceEventId", () => {
  it("passes a well-formed id through unchanged", () => {
    const id = "018f2c9e-4a1b-7c3d-9e2f-1a2b3c4d5e6f";
    expect(coerceEventId(id)).toBe(id);
  });

  it("mints a fresh id for anything unusable rather than refusing to send", () => {
    // The server Lead must land even when the client sent nothing — that is
    // the entire point of the Conversions API half.
    for (const bad of [undefined, null, 123, "short", "x".repeat(500), "a\nb", {}]) {
      const out = coerceEventId(bad);
      expect(typeof out).toBe("string");
      expect(out.length).toBeGreaterThanOrEqual(8);
    }
    expect(coerceEventId(undefined)).not.toBe(coerceEventId(undefined));
  });
});

describe("sendMetaConversion", () => {
  const saved = { ...process.env };
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    delete process.env.NEXT_PUBLIC_META_PIXEL_ID;
    delete process.env.META_CAPI_ACCESS_TOKEN;
    delete process.env.META_TEST_EVENT_CODE;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...saved };
  });

  const event = buildLeadEvent({ eventId: "abc12345", userData: {} });

  it("is a complete no-op when unconfigured, without touching fetch", async () => {
    // ⚠️ THE MOST IMPORTANT TEST HERE. This is what proves merging the branch
    // changes nothing in production until Vercel is configured.
    await expect(sendMetaConversion(event)).resolves.toEqual({
      sent: false,
      skipped: "not_configured",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("stays a no-op when only one of the two vars is set", async () => {
    process.env.NEXT_PUBLIC_META_PIXEL_ID = "123";
    const result = await sendMetaConversion(event);
    expect(result.skipped).toBe("not_configured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("RESOLVES rather than throwing when the network fails", async () => {
    // The Stripe webhook's idempotency depends on this: a throw would delete
    // its stripe_events claim and re-credit an already-credited invoice.
    process.env.NEXT_PUBLIC_META_PIXEL_ID = "123";
    process.env.META_CAPI_ACCESS_TOKEN = "tok";
    fetchSpy.mockRejectedValue(new Error("socket hang up"));
    await expect(sendMetaConversion(event)).resolves.toMatchObject({ sent: false });
  });

  it("reports a non-2xx without leaking the access token", async () => {
    process.env.NEXT_PUBLIC_META_PIXEL_ID = "123";
    process.env.META_CAPI_ACCESS_TOKEN = "SUPERSECRETTOKEN";
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"error":{"message":"Invalid parameter"}}',
    });
    const result = await sendMetaConversion(event);
    expect(result.sent).toBe(false);
    expect(result.error).toContain("meta_400");
    expect(result.error).not.toContain("SUPERSECRETTOKEN");
  });

  it("sends the token in the body and never in the URL", async () => {
    process.env.NEXT_PUBLIC_META_PIXEL_ID = "123";
    process.env.META_CAPI_ACCESS_TOKEN = "SUPERSECRETTOKEN";
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ events_received: 1 }),
    });
    await sendMetaConversion(event);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).not.toContain("SUPERSECRETTOKEN");
    expect(JSON.parse((init as { body: string }).body).access_token).toBe(
      "SUPERSECRETTOKEN"
    );
  });

  it("includes test_event_code only when it is set", async () => {
    process.env.NEXT_PUBLIC_META_PIXEL_ID = "123";
    process.env.META_CAPI_ACCESS_TOKEN = "tok";
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ events_received: 1 }),
    });

    await sendMetaConversion(event);
    expect(
      JSON.parse((fetchSpy.mock.calls[0]![1] as { body: string }).body).test_event_code
    ).toBeUndefined();

    process.env.META_TEST_EVENT_CODE = "TEST123";
    await sendMetaConversion(event);
    expect(
      JSON.parse((fetchSpy.mock.calls[1]![1] as { body: string }).body).test_event_code
    ).toBe("TEST123");
  });
});

describe("isTrackedPath", () => {
  it("tracks the public marketing pages", () => {
    for (const p of ["/", "/enquiry", "/guaranteed-rent", "/privacy-policy", "/login"]) {
      expect(isTrackedPath(p)).toBe(true);
    }
  });

  it("never tracks the dashboard or admin", () => {
    for (const p of ["/dashboard", "/dashboard/leads/abc", "/admin", "/admin/customers"]) {
      expect(isTrackedPath(p)).toBe(false);
    }
  });

  it("does not confuse a prefix for a path segment", () => {
    // A bare startsWith("/dashboard") would wrongly exclude this.
    expect(isTrackedPath("/dashboards")).toBe(true);
    expect(isTrackedPath("/administration")).toBe(true);
  });
});
