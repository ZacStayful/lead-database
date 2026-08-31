import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  shouldReferLandlord,
  landlordFirstName,
  operatorLabel,
  buildReferralCopy,
  renderReferralBody,
  type ReferralLead,
} from "@/lib/landlordReferral";
import {
  mintReferralToken,
  verifyReferralToken,
  referralTokensConfigured,
  TOKEN_TTL_MS,
} from "@/lib/landlordReferralToken";
import {
  isRetryableSendError,
  nextReferralAttemptAt,
  shouldAbandonReferral,
  retryShouldAskQuestions,
  REFERRAL_ABANDON_AFTER_MS,
  REFERRAL_RETRY_PACING_MS,
  REFERRAL_RETRY_MAX_PER_RUN,
} from "@/lib/landlordReferralSend";

const LEAD_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function lead(over: Partial<ReferralLead> = {}): ReferralLead {
  return {
    id: LEAD_ID,
    lead_name: "Sarah Hughes",
    email: "sarah@example.com",
    address: "12 Test St, Darlington DL1 1AA",
    lead_type: "management",
    owner_customer_id: null,
    lead_quality_codes: [],
    ...over,
  };
}

describe("shouldReferLandlord", () => {
  it("refers a normal management lead", () => {
    expect(shouldReferLandlord(lead())).toEqual({ refer: true });
  });

  it("skips an EMPTY-STRING email — management ingest writes '' not null", () => {
    expect(shouldReferLandlord(lead({ email: "" }))).toEqual({
      refer: false, reason: "no_email",
    });
  });

  it("skips a null email", () => {
    expect(shouldReferLandlord(lead({ email: null }))).toEqual({
      refer: false, reason: "no_email",
    });
  });

  it("skips a malformed email", () => {
    expect(shouldReferLandlord(lead({ email: "not-an-address" }))).toEqual({
      refer: false, reason: "no_email",
    });
  });

  it("skips on the email quality codes", () => {
    for (const code of ["email_missing", "email_malformed"]) {
      expect(shouldReferLandlord(lead({ lead_quality_codes: [code] }))).toEqual({
        refer: false, reason: "email_quality",
      });
    }
  });

  // The bug this exists to prevent: lead_quality_status is ONE verdict across
  // name, phone and email, so gating on it would drop a perfectly reachable
  // landlord because their phone is foreign.
  it("STILL REFERS when the quality codes are phone-only", () => {
    expect(
      shouldReferLandlord(
        lead({ lead_quality_codes: ["phone_foreign", "phone_not_uk_mobile"] })
      )
    ).toEqual({ refer: true });
  });

  it("never refers a customer-owned lead, however good the email", () => {
    expect(
      shouldReferLandlord(lead({ owner_customer_id: "cust-1" }))
    ).toEqual({ refer: false, reason: "owned_lead" });
  });

  it("refers a guaranteed rent lead too (invariant 6)", () => {
    expect(shouldReferLandlord(lead({ lead_type: "guaranteed_rent" }))).toEqual({
      refer: true,
    });
  });
});

describe("landlordFirstName", () => {
  it("takes a lone first name — 87 of 437 leads are one (§36.3)", () => {
    expect(landlordFirstName("Adam")).toBe("Adam");
  });
  it("takes the first of a full name", () => {
    expect(landlordFirstName("Sarah Hughes")).toBe("Sarah");
  });
  it("refuses a single character and a digits-only value", () => {
    expect(landlordFirstName("A")).toBeNull();
    expect(landlordFirstName("12345")).toBeNull();
  });
  it("refuses null/blank", () => {
    expect(landlordFirstName(null)).toBeNull();
    expect(landlordFirstName("   ")).toBeNull();
  });
});

describe("operatorLabel", () => {
  it("prefers the business name", () => {
    expect(operatorLabel({ business_name: "Acme Lets", contact_name: "Bob" })).toBe("Acme Lets");
  });
  it("falls back to the contact, then to a neutral phrase", () => {
    expect(operatorLabel({ contact_name: "Bob" })).toBe("Bob");
    expect(operatorLabel({})).toBe("a local operator");
  });
});

