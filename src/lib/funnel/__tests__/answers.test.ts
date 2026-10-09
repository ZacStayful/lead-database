/**
 * The funnel's saved answers (batch 02 Phase 3).
 *
 * WHAT BREAKS IF THESE FAIL
 * -------------------------
 * Resume is the promise that a visitor who closes the tab comes back to the
 * question they stopped on. Reading "Anywhere" (a null) as "not answered"
 * asks them again; reading an absent answer as answered skips a question.
 * The patch parser is the only thing between a browser and the session row,
 * and the postcode lock is what keeps the answers agreeing with the preview
 * beside them.
 */
import { describe, expect, it } from "vitest";
import {
  answerSummary,
  answersLockRefuses,
  mergeAnswers,
  parseAnswersPatch,
  readStoredAnswers,
  resumeScreen,
  validDiscount,
} from "@/lib/funnel/answers";

describe("readStoredAnswers", () => {
  it("keeps a null as an answer and an absent key as unanswered", () => {
    const d = readStoredAnswers({ basePostcode: "YO10 5DD", travelLimitMiles: null, minBedrooms: null });
    expect("travelLimitMiles" in d).toBe(true);
    expect(d.travelLimitMiles).toBeNull();
    expect(d.minBedrooms).toBeNull();
    expect("minGross" in d).toBe(false);
  });

  it("drops a field of the wrong shape rather than failing", () => {
    const d = readStoredAnswers({
      basePostcode: 42,
      travelLimitMiles: 30,
      minBedrooms: 9,
      minGross: 45000,
      priorityOutcodes: "LS6",
    });
    expect(d).toEqual({});
  });

  it("reads the preview route's normalised shape too", () => {
    const d = readStoredAnswers({
      basePostcode: "YO10 5DD",
      priorityOutcodes: ["LS1"],
      travelLimitMiles: 25,
      minBedrooms: 4,
      minGross: 40000,
      similarAreas: ["HG"],
    });
    expect(d).toEqual({
      basePostcode: "YO10 5DD",
      priorityOutcodes: ["LS1"],
      travelLimitMiles: 25,
      minBedrooms: 4,
      minGross: 40000,
      similarAreas: ["HG"],
    });
  });

  it("is safe on anything that is not an object", () => {
    for (const raw of [null, undefined, "x", 7, ["a"]]) expect(readStoredAnswers(raw)).toEqual({});
  });
});

describe("parseAnswersPatch", () => {
  it("takes the named fields and nothing else", () => {
    const r = parseAnswersPatch({
      basePostcode: " yo105dd ",
      travelLimitMiles: 50,
      step: "paid",
      customer_id: "x",
      preview_snapshot: {},
    });
    expect(r).toEqual({
      ok: true,
      value: { answers: { basePostcode: "yo105dd", travelLimitMiles: 50 }, plan: null, questionsDone: false },
    });
  });

  it("an absent field is left alone; a null is an answer", () => {
    const r = parseAnswersPatch({ minBedrooms: null, minGross: null, questionsDone: true });
    expect(r.ok && r.value.answers).toEqual({ minBedrooms: null, minGross: null });
    expect(r.ok && r.value.questionsDone).toBe(true);
    const travel = parseAnswersPatch({ travelLimitMiles: null });
    expect(travel.ok && "travelLimitMiles" in travel.value.answers).toBe(true);
  });

  it("refuses a field of the wrong shape, naming it", () => {
    expect(parseAnswersPatch({ travelLimitMiles: 30 })).toEqual({ ok: false, field: "travelLimitMiles" });
    expect(parseAnswersPatch({ minBedrooms: 0 })).toEqual({ ok: false, field: "minBedrooms" });
    expect(parseAnswersPatch({ minBedrooms: 6 })).toEqual({ ok: false, field: "minBedrooms" });
    expect(parseAnswersPatch({ minBedrooms: 2.5 })).toEqual({ ok: false, field: "minBedrooms" });
    expect(parseAnswersPatch({ minGross: 45000 })).toEqual({ ok: false, field: "minGross" });
    expect(parseAnswersPatch({ basePostcode: "" })).toEqual({ ok: false, field: "basePostcode" });
    expect(parseAnswersPatch({ basePostcode: "x".repeat(17) })).toEqual({ ok: false, field: "basePostcode" });
    expect(parseAnswersPatch({ priorityOutcodes: [7] })).toEqual({ ok: false, field: "priorityOutcodes" });
    expect(parseAnswersPatch({ priorityOutcodes: Array(11).fill("LS6") })).toEqual({
      ok: false,
      field: "priorityOutcodes",
    });
    expect(parseAnswersPatch({ plan: 15 })).toEqual({ ok: false, field: "plan" });
    expect(parseAnswersPatch({ questionsDone: "yes" })).toEqual({ ok: false, field: "questionsDone" });
  });

  it("takes a plan of 10 or 20", () => {
    const r = parseAnswersPatch({ plan: 20 });
    expect(r.ok && r.value.plan).toBe(20);
  });

  it("every value the questions offer is accepted", () => {
    for (const t of [10, 25, 50, null]) expect(parseAnswersPatch({ travelLimitMiles: t }).ok).toBe(true);
    for (const b of [null, 1, 2, 3, 4, 5]) expect(parseAnswersPatch({ minBedrooms: b }).ok).toBe(true);
    for (const g of [null, 25000, 30000, 40000, 50000, 75000]) expect(parseAnswersPatch({ minGross: g }).ok).toBe(true);
  });

  it("an empty extra area is dropped, not refused", () => {
    const r = parseAnswersPatch({ priorityOutcodes: ["LS6", "  "] });
    expect(r.ok && r.value.answers.priorityOutcodes).toEqual(["LS6"]);
  });
});

