/**
 * Step-aware drafting: the prompt shape, and the one validator rule that moves.
 *
 * ⚠️ ASSERTED AGAINST THE RENDERED STRING, not the context object, because
 * draftContext.ts says to: "the object being clean is not the same claim as the
 * prompt being clean, and the seam between the two is exactly where §25's report
 * bug lived."
 *
 * The failure this file exists to catch is quiet rather than loud. Using the
 * opener for step 3 produces a perfectly valid message that reintroduces the
 * operator to somebody they have already messaged twice — which reads as an
 * automated blast, which is the one thing this whole feature must not look like.
 */
import { describe, it, expect } from "vitest";
import {
  buildDraftContext,
  renderDraftPrompt,
  type DraftStepContext,
} from "../draftContext";
import { validateDraft } from "../validateDraft";
import { promptVersionFor, PROMPT_VERSION, FOLLOWUP_PROMPT_VERSION } from "../draftMessage";

const CUSTOMER = { business_name: "Northside Lets", contact_name: "Mark Henderson" };

const LEAD = {
  lead_name: "Sarah Whitfield",
  address: "88 Bourneside Road, Bristol",
  bedrooms: "3",
  lead_profile: null,
  gross_annual_income: null,
  avg_nightly_rate: null,
  occupancy_rate: null,
};

const STEP: DraftStepContext = {
  number: 3,
  brief: "Ask if they have had other quotes",
  previous: [
    { text: "Hi Sarah, saw your enquiry about Bourneside Road...", daysAgo: 8 },
    { text: "Morning Sarah, any thoughts on the Bristol flat?", daysAgo: 3 },
  ],
};

describe("the step block reaches the prompt", () => {
  const prompt = renderDraftPrompt(
    buildDraftContext({ lead: LEAD, customer: CUSTOMER, step: STEP })
  );

  it("says plainly that this is a follow-up, not an opener", () => {
    expect(prompt).toMatch(/FOLLOW-UP/);
    expect(prompt).toMatch(/have already been messaged/i);
  });

  it("shows what has already been sent, so the model does not repeat it", () => {
    expect(prompt).toContain("saw your enquiry about Bourneside Road");
    expect(prompt).toContain("any thoughts on the Bristol flat");
    expect(prompt).toMatch(/do not repeat/i);
  });

  it("dates each previous message, so 'three days ago' is available to it", () => {
    expect(prompt).toContain("8 days ago:");
    expect(prompt).toContain("3 days ago:");
  });

  it("passes the operator's own brief through", () => {
    expect(prompt).toContain("Ask if they have had other quotes");
  });
});

describe("a first message carries none of it", () => {
  const prompt = renderDraftPrompt(buildDraftContext({ lead: LEAD, customer: CUSTOMER }));

  it("has no step block at all", () => {
    expect(prompt).not.toMatch(/FOLLOW-UP/);
    expect(prompt).not.toMatch(/ALREADY SENT/);
  });

  it("is byte-identical to passing step: null", () => {
    const explicit = renderDraftPrompt(
      buildDraftContext({ lead: LEAD, customer: CUSTOMER, step: null })
    );
    expect(explicit).toBe(prompt);
  });
});

describe("prompt version is per shape", () => {
  it("separates the opener from the follow-up", () => {
    const first = buildDraftContext({ lead: LEAD, customer: CUSTOMER });
    const later = buildDraftContext({ lead: LEAD, customer: CUSTOMER, step: STEP });
    expect(promptVersionFor(first)).toBe(PROMPT_VERSION);
    expect(promptVersionFor(later)).toBe(FOLLOWUP_PROMPT_VERSION);
    // If these ever collapse into one value, "does chasing work" stops being a
    // question the data can answer.
    expect(PROMPT_VERSION).not.toBe(FOLLOWUP_PROMPT_VERSION);
  });
});

describe("validateDraft relaxes the name rule for follow-ups, and NOTHING else", () => {
  const first = buildDraftContext({ lead: LEAD, customer: CUSTOMER });
  const later = buildDraftContext({ lead: LEAD, customer: CUSTOMER, step: STEP });

  it("still refuses a first message that never says the landlord's name", () => {
    const v = validateDraft("Any thoughts on this one?", first);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("missing_landlord_name");
  });

  it("ACCEPTS the same text as a fourth chase", () => {
    // Shoehorning the name into every message is the repetitive, obviously
    // automated pattern the follow-up prompt exists to avoid.
    expect(validateDraft("Any thoughts on this one?", later).ok).toBe(true);
  });

  it("still refuses a link on a follow-up", () => {
    const v = validateDraft("Any thoughts? www.northsidelets.com", later);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("contains_link");
  });

  it("still refuses pricing on a follow-up", () => {
    const v = validateDraft("Happy to waive our fee this month.", later);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("mentions_price");
  });

  it("still refuses a figure nobody supplied on a follow-up", () => {
    const v = validateDraft("Places like yours clear £70,000 a year.", later);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("figure_when_none_supplied");
  });

  it("still refuses an over-long follow-up", () => {
    const v = validateDraft("x".repeat(481), later);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("too_long");
  });
});