describe("buildReferralCopy", () => {
  const operator = {
    business_name: "Acme Lets",
    contact_name: "Bob Smith",
    email: "bob@acme.test",
    phone: "07700900123",
    operator_intro: "We run 40 short lets across the North East.",
  };

  it("greets by first name and names the operator", () => {
    const c = buildReferralCopy({ lead: lead(), operator, askQuestions: true });
    expect(c.greeting).toBe("Hi Sarah,");
    expect(c.intro.join(" ")).toContain("Acme Lets");
    expect(c.rows.map((r) => r.value)).toContain("bob@acme.test");
    expect(c.rows.map((r) => r.value)).toContain("07700900123");
  });

  it("falls back to a neutral greeting with no usable name", () => {
    const c = buildReferralCopy({ lead: lead({ lead_name: "" }), operator, askQuestions: false });
    expect(c.greeting).toBe("Hello,");
  });

  it("offers the CTA only on the first introduction", () => {
    expect(buildReferralCopy({ lead: lead(), operator, askQuestions: true }).cta).not.toBeNull();
    expect(buildReferralCopy({ lead: lead(), operator, askQuestions: false }).cta).toBeNull();
  });

  // Invariant 6: a GR operator pays a fixed rent, they do not manage for a fee.
  it("uses guaranteed-rent wording for a GR lead and management wording otherwise", () => {
    const gr = buildReferralCopy({
      lead: lead({ lead_type: "guaranteed_rent" }), operator, askQuestions: false,
    });
    expect(gr.intro.join(" ")).toContain("guaranteed rent");
    expect(gr.intro.join(" ")).not.toContain("management company");

    const mgmt = buildReferralCopy({ lead: lead(), operator, askQuestions: false });
    expect(mgmt.intro.join(" ")).toContain("management company");
    expect(mgmt.intro.join(" ")).not.toContain("guaranteed rent");
  });

  // No fee, no percentage, no projected income — the report's fee is Stayful's
  // and the operator's is unknown here.
  it("quotes no money, no percentage and no figure", () => {
    const c = buildReferralCopy({
      lead: lead({ gross_annual_income: 36112 }), operator, askQuestions: true,
    });
    const all = [c.subject, c.greeting, ...c.intro, c.cta?.note ?? ""].join(" ");
    expect(all).not.toMatch(/£|\d+\s*%|\bfee\b|commission/i);
    expect(all).not.toContain("36112");
  });
});

describe("renderReferralBody escaping", () => {
  it("escapes an operator intro containing markup, quotes and ampersands", () => {
    const copy = buildReferralCopy({
      lead: lead(),
      operator: {
        business_name: 'Acme & Sons <script>alert("x")</script>',
        contact_name: "Bob",
        email: "bob@acme.test",
        phone: "07700900123",
        operator_intro: '<img src=x onerror="alert(1)"> Tom & "Jerry"',
      },
      askQuestions: false,
    });
    const html = renderReferralBody(copy);

    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x");
    expect(html).toContain("&amp;");
  });

  it("renders nothing for the intro block when the operator has not written one", () => {
    const copy = buildReferralCopy({
      lead: lead(),
      operator: { business_name: "Acme Lets", operator_intro: null },
      askQuestions: false,
    });
    expect(renderReferralBody(copy)).not.toContain("In their words");
  });
});

describe("referral token", () => {
  const OLD = process.env.MESSAGING_TOKEN_SECRET;
  beforeEach(() => { process.env.MESSAGING_TOKEN_SECRET = "test-secret-value"; });
  afterEach(() => {
    if (OLD === undefined) delete process.env.MESSAGING_TOKEN_SECRET;
    else process.env.MESSAGING_TOKEN_SECRET = OLD;
  });

  it("round-trips the lead id", () => {
    const t = mintReferralToken(LEAD_ID)!;
    expect(t).toBeTruthy();
    expect(verifyReferralToken(t)).toBe(LEAD_ID);
  });

  it("refuses a forged MAC", () => {
    const t = mintReferralToken(LEAD_ID)!;
    const forged = t.slice(0, -1) + (t.endsWith("a") ? "b" : "a");
    expect(verifyReferralToken(forged)).toBeNull();
  });

  it("refuses a truncated or malformed token", () => {
    const t = mintReferralToken(LEAD_ID)!;
    expect(verifyReferralToken(t.slice(0, 20))).toBeNull();
    expect(verifyReferralToken("")).toBeNull();
    expect(verifyReferralToken("not-a-token")).toBeNull();
  });

  it("refuses an expired token", () => {
    const t = mintReferralToken(LEAD_ID, Date.now() - TOKEN_TTL_MS - 10_000)!;
    expect(verifyReferralToken(t)).toBeNull();
  });

  it("accepts one that has not quite expired", () => {
    const t = mintReferralToken(LEAD_ID, Date.now() - TOKEN_TTL_MS + 600_000)!;
    expect(verifyReferralToken(t)).toBe(LEAD_ID);
  });

  // The domain-separation guarantee: MESSAGING_TOKEN_SECRET also signs thread
  // reply addresses, and a token minted for one purpose must not verify here.
  it("does not verify a MAC built without the purpose prefix", () => {
    const { createHmac } = require("node:crypto") as typeof import("node:crypto");
    const handle = LEAD_ID.replace(/-/g, "");
    const expiry = Math.floor((Date.now() + TOKEN_TTL_MS) / 1000).toString(36);
    const undomained = createHmac("sha256", "test-secret-value")
      .update(`${LEAD_ID}:${expiry}`)
      .digest("hex")
      .slice(0, 16);
    expect(verifyReferralToken(`${handle}z${expiry}z${undomained}`)).toBeNull();
  });

  it("mints nothing when no secret is configured, so no broken link is sent", () => {
    delete process.env.MESSAGING_TOKEN_SECRET;
    expect(referralTokensConfigured()).toBe(false);
    expect(mintReferralToken(LEAD_ID)).toBeNull();
    expect(verifyReferralToken("anything")).toBeNull();
  });
});

