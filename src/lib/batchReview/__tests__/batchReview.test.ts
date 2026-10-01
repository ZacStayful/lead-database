/**
 * The monthly batch review's rules (§73): the vocabulary, prefill, pipeline
 * write-back, metrics, the shortfall copy, submission checks, timing and the
 * admin arithmetic. Pure units, no database.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  ALL_ANSWERS,
  CONVERSION_BENCHMARK,
  DEAD_REASONS,
  answersFor,
  asksForReason,
  wasCalled,
} from "../answers";
import { pipelineChangeFor, prefillAnswer, readOnlyReason } from "../pipeline";
import { benchmarkReading, countAnswers, formatRate } from "../metrics";
import {
  isShortfall,
  nextDue,
  shortfallCause,
  shortfallCopy,
  shortfallSummaryLine,
  type ShortfallSnapshot,
} from "../shortfall";
import { validateSubmission } from "../submission";
import {
  addDaysIso,
  batchReviewSettingsFrom,
  cycleLabel,
  reminderDue,
  reviewOpen,
  surveyDue,
} from "../settings";
import { deriveReviewToken, looksLikeReviewToken } from "../review";
import {
  conversionByArea,
  reasonsByArea,
  responseByCustomer,
  shortfallLog,
  type AdminReview,
} from "../adminStats";

const MIGRATION = readFileSync("supabase/migrations/0160_lead_batch_reviews.sql", "utf8");

function checkList(column: string): string[] {
  const m = MIGRATION.match(new RegExp(`${column}\\s+text check \\(${column} in \\(([^)]*)\\)\\)`));
  if (!m) throw new Error(`no CHECK found for ${column}`);
  return Array.from(m[1].matchAll(/'([a-z_]+)'/g)).map((x) => x[1]);
}

describe("the vocabulary matches the database", () => {
  it("answers equal the CHECK exactly", () => {
    expect(checkList("answer").sort()).toEqual([...ALL_ANSWERS].sort());
  });
  it("dead reasons equal the CHECK exactly", () => {
    expect(checkList("dead_reason").sort()).toEqual([...DEAD_REASONS].sort());
  });
  it("each product offers only answers the CHECK admits", () => {
    for (const lt of ["management", "guaranteed_rent"] as const) {
      for (const a of answersFor(lt)) expect(ALL_ANSWERS).toContain(a.value);
    }
  });
  it("management asks about web meetings and GR about viewings and contracts", () => {
    const mgmt = answersFor("management").map((a) => a.value);
    const gr = answersFor("guaranteed_rent").map((a) => a.value);
    expect(mgmt).toContain("meeting_booked");
    expect(mgmt).not.toContain("viewing_booked");
    expect(gr).toContain("viewing_booked");
    expect(gr).not.toContain("meeting_booked");
  });
  it("called is derived from the answer, never asked", () => {
    expect(wasCalled("not_called")).toBe(false);
    expect(wasCalled("no_answer")).toBe(true);
    expect(wasCalled(null)).toBeNull();
  });
  it("only the two going-nowhere answers ask why", () => {
    expect(asksForReason("no_answer")).toBe(true);
    expect(asksForReason("not_interested")).toBe(true);
    expect(asksForReason("talking")).toBe(false);
    expect(asksForReason("not_called")).toBe(false);
  });
  it("benchmarks are 5% management and 10% GR", () => {
    expect(CONVERSION_BENCHMARK).toEqual({ management: 0.05, guaranteed_rent: 0.1 });
  });
});

const live = (stage: string, status = "contacted") => ({ status, pipeline_stage: stage, closed_at: null });

describe("prefill", () => {
  it("leaves a cold lead blank so the customer has to say", () => {
    expect(prefillAnswer("management", live("cold", "new"))).toBeNull();
    expect(prefillAnswer("management", live("cold"))).toBeNull();
  });
  it("maps the unambiguous management stages", () => {
    expect(prefillAnswer("management", live("web_meeting_booked"))).toBe("meeting_booked");
    expect(prefillAnswer("management", live("web_meeting_no_show"))).toBe("meeting_booked");
    expect(prefillAnswer("management", live("web_meeting_attended"))).toBe("meeting_held");
    expect(prefillAnswer("management", live("interested_in_the_future"))).toBe("likely_later");
    expect(prefillAnswer("management", live("abandoned"))).toBe("not_interested");
  });
  it("maps the GR stages", () => {
    expect(prefillAnswer("guaranteed_rent", live("viewing_booked"))).toBe("viewing_booked");
    expect(prefillAnswer("guaranteed_rent", live("contract_signed"))).toBe("signed");
  });
  it("a won lead is signed whatever its stage", () => {
    expect(prefillAnswer("management", live("abandoned", "won"))).toBe("signed");
  });
});

describe("write-back", () => {
  it("a settled lead is read-only and never written", () => {
    expect(readOnlyReason(live("cold", "rejected"))).toBe("rejected");
    expect(readOnlyReason(live("won", "won"))).toBe("won");
    expect(readOnlyReason({ status: "contacted", pipeline_stage: "cold", closed_at: "2026-09-01" })).toBe("closed");
    expect(readOnlyReason(null)).toBe("gone");
    for (const s of [live("cold", "rejected"), live("won", "won"), null]) {
      expect(pipelineChangeFor("management", "meeting_booked", s)).toBeNull();
    }
  });
  it("not called writes nothing", () => {
    expect(pipelineChangeFor("management", "not_called", live("cold", "new"))).toBeNull();
  });
  it("couldn't reach marks a new lead contacted and leaves the stage", () => {
    expect(pipelineChangeFor("management", "no_answer", live("cold", "new"))).toEqual({ markContacted: true });
    expect(pipelineChangeFor("management", "no_answer", live("cold"))).toBeNull();
  });
  it("moves the management stage", () => {
    expect(pipelineChangeFor("management", "meeting_booked", live("cold"))).toEqual({
      markContacted: false,
      pipeline_stage: "web_meeting_booked",
    });
    expect(pipelineChangeFor("management", "signed", live("cold", "new"))?.pipeline_stage).toBe("won");
    expect(pipelineChangeFor("management", "not_interested", live("cold"))?.pipeline_stage).toBe("abandoned");
    expect(pipelineChangeFor("management", "likely_later", live("cold"))?.pipeline_stage).toBe(
      "interested_in_the_future"
    );
  });
  it("an answer matching the current stage writes nothing", () => {
    expect(pipelineChangeFor("management", "meeting_booked", live("web_meeting_booked"))).toBeNull();
  });
  it("GR never gets a management stage (invariant 6)", () => {
    expect(pipelineChangeFor("guaranteed_rent", "not_interested", live("cold"))).toBeNull();
    expect(pipelineChangeFor("guaranteed_rent", "likely_later", live("cold"))).toBeNull();
    expect(pipelineChangeFor("guaranteed_rent", "signed", live("cold"))?.pipeline_stage).toBe("contract_signed");
  });
});

describe("metrics", () => {
  it("rates are over delivered, not over answered", () => {
    const c = countAnswers(10, ["signed", "meeting_booked", "not_called", null, null]);
    expect(c.delivered).toBe(10);
    expect(c.answered).toBe(3);
    expect(c.interested).toBe(2);
    expect(c.meetings).toBe(2);
    expect(c.signed).toBe(1);
    expect(c.called).toBe(2);
    expect(c.notCalled).toBe(1);
  });
  it("formats small rates to one decimal so 5% is not rounded away", () => {
    expect(formatRate(0.05)).toBe("5%");
    expect(formatRate(0.045)).toBe("4.5%");
    expect(formatRate(0.25)).toBe("25%");
    expect(formatRate(null)).toBe("—");
  });
  it("withholds the comparison below 10 leads", () => {
    expect(benchmarkReading("management", 1, 5).position).toBeNull();
    expect(benchmarkReading("management", 2, 20).position).toBe("above");
    expect(benchmarkReading("management", 1, 20).position).toBe("level");
    expect(benchmarkReading("guaranteed_rent", 1, 20).position).toBe("below");
  });
});

const snap = (over: Partial<ShortfallSnapshot> = {}): ShortfallSnapshot => ({
  allocation: 10,
  delivered: 7,
  balance_at_reset: 3,
  next_allocation: 10,
  pool_debit: 0,
  cycle_start: "2026-09-15",
  cycle_end: "2026-10-15",
  filter_status: "off",
  filter_expected_leads: null,
  filter_areas: null,
  filter_min_bedrooms: null,
  filter_max_bedrooms: null,
  filter_min_gross: null,
  release_hold_until: null,
  ...over,
});

describe("shortfall", () => {
  it("is short only with fewer leads AND credit carried", () => {
    expect(isShortfall(snap())).toBe(true);
    expect(isShortfall(snap({ delivered: 10 }))).toBe(false);
    expect(isShortfall(snap({ balance_at_reset: 0 }))).toBe(false);
  });
  it("due next = carried + the next grant, less pool debit", () => {
    expect(nextDue(snap())).toBe(13);
    expect(nextDue(snap({ pool_debit: 2 }))).toBe(11);
    expect(nextDue(snap({ next_allocation: 20 }))).toBe(23);
  });
  it("names the hold first, then the filter, then supply", () => {
    expect(shortfallCause(snap({ release_hold_until: "2026-09-20" }))).toBe("hold");
    expect(shortfallCause(snap({ release_hold_until: "2026-09-01" }))).toBe("supply");
    expect(shortfallCause(snap({ filter_status: "active", filter_expected_leads: 4 }))).toBe("filter");
    expect(shortfallCause(snap({ filter_status: "active", filter_expected_leads: null }))).toBe("filter");
    expect(shortfallCause(snap({ filter_status: "active", filter_expected_leads: 12 }))).toBe("supply");
    expect(shortfallCause(snap())).toBe("supply");
  });
  it("names the filter's criteria and says at least", () => {
    const copy = shortfallCopy(
      snap({ filter_status: "active", filter_expected_leads: 4, filter_areas: ["BS", "GL"], filter_min_bedrooms: 3 }),
      "Management",
      "15 October"
    );
    expect(copy.causeSentence).toContain("BS, GL");
    expect(copy.causeSentence).toContain("3+ bed");
    expect(copy.causeSentence).toContain("at least 4 leads");
    expect(copy.options).toHaveLength(2);
  });
  it("states the three figures", () => {
    const copy = shortfallCopy(snap(), "Management", "15 October");
    expect(copy.figures.map((f) => f.value)).toEqual(["7", "3", "13 (3 owed + 10 new)"]);
    expect(copy.subject).toContain("7 of 10");
  });
  it("never offers or implies a refund (§28.0, §69)", () => {
    const banned = /refund|money back|compensat|reimburs|credit(ed)? back|guarantee/i;
    for (const s of [
      snap(),
      snap({ release_hold_until: "2026-09-20" }),
      snap({ filter_status: "active", filter_expected_leads: 2 }),
    ]) {
      const copy = shortfallCopy(s, "Management", "15 October");
      const text = [copy.subject, copy.headline, copy.causeSentence, ...copy.options, ...copy.figures.map((f) => f.label)].join(" ");
      expect(text).not.toMatch(banned);
      expect(shortfallSummaryLine(s)).not.toMatch(banned);
    }
  });
});

describe("submission", () => {
  const items = [
    { id: "a", editable: true },
    { id: "b", editable: true },
    { id: "c", editable: false },
  ];
  it("accepts a full submission and drops answers for read-only rows", () => {
    const v = validateSubmission("management", items, {
      answers: [
        { item_id: "a", answer: "signed" },
        { item_id: "b", answer: "not_interested", dead_reason: "not_letting" },
        { item_id: "c", answer: "talking" },
      ],
      quality_rating: 4,
      comment: "  good  ",
    });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.value.answers.map((a) => a.itemId)).toEqual(["a", "b"]);
    expect(v.value.answers[1].deadReason).toBe("not_letting");
    expect(v.value.comment).toBe("good");
  });
  it("refuses a row from another batch", () => {
    const v = validateSubmission("management", items, { answers: [{ item_id: "zzz", answer: "signed" }] });
    expect(v.ok).toBe(false);
  });
  it("refuses a partial submission (no skipping)", () => {
    const v = validateSubmission("management", items, { answers: [{ item_id: "a", answer: "signed" }] });
    expect(v).toEqual({ ok: false, error: "Please answer every lead first. 1 still needs an answer." });
  });
  it("refuses an answer from the other product", () => {
    const v = validateSubmission("management", items, {
      answers: [
        { item_id: "a", answer: "viewing_booked" },
        { item_id: "b", answer: "signed" },
      ],
    });
    expect(v.ok).toBe(false);
  });
  it("drops a reason on an answer that went somewhere", () => {
    const v = validateSubmission("management", items, {
      answers: [
        { item_id: "a", answer: "signed", dead_reason: "not_letting" },
        { item_id: "b", answer: "talking" },
      ],
    });
    expect(v.ok && v.value.answers[0].deadReason).toBeNull();
  });
  it("refuses a bad reason, a bad rating and a long comment", () => {
    const base = [
      { item_id: "a", answer: "no_answer" },
      { item_id: "b", answer: "talking" },
    ];
    expect(validateSubmission("management", items, { answers: [{ ...base[0], dead_reason: "ghosted" }, base[1]] }).ok).toBe(false);
    expect(validateSubmission("management", items, { answers: base, quality_rating: 6 }).ok).toBe(false);
    expect(validateSubmission("management", items, { answers: base, comment: "x".repeat(2001) }).ok).toBe(false);
    expect(validateSubmission("management", items, null).ok).toBe(false);
  });
});

describe("timing", () => {
  const s = batchReviewSettingsFrom(new Map());
  it("defaults fail to off with 7 / 3 / 30", () => {
    expect(s).toEqual({ enabled: false, delayDays: 7, reminderDays: 3, tokenDays: 30 });
    expect(batchReviewSettingsFrom(new Map([["batch_reviews_enabled", "TRUE"]])).enabled).toBe(false);
    expect(batchReviewSettingsFrom(new Map([["batch_review_delay_days", "abc"]])).delayDays).toBe(7);
  });
  const r = {
    cycle_end: "2026-10-15",
    delivered: 5,
    survey_sent_at: null,
    reminder_sent_at: null,
    submitted_at: null,
    token_expires_at: null,
  };
  it("the survey waits the delay, needs a lead, and is not sent twice", () => {
    expect(surveyDue(r, "2026-10-21", s)).toBe(false);
    expect(surveyDue(r, "2026-10-22", s)).toBe(true);
    expect(surveyDue({ ...r, delivered: 0 }, "2026-10-22", s)).toBe(false);
    expect(surveyDue({ ...r, survey_sent_at: "2026-10-22T09:40:00Z" }, "2026-10-23", s)).toBe(false);
    expect(surveyDue(r, "2026-11-20", s)).toBe(false);
  });
  it("one reminder, after the gap, while unanswered and unexpired", () => {
    const sent = { ...r, survey_sent_at: "2026-10-22T09:40:00Z", token_expires_at: "2026-11-21T09:40:00Z" };
    expect(reminderDue(sent, new Date("2026-10-24T09:40:00Z"), s)).toBe(false);
    expect(reminderDue(sent, new Date("2026-10-25T09:40:00Z"), s)).toBe(true);
    expect(reminderDue({ ...sent, reminder_sent_at: "x" }, new Date("2026-10-26T09:40:00Z"), s)).toBe(false);
    expect(reminderDue({ ...sent, submitted_at: "x" }, new Date("2026-10-26T09:40:00Z"), s)).toBe(false);
    expect(reminderDue(sent, new Date("2026-11-22T09:40:00Z"), s)).toBe(false);
    expect(reviewOpen(sent, new Date("2026-10-30T00:00:00Z"))).toBe(true);
    expect(reviewOpen(sent, new Date("2026-11-22T00:00:00Z"))).toBe(false);
  });
  it("the label stops the day before the reset", () => {
    // en-GB abbreviates September as "Sept" on some ICU versions and "Sep" on others.
    expect(cycleLabel("2026-09-15", "2026-10-15")).toMatch(/^15 Sept? – 14 Oct$/);
    expect(addDaysIso("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("the link token", () => {
  it("is the same whichever way Postgres spells the expiry", () => {
    const a = deriveReviewToken("rev-1", "2026-11-21T09:40:00.000Z", "secret");
    const b = deriveReviewToken("rev-1", "2026-11-21T09:40:00+00:00", "secret");
    expect(a).toBe(b);
    expect(a && looksLikeReviewToken(a)).toBe(true);
  });
  it("differs per review and per secret, and needs a secret", () => {
    const a = deriveReviewToken("rev-1", "2026-11-21T09:40:00Z", "secret");
    expect(deriveReviewToken("rev-2", "2026-11-21T09:40:00Z", "secret")).not.toBe(a);
    expect(deriveReviewToken("rev-1", "2026-11-21T09:40:00Z", "other")).not.toBe(a);
    expect(deriveReviewToken("rev-1", "2026-11-21T09:40:00Z", undefined)).toBeNull();
  });
});

describe("admin arithmetic", () => {
  const review = (id: string, over: Partial<AdminReview> = {}): AdminReview => ({
    ...snap(),
    id,
    customer_id: "c1",
    lead_type: "management",
    survey_sent_at: "2026-10-22T09:00:00Z",
    submitted_at: null,
    quality_rating: null,
    comment: null,
    ...over,
  });
  const reviews = [
    review("r1", { submitted_at: "2026-10-24T09:00:00Z" }),
    review("r2"),
    review("r3", { customer_id: "c2", survey_sent_at: null }),
  ];
  const items = [
    { review_id: "r1", answer: "signed" as const, dead_reason: null, postcode_area: "BS" },
    { review_id: "r1", answer: "no_answer" as const, dead_reason: "couldnt_reach" as const, postcode_area: "BS" },
    { review_id: "r2", answer: null, dead_reason: null, postcode_area: "BS" },
  ];
  it("response rate counts sent reviews only", () => {
    const [row] = responseByCustomer(reviews);
    expect(row).toMatchObject({ customerId: "c1", sent: 2, submitted: 1 });
    expect(row.avgDaysToSubmit).toBe(2);
  });
  it("conversion counts answered batches only", () => {
    const [bs] = conversionByArea(reviews, items);
    expect(bs.counts.delivered).toBe(2);
    expect(bs.counts.signed).toBe(1);
  });
  it("reasons count the going-nowhere answers", () => {
    expect(reasonsByArea(reviews, items)).toEqual([
      { key: "BS", total: 1, byReason: { couldnt_reach: 1 }, unexplained: 0 },
    ]);
  });
  it("the shortfall log names a cause per short month", () => {
    expect(shortfallLog(reviews).map((s) => s.cause)).toEqual(["supply", "supply", "supply"]);
  });
});
