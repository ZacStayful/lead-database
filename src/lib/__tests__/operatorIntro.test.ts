import { describe, it, expect } from "vitest";
import {
  validateOperatorIntro,
  MAX_INTRO_CHARS,
  MIN_INTRO_CHARS,
} from "@/lib/operatorIntro";
import { buildDraftContext, renderDraftPrompt } from "@/lib/messaging/draftContext";
import { validateDraft } from "@/lib/messaging/validateDraft";
import { buildReferralCopy, renderReferralBody } from "@/lib/landlordReferral";

const GOOD = "We look after short lets across the North East and have been doing it for six years.";

describe("validateOperatorIntro", () => {
  it("accepts a normal introduction and normalises whitespace", () => {
    const v = validateOperatorIntro("  We   look after\t short lets across the North East.  ");
    expect(v.ok && v.value).toBe("We look after short lets across the North East.");
  });

  it("treats empty and null as clearing it, not as an error", () => {
    expect(validateOperatorIntro("")).toEqual({ ok: true, value: null });
    expect(validateOperatorIntro("   ")).toEqual({ ok: true, value: null });
    expect(validateOperatorIntro(null)).toEqual({ ok: true, value: null });
  });

  it("refuses something too short to tell a landlord anything", () => {
    const v = validateOperatorIntro("We are good.");
    expect(v.ok).toBe(false);
    expect(!v.ok && v.reason).toBe("too_short");
  });

  it("refuses a brochure", () => {
    const v = validateOperatorIntro("a".repeat(MAX_INTRO_CHARS + 1));
    expect(!v.ok && v.reason).toBe("too_long");
  });

  it("accepts exactly at both bounds", () => {
    expect(validateOperatorIntro("b".repeat(MIN_INTRO_CHARS)).ok).toBe(true);
    expect(validateOperatorIntro("b".repeat(MAX_INTRO_CHARS)).ok).toBe(true);
  });

  // The rule that is not editorial: this text feeds the drafter, and
  // validateDraft rejects any generated message quoting a fee. An intro
  // carrying one would silently break every draft after the fact.
  it("refuses pricing, in all the shapes PRICE_RE knows", () => {
    for (const bad of [
      "We charge a fee of 12% and look after everything for you.",
      "Our commission is competitive across the North East region.",
      "We take a small percentage of what the property earns each month.",
      "Ask us for our rate card and we will send it over to you today.",
    ]) {
      const v = validateOperatorIntro(bad);
      expect(v.ok, bad).toBe(false);
      expect(!v.ok && v.reason).toBe("mentions_price");
    }
  });

  // ⚠️ REGRESSION. PRICE_RE listed `percent` with a trailing \b, which does not
  // match "percentage" — so "we take a percentage of what the property earns"
  // passed the DRAFTER's price check too and could reach a landlord's WhatsApp
  // as an unbounded price claim. Found here because this validator reuses
  // PRICE_RE rather than copying it; a second copy would still carry the gap.
  it("catches 'percentage', which the original pattern let through", () => {
    const v = validateOperatorIntro("We take a percentage of what the property earns each month.");
    expect(!v.ok && v.reason).toBe("mentions_price");
  });

  it("names the alternative when it refuses pricing", () => {
    const v = validateOperatorIntro("We charge a fee of 12% for full management of your property.");
    expect(!v.ok && v.message).toMatch(/presentation settings/i);
  });

  it("refuses links, and points at the booking link instead", () => {
    const v = validateOperatorIntro(
      "We look after short lets across the region. See acmelets.co.uk for more."
    );
    expect(!v.ok && v.reason).toBe("contains_link");
    expect(!v.ok && v.message).toMatch(/booking link/i);
  });

  it("refuses a non-string", () => {
    expect(validateOperatorIntro(42).ok).toBe(false);
    expect(validateOperatorIntro({}).ok).toBe(false);
  });
});

describe("the intro reaching the drafter", () => {
  // ⚠️ Asserted against the RENDERED PROMPT, not the context object. The object
  // being clean is not the same claim as the prompt being clean, and the seam
  // between the two is exactly where §25's report bug lived.
  it("appears in the prompt, fenced as background", () => {
    const ctx = buildDraftContext({
      lead: { lead_name: "Sarah Hughes", address: "12 Test St", bedrooms: "3" },
      customer: { business_name: "Acme Lets", contact_name: "Bob", operator_intro: GOOD },
    });
    const prompt = renderDraftPrompt(ctx);
    expect(prompt).toContain(GOOD);
    expect(prompt).toMatch(/ABOUT THE OPERATOR \(background only/);
    expect(prompt).toMatch(/never quote this and never mention money/);
  });

  it("is absent entirely when the operator has not written one", () => {
    const ctx = buildDraftContext({
      lead: { lead_name: "Sarah", address: "12 Test St" },
      customer: { business_name: "Acme Lets", contact_name: "Bob" },
    });
    expect(ctx.operator.intro).toBeNull();
    expect(renderDraftPrompt(ctx)).not.toContain("ABOUT THE OPERATOR");
  });

  // The whole reason pricing is refused at save time: prove a draft quoting one
  // really would be rejected, so the save-time rule is doing real work.
  // The same gap, on the path that actually matters: a generated message.
  it("validateDraft now rejects 'percentage' in a generated message", () => {
    const ctx = buildDraftContext({
      lead: { lead_name: "Sarah", address: "12 Test St" },
      customer: { business_name: "Acme Lets", contact_name: "Bob" },
    });
    const v = validateDraft(
      { message: "Hi Sarah, we take a percentage of what your place earns. Worth a chat?" },
      ctx
    );
    expect(v.ok).toBe(false);
  });

  it("a draft that DID quote a fee is still rejected by validateDraft", () => {
    const ctx = buildDraftContext({
      lead: { lead_name: "Sarah", address: "12 Test St" },
      customer: { business_name: "Acme Lets", contact_name: "Bob", operator_intro: GOOD },
    });
    const v = validateDraft(
      { message: "Hi Sarah, we look after short lets and our fee is very competitive." },
      ctx
    );
    expect(v.ok).toBe(false);
  });
});

describe("the intro reaching the landlord email", () => {
  it("renders under its own heading, escaped", () => {
    const copy = buildReferralCopy({
      lead: { id: "l1", lead_type: "management", email: "a@b.co", address: "12 Test St" },
      operator: {
        business_name: "Acme Lets",
        contact_name: "Bob",
        operator_intro: 'We look after short lets & we <love> it here in the North East.',
      },
      askQuestions: false,
    });
    const html = renderReferralBody(copy);
    expect(html).toContain("In their words");
    expect(html).toContain("&amp;");
    expect(html).toContain("&lt;love&gt;");
    expect(html).not.toContain("<love>");
  });
});