describe("send failure classification", () => {
  // Retryable KEEPS the claim; permanent RELEASES it. Backwards, this either
  // burns the one chance to ask the questions or asks the landlord twice.
  it("treats 429 and 5xx as retryable", () => {
    expect(isRetryableSendError({ statusCode: 429 })).toBe(true);
    expect(isRetryableSendError({ statusCode: 500 })).toBe(true);
    expect(isRetryableSendError({ statusCode: 503 })).toBe(true);
  });

  it("treats a rejected address (4xx, not 429) as permanent", () => {
    expect(isRetryableSendError({ statusCode: 422 })).toBe(false);
    expect(isRetryableSendError({ statusCode: 400 })).toBe(false);
  });

  it("treats a timeout or unknown error as retryable", () => {
    expect(isRetryableSendError(new Error("timeout"))).toBe(true);
    expect(isRetryableSendError({ message: "socket hang up" })).toBe(true);
  });

  it("reports no error as not retryable", () => {
    expect(isRetryableSendError(null)).toBe(false);
    expect(isRetryableSendError(undefined)).toBe(false);
  });

  it("backs off 1m, 5m, 15m, 1h and then holds", () => {
    const t0 = 1_000_000;
    const at = (n: number) => nextReferralAttemptAt(n, t0).getTime() - t0;
    expect(at(1)).toBe(60_000);
    expect(at(2)).toBe(300_000);
    expect(at(3)).toBe(900_000);
    expect(at(4)).toBe(3_600_000);
    expect(at(9)).toBe(3_600_000);
  });
});

describe("the retry sweep", () => {
  const NOW = 1_800_000_000_000;
  const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

  it("keeps retrying inside the 24h window and stops after it", () => {
    expect(shouldAbandonReferral(iso(60_000), NOW)).toBe(false);
    expect(shouldAbandonReferral(iso(REFERRAL_ABANDON_AFTER_MS - 1000), NOW)).toBe(false);
    expect(shouldAbandonReferral(iso(REFERRAL_ABANDON_AFTER_MS + 1000), NOW)).toBe(true);
  });

  // An unknown or unparseable claim time is not evidence the claim is old, and
  // treating it as such would silently abandon a referral on its first retry.
  it("never abandons on a missing or unparseable claim time", () => {
    expect(shouldAbandonReferral(null, NOW)).toBe(false);
    expect(shouldAbandonReferral(undefined, NOW)).toBe(false);
    expect(shouldAbandonReferral("not-a-date", NOW)).toBe(false);
  });

  it("asks the questions on retry only when nobody has actually been sent one", () => {
    // holds the first-flag and no sibling delivered → this retry asks
    expect(retryShouldAskQuestions("2026-08-30T09:00:00Z", true)).toBe(true);
    // a sibling already delivered → stay quiet rather than risk a double-ask
    expect(retryShouldAskQuestions("2026-08-30T09:00:00Z", false)).toBe(false);
    // never held the flag → was never the one asking
    expect(retryShouldAskQuestions(null, true)).toBe(false);
    expect(retryShouldAskQuestions(undefined, false)).toBe(false);
  });

  // This sweep exists BECAUSE of Resend's 2/second limit, so it must not
  // reproduce it. 600ms is the pace the announcement sender uses (§21.3).
  it("paces slower than Resend's documented 2 per second", () => {
    expect(REFERRAL_RETRY_PACING_MS).toBeGreaterThanOrEqual(500);
    expect(1000 / REFERRAL_RETRY_PACING_MS).toBeLessThanOrEqual(2);
  });

  // The whole batch must fit the phase's share of a 45s wall clock with the
  // three phases ahead of it already served.
  it("bounds a run to something the shared wall clock can absorb", () => {
    expect(REFERRAL_RETRY_MAX_PER_RUN).toBeLessThanOrEqual(30);
    expect(REFERRAL_RETRY_MAX_PER_RUN * REFERRAL_RETRY_PACING_MS).toBeLessThanOrEqual(45_000);
  });

  it("gives up after a day, not after two", () => {
    expect(REFERRAL_ABANDON_AFTER_MS).toBe(24 * 60 * 60 * 1000);
  });
});