describe("mergeAnswers", () => {
  it("lays the patch over the stored answers, field by field", () => {
    expect(mergeAnswers({ basePostcode: "YO10 5DD", travelLimitMiles: 25 }, { travelLimitMiles: null })).toEqual({
      basePostcode: "YO10 5DD",
      travelLimitMiles: null,
    });
  });
});

describe("answersLockRefuses", () => {
  it("nothing is locked before the first preview", () => {
    expect(answersLockRefuses(null, "LS1 4AP")).toBe(false);
  });

  it("a save naming no postcode is never refused", () => {
    expect(answersLockRefuses("YO10 5DD", undefined)).toBe(false);
  });

  it("the locked postcode in any spacing or case is allowed; another is refused", () => {
    expect(answersLockRefuses("YO10 5DD", "yo105dd")).toBe(false);
    expect(answersLockRefuses("YO10 5DD", " YO10  5DD ")).toBe(false);
    expect(answersLockRefuses("YO10 5DD", "LS1 4AP")).toBe(true);
    expect(answersLockRefuses("YO10 5DD", "YO10")).toBe(true);
    expect(answersLockRefuses("YO10 5DD", "not a postcode")).toBe(true);
  });
});

describe("resumeScreen", () => {
  it("a fresh link starts at the first question", () => {
    expect(resumeScreen({ draft: {}, step: "started", hasPreview: false })).toBe("q1");
  });

  it("resumes at the first question not yet answered", () => {
    expect(resumeScreen({ draft: { basePostcode: "YO10 5DD" }, step: "started", hasPreview: false })).toBe("q2");
    expect(
      resumeScreen({ draft: { basePostcode: "YO10 5DD", travelLimitMiles: null }, step: "started", hasPreview: false })
    ).toBe("q3");
  });

  it("'Anywhere' counts as answered", () => {
    expect(
      resumeScreen({ draft: { basePostcode: "YO10 5DD", travelLimitMiles: null }, step: "questions_done", hasPreview: false })
    ).toBe("q3");
  });

  it("returns to the preview once there is one, and to the plan once checkout started", () => {
    const draft = { basePostcode: "YO10 5DD", travelLimitMiles: 25 as const };
    expect(resumeScreen({ draft, step: "previewed", hasPreview: true })).toBe("preview");
    expect(resumeScreen({ draft, step: "checkout_started", hasPreview: true })).toBe("plan");
  });

  it("never resumes on a preview it cannot show", () => {
    const draft = { basePostcode: "YO10 5DD", travelLimitMiles: 25 as const };
    expect(resumeScreen({ draft, step: "previewed", hasPreview: false })).toBe("q3");
  });
});

describe("validDiscount", () => {
  const now = new Date("2026-10-09T12:00:00Z");
  const offer = { promo_code_string: "FOUNDING10-AB2C", expires_at: "2026-10-10T09:00:00Z", redeemed_at: null };

  it("shows a code that can still be used", () => {
    expect(validDiscount(offer, now)).toEqual({ code: "FOUNDING10-AB2C", expiresAt: "2026-10-10T09:00:00.000Z" });
  });

  it("hides a redeemed, expired or unreadable code", () => {
    expect(validDiscount({ ...offer, redeemed_at: "2026-10-09T11:00:00Z" }, now)).toBeNull();
    expect(validDiscount({ ...offer, expires_at: "2026-10-09T12:00:00Z" }, now)).toBeNull();
    expect(validDiscount({ ...offer, expires_at: "nonsense" }, now)).toBeNull();
    expect(validDiscount(null, now)).toBeNull();
  });
});

describe("answerSummary", () => {
  it("states every answer in words, and says when one is missing", () => {
    const rows = answerSummary({ basePostcode: "YO10 5DD", priorityOutcodes: ["LS6"], travelLimitMiles: null, minBedrooms: 3 }, null);
    expect(rows).toEqual([
      { label: "Business postcode", value: "YO10 5DD" },
      { label: "Other areas", value: "LS6" },
      { label: "How far they'll travel", value: "Anywhere" },
      { label: "Bedrooms", value: "At least 3 bedrooms" },
      { label: "Projected revenue", value: "Not answered yet" },
    ]);
  });

  it("falls back to the preview's postcode, and never carries contact details", () => {
    const rows = answerSummary({ minGross: null }, "YO10 5DD");
    expect(rows[0].value).toBe("YO10 5DD");
    expect(rows.find((r) => r.label === "Projected revenue")?.value).toBe("Any");
    expect(JSON.stringify(rows)).not.toMatch(/@|email|phone|name/i);
  });
});
