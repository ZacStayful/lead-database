/**
 * The draft pipeline, tested where it can be wrong silently.
 *
 * Two things are asserted against the RENDERED PROMPT rather than the context
 * object, deliberately. The object being clean is a different claim from the
 * prompt being clean, and §25's zero-byte-PDF bug lived in exactly that seam:
 * both pieces were well tested and the join between them was not.
 */
import { describe, it, expect } from "vitest";
import {
  firstNameOf,
  buildDraftContext,
  renderDraftPrompt,
  type DraftContext,
} from "../draftContext";
import { validateDraft } from "../validateDraft";
import { TIMELINES_SIGNUP_URL, TIMELINES_SETUP_VIDEO_URL } from "../timelines";

const CUSTOMER = { business_name: "Northside Lets", contact_name: "Mark Henderson" };

/** A lead with a full analysis behind it — half the live book (15 of 30). */
const ANALYSED = {
  lead_name: "Sarah Whitfield",
  address: "88 Bourneside Road, Bristol",
  bedrooms: "3",
  lead_profile: "Landlord of two properties, wants a hands-off arrangement.",
  gross_annual_income: 83260,
  avg_nightly_rate: 157,
  occupancy_rate: 63,
};

/** The other half: a name, an address, a bedroom count and nothing else. */
const UNANALYSED = {
  lead_name: "Sarah Whitfield",
  address: "88 Bourneside Road, Bristol",
  bedrooms: "3",
  lead_profile: null,
  gross_annual_income: null,
  avg_nightly_rate: null,
  occupancy_rate: null,
};

describe("firstNameOf", () => {
  it("takes the first word and nothing else", () => {
    expect(firstNameOf("Mark Henderson")).toBe("Mark");
    expect(firstNameOf("  sarah  whitfield ")).toBe("sarah");
  });

  it("returns null rather than guessing at junk", () => {
    // §36 already establishes that a lone first name is the NORM, so a single
    // word is fine — what must never reach a WhatsApp is an email address or a
    // one-letter initial being greeted by name.
    expect(firstNameOf("Josh")).toBe("Josh");
    expect(firstNameOf("a")).toBeNull();
    expect(firstNameOf("")).toBeNull();
    expect(firstNameOf(null)).toBeNull();
    expect(firstNameOf("07700 900123")).toBeNull();
  });
});

describe("buildDraftContext: absent is null, and null is omitted", () => {
  it("carries the figures a lead actually has", () => {
    const ctx = buildDraftContext({ lead: ANALYSED, customer: CUSTOMER });
    expect(ctx.figures).toEqual({
      grossAnnual: 83260,
      nightlyRate: 157,
      occupancyPct: 63,
    });
  });

  /**
   * ⚠️ THE REGRESSION THAT MATTERS. The obvious implementation reuses
   * buildPresentationSeed, whose contract is that the seed must be COMPLETE —
   * so it substitutes TOOL_INCOME_DEFAULTS (gross £60,000, £185 a night, 60%)
   * for anything the analysis did not state. That is right for a form and
   * catastrophic here: the model would tell the landlord their property grosses
   * £60,000 on the strength of a placeholder.
   */
  it("returns NO figures for an unanalysed lead — never a default", () => {
    const ctx = buildDraftContext({ lead: UNANALYSED, customer: CUSTOMER });
    expect(ctx.figures).toBeNull();

    const prompt = renderDraftPrompt(ctx);
    expect(prompt).not.toMatch(/60,?000/);
    expect(prompt).not.toMatch(/185/);
    expect(prompt).toMatch(/FIGURES: none/);
    // No £ or % anywhere at all, so there is nothing to reach for.
    expect(prompt).not.toContain("£");
    expect(prompt).not.toContain("%");
  });

  it("treats a null figure as absent, not as zero", () => {
    // Number(null) === 0, which is the trap numOrNull exists for — a lead with
    // no occupancy must not be described as 0% occupied.
    const ctx = buildDraftContext({
      lead: { ...ANALYSED, occupancy_rate: null },
      customer: CUSTOMER,
    });
    expect(ctx.figures?.occupancyPct).toBeNull();
    expect(renderDraftPrompt(ctx)).not.toMatch(/occupancy: 0%/);
  });
});

describe("renderDraftPrompt: the exclusion list", () => {
  const ctx = buildDraftContext({ lead: ANALYSED, customer: CUSTOMER });
  const prompt = renderDraftPrompt(ctx);

  it("includes what the operator needs", () => {
    expect(prompt).toContain("Sarah");
    expect(prompt).toContain("88 Bourneside Road");
    expect(prompt).toContain("3 bed");
    expect(prompt).toContain("£83,260");
    expect(prompt).toContain("£157");
    expect(prompt).toContain("63%");
  });

  /**
   * The seed builder computes a management fee and a net figure, and BOTH are
   * wrong here for different reasons: leads.net_annual_income is net of
   * STAYFUL'S 15%, which is not the operator's fee at all (§26.1), and the
   * operator's own fee has a basis of net or gross that changes the number
   * materially. A first message settles it by containing no pricing.
   */
  it("never mentions a fee, a net figure or a commission", () => {
    expect(prompt).not.toMatch(/\bfee\b/i);
    expect(prompt).not.toMatch(/\bnet\b/i);
    expect(prompt).not.toMatch(/commission/i);
    expect(prompt).not.toMatch(/\b15\s?%/);
  });

  it("frames the profile as background that must not be quoted", () => {
    // §32.8: on an imported lead this column is the uploader's own working
    // material. The route scopes it; the prompt fences it.
    expect(prompt).toMatch(/BACKGROUND \(context only/);
  });
});

describe("validateDraft rejects rather than repairs", () => {
  const withFigures = buildDraftContext({ lead: ANALYSED, customer: CUSTOMER });
  const noFigures = buildDraftContext({ lead: UNANALYSED, customer: CUSTOMER });

  it("accepts a short, specific, question-ending message", () => {
    const v = validateDraft(
      "Hi Sarah, I saw your 3-bed on Bourneside Road. Short lets around there are running at about £157 a night at 63% occupancy, which works out near £83,260 a year. Would you be open to a quick chat about it?",
      withFigures
    );
    expect(v.ok).toBe(true);
  });

  it("accepts a figure-free message for an unanalysed lead", () => {
    const v = validateDraft(
      "Hi Sarah, I noticed your 3-bed on Bourneside Road. Would you be open to a quick chat about how it might do on short lets?",
      noFigures
    );
    expect(v.ok).toBe(true);
  });

  it("refuses ANY figure when none was supplied", () => {
    const v = validateDraft(
      "Hi Sarah, your Bourneside Road place could bring in £60,000 a year. Interested?",
      noFigures
    );
    expect(v).toEqual({ ok: false, reason: "figure_when_none_supplied" });
  });

  it("refuses a figure that is not one of ours", () => {
    const v = validateDraft(
      "Hi Sarah, your 3-bed on Bourneside Road should do about £140,000 a year. Worth a chat?",
      withFigures
    );
    expect(v).toEqual({ ok: false, reason: "figure_not_supplied" });
  });

  it("allows honest rounding of a figure we did supply", () => {
    const v = validateDraft(
      "Hi Sarah, your 3-bed on Bourneside Road looks like about £83,000 a year on short lets. Worth a chat?",
      withFigures
    );
    expect(v.ok).toBe(true);
  });

  it("refuses pricing language, including a promise of no fee", () => {
    expect(
      validateDraft(
        "Hi Sarah, we manage Bourneside Road for a 12% fee. Interested?",
        withFigures
      )
    ).toEqual({ ok: false, reason: "mentions_price" });

    expect(
      validateDraft(
        "Hi Sarah, no commission for the first month on Bourneside Road. Interested?",
        withFigures
      )
    ).toEqual({ ok: false, reason: "mentions_price" });
  });

  it("refuses a link — the strongest spam signal in a cold WhatsApp", () => {
    expect(
      validateDraft(
        "Hi Sarah, have a look at northsidelets.co.uk about Bourneside Road.",
        withFigures
      )
    ).toEqual({ ok: false, reason: "contains_link" });

    expect(
      validateDraft("Hi Sarah, see https://example.com for Bourneside Road.", withFigures)
    ).toEqual({ ok: false, reason: "contains_link" });
  });

  it("refuses a message that never uses the landlord's name", () => {
    const v = validateDraft(
      "Hello, I noticed your 3-bed on Bourneside Road. Worth a chat?",
      withFigures
    );
    expect(v).toEqual({ ok: false, reason: "missing_landlord_name" });
  });

  it("refuses an essay", () => {
    expect(validateDraft("Hi Sarah. ".repeat(80), withFigures).ok).toBe(false);
  });

  it("refuses a non-string and an empty string without throwing", () => {
    expect(validateDraft(null, withFigures)).toEqual({ ok: false, reason: "empty" });
    expect(validateDraft("   ", withFigures)).toEqual({ ok: false, reason: "empty" });
  });

  it("does not mistake a bedroom count or a time for a figure", () => {
    const ctx: DraftContext = noFigures;
    const v = validateDraft(
      "Hi Sarah, is the 3 bed on Bourneside Road still empty? Happy to call any time before 6 today.",
      ctx
    );
    expect(v.ok).toBe(true);
  });
});

/**
 * ⚠️ The referral code is revenue nothing would alert us to losing. Same
 * discipline featureRequest.ts applies to its own path (§21.8).
 */
describe("outbound links", () => {
  it("keeps the TimelinesAI referral code", () => {
    expect(TIMELINES_SIGNUP_URL).toContain("refby=5adca00be2612e9c");
    expect(new URL(TIMELINES_SIGNUP_URL).searchParams.get("refby")).toBe(
      "5adca00be2612e9c"
    );
  });

  it("points the setup video at a shareable Drive view URL", () => {
    expect(TIMELINES_SETUP_VIDEO_URL).toMatch(
      /^https:\/\/drive\.google\.com\/file\/d\/[\w-]+\/view$/
    );
    // ?usp=sharing is share-dialog noise and must not creep back in.
    expect(TIMELINES_SETUP_VIDEO_URL).not.toContain("usp=");
  });
});
