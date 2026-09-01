import { describe, it, expect } from "vitest";
import {
  nudgeStage,
  alreadyAnswered,
  buildNudgeCopy,
  renderNudgeBody,
  type NudgeLead,
} from "@/lib/landlordNudge";
import { retryShouldAskQuestions } from "@/lib/landlordReferralSend";
import type { ReferralOperator } from "@/lib/landlordReferral";

const LEAD_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function lead(over: Partial<NudgeLead> = {}): NudgeLead {
  return {
    id: LEAD_ID,
    lead_name: "Sarah Hughes",
    email: "sarah@example.com",
    address: "12 Test St, Darlington DL1 1AA",
    lead_type: "management",
    owner_customer_id: null,
    lead_quality_codes: [],
    gross_annual_income: 36112,
    ...over,
  };
}

function operator(over: Partial<ReferralOperator> = {}): ReferralOperator {
  return {
    business_name: "Northern Stays",
    contact_name: "Dan Prior",
    email: "dan@northernstays.example",
    phone: "07700900111",
    operator_intro: null,
    ...over,
  };
}

/** Everything the landlord could ever see, in one string. */
function rendered(copy: ReturnType<typeof buildNudgeCopy>): string {
  return [
    copy.subject,
    copy.greeting,
    ...copy.intro,
    copy.headline ?? "",
    copy.operatorLine ?? "",
    copy.cta.label,
    copy.cta.note,
    renderNudgeBody(copy),
  ].join("\n");
}

describe("nudgeStage reads the spine, never the submitted stamp", () => {
  it("is silent when nothing has been answered", () => {
    expect(nudgeStage(lead())).toBe("silent");
  });

  it("is partial on a single answer", () => {
    expect(nudgeStage(lead({ landlord_contact_method: "whatsapp" }))).toBe("partial");
    expect(nudgeStage(lead({ landlord_contact_time: "Weekday mornings" }))).toBe("partial");
    expect(nudgeStage(lead({ landlord_wants: ["costs"] }))).toBe("partial");
  });

  it("treats an EMPTY wants array as no answer", () => {
    // The column is text[] and an empty array is not a choice. `.length` rather
    // than a null check is what separates the two.
    expect(nudgeStage(lead({ landlord_wants: [] }))).toBe("silent");
  });

  it("ignores landlord_prefs_step, which is progress and not content", () => {
    // A landlord can reach step 2 by clicking through without answering. The
    // stage must follow what we actually HOLD, or the copy would tell somebody
    // we have details we do not.
    expect(nudgeStage(lead({ landlord_prefs_step: 3 }))).toBe("silent");
  });
});

describe("alreadyAnswered", () => {
  it("renders the method by its label, not its column value", () => {
    expect(alreadyAnswered(lead({ landlord_contact_method: "whatsapp" }))).toEqual(["WhatsApp"]);
    expect(alreadyAnswered(lead({ landlord_contact_method: "phone" }))).toEqual(["A phone call"]);
  });

  it("drops a value that is not one of the three", () => {
    expect(alreadyAnswered(lead({ landlord_contact_method: "carrier_pigeon" }))).toEqual([]);
  });

  it("does NOT include what they want to know", () => {
    // Reading their own question back to them is not evidence of progress, and
    // it makes the sentence long enough to bury the ask.
    expect(alreadyAnswered(lead({ landlord_wants: ["costs", "voids"] }))).toEqual([]);
  });
});

describe("the figure", () => {
  it("appears on the first reminder for a management lead with an analysis", () => {
    const copy = buildNudgeCopy({ lead: lead(), operator: operator(), attempt: 1 });
    expect(copy.headline).toMatch(/£32,501–£39,723 a year gross/);
    expect(copy.headline).toMatch(/estimate, not a promise/);
  });

  it("is absent on the SECOND reminder — a last word does not re-pitch", () => {
    const copy = buildNudgeCopy({ lead: lead(), operator: operator(), attempt: 2 });
    expect(copy.headline).toBeNull();
  });

  it("is never shown to a guaranteed-rent landlord", () => {
    // §25's analysis is management-only by design: a GR operator pays a fixed
    // rent rather than managing for a fee, so a short-let gross projection is
    // the WRONG number for that conversation, not a missing one.
    const copy = buildNudgeCopy({
      lead: lead({ lead_type: "guaranteed_rent" }),
      operator: operator(),
      attempt: 1,
    });
    expect(copy.headline).toBeNull();
  });

  it("is absent when the lead has no analysis", () => {
    const copy = buildNudgeCopy({
      lead: lead({ gross_annual_income: null }),
      operator: operator(),
      attempt: 1,
    });
    expect(copy.headline).toBeNull();
    // …and the ask still goes out, because the questions are the spine.
    expect(copy.cta.label).toBe("Tell them how to reach you");
  });
});

describe("no price, no percentage, no other operator — ever", () => {
  const cases: { name: string; lead: NudgeLead; attempt: 1 | 2 }[] = [
    { name: "silent, with figures", lead: lead(), attempt: 1 },
    { name: "silent, no figures", lead: lead({ gross_annual_income: null }), attempt: 1 },
    {
      name: "partial",
      lead: lead({ landlord_contact_method: "whatsapp", landlord_contact_time: "Weekends" }),
      attempt: 1,
    },
    { name: "second reminder", lead: lead(), attempt: 2 },
    { name: "guaranteed rent", lead: lead({ lead_type: "guaranteed_rent" }), attempt: 1 },
  ];

  for (const c of cases) {
    it(`${c.name}: quotes no fee and no percentage`, () => {
      const text = rendered(
        buildNudgeCopy({ lead: c.lead, operator: operator(), attempt: c.attempt })
      );
      // The report's fee is Stayful's, the operator's is different and unknown
      // here, and either is a price claim we cannot stand behind (§26.1).
      expect(text).not.toMatch(/%/);
      expect(text).not.toMatch(/\bfee\b/i);
      expect(text).not.toMatch(/\bcommission\b/i);
      expect(text).not.toMatch(/\bwe charge\b/i);
    });

    it(`${c.name}: says nothing about any other operator`, () => {
      const text = rendered(
        buildNudgeCopy({ lead: c.lead, operator: operator(), attempt: c.attempt })
      ).toLowerCase();
      // §19.7: not that others hold the lead, not how many. Sharper here than
      // in the pool, because the reader is the landlord.
      expect(text).not.toMatch(/other operator|another operator|operators|also been sent|as well as/);
    });
  }
});

describe("the two wordings", () => {
  it("a silent landlord is told what is missing, not re-introduced", () => {
    const copy = buildNudgeCopy({ lead: lead(), operator: operator(), attempt: 1 });
    expect(copy.stage).toBe("silent");
    expect(copy.intro.join(" ")).toMatch(/we have not heard back/);
    expect(copy.intro.join(" ")).toMatch(/whether to call, email or message/);
  });

  it("a partial landlord is told what we already have", () => {
    const copy = buildNudgeCopy({
      lead: lead({ landlord_contact_method: "whatsapp", landlord_contact_time: "Weekends" }),
      operator: operator(),
      attempt: 1,
    });
    expect(copy.stage).toBe("partial");
    expect(copy.intro[0]).toMatch(/WhatsApp, Weekends/);
    expect(copy.cta.label).toBe("Finish the last questions");
    expect(copy.cta.note).toMatch(/nothing you have already answered is asked again/);
  });

  it("the second reminder says it is the last one", () => {
    const copy = buildNudgeCopy({ lead: lead(), operator: operator(), attempt: 2 });
    expect(copy.intro.join(" ")).toMatch(/the last we will send/);
    // A reminder that does not signal it is final invites the reader to assume
    // there will be more.
    expect(copy.intro.join(" ")).toMatch(/ignore this/);
  });
});

describe("the operator, as the landlord meets them", () => {
  it("falls back through business name to a neutral phrase", () => {
    expect(
      buildNudgeCopy({
        lead: lead(),
        operator: operator({ contact_name: null }),
        attempt: 1,
      }).operatorLine
    ).toBe("Northern Stays");

    const copy = buildNudgeCopy({
      lead: lead(),
      operator: operator({ contact_name: null, business_name: null }),
      attempt: 1,
    });
    expect(copy.operatorLine).toBeNull();
    expect(copy.subject).toMatch(/a local operator/);
  });

  it("greets by first name, and falls back cleanly on junk", () => {
    expect(buildNudgeCopy({ lead: lead(), operator: operator(), attempt: 1 }).greeting).toBe(
      "Hi Sarah,"
    );
    expect(
      buildNudgeCopy({ lead: lead({ lead_name: "" }), operator: operator(), attempt: 1 }).greeting
    ).toBe("Hello,");
  });
});

describe("nothing an operator typed can escape into the markup", () => {
  it("escapes a hostile business name", () => {
    const hostile = `<script>alert(1)</script> & "quoted" <img onerror=x>`;
    const copy = buildNudgeCopy({
      lead: lead(),
      operator: operator({ business_name: hostile, contact_name: null }),
      attempt: 1,
    });
    const html = renderNudgeBody(copy);
    expect(html).not.toMatch(/<script>/);
    expect(html).not.toMatch(/<img/);
    expect(html).toMatch(/&lt;script&gt;/);
    expect(html).toMatch(/&amp;/);
  });

  it("escapes a hostile landlord name in the greeting", () => {
    const copy = buildNudgeCopy({
      lead: lead({ lead_name: "<b>Sarah" }),
      operator: operator(),
      attempt: 1,
    });
    // The name fails landlordFirstName's letter test only if it has none; a
    // tag-shaped one still reaches the greeting, so escaping is what protects.
    expect(renderNudgeBody(copy)).not.toMatch(/<b>/);
  });

  it("renders no empty blocks when there is nothing to put in them", () => {
    const copy = buildNudgeCopy({
      lead: lead({ gross_annual_income: null }),
      operator: operator({ contact_name: null, business_name: null }),
      attempt: 1,
    });
    const html = renderNudgeBody(copy);
    expect(html).not.toMatch(/Waiting to hear from you/);
    expect(html).not.toMatch(/background:#eef4ec/);
  });
});

describe("retryShouldAskQuestions, widened for the re-ask rule", () => {
  it("still asks when the lead holds the flag and no sibling has sent", () => {
    expect(retryShouldAskQuestions("2026-09-01T00:00:00Z", true)).toBe(true);
  });

  it("stays quiet when a sibling already sent", () => {
    expect(retryShouldAskQuestions("2026-09-01T00:00:00Z", false)).toBe(false);
  });

  it("stays quiet when the flag was released", () => {
    expect(retryShouldAskQuestions(null, true)).toBe(false);
  });

  it("REFUSES once the landlord has answered everything", () => {
    // The gap this closes: a landlord can answer between the claim and the
    // retry — through the reminder sweep, or another operator's introduction
    // that got through while this one was failing.
    expect(
      retryShouldAskQuestions("2026-09-01T00:00:00Z", true, {
        landlord_contact_method: "whatsapp",
        landlord_contact_time: "Weekends",
        landlord_wants: ["costs"],
      })
    ).toBe(false);
  });

  it("still asks on a PARTIAL answer", () => {
    // Two of three answered is exactly who the questions are still for.
    expect(
      retryShouldAskQuestions("2026-09-01T00:00:00Z", true, {
        landlord_contact_method: "whatsapp",
        landlord_contact_time: "Weekends",
        landlord_wants: null,
      })
    ).toBe(true);
  });

  it("treats an empty wants array as unanswered", () => {
    expect(
      retryShouldAskQuestions("2026-09-01T00:00:00Z", true, {
        landlord_contact_method: "whatsapp",
        landlord_contact_time: "Weekends",
        landlord_wants: [],
      })
    ).toBe(true);
  });

  it("is unchanged when no answer state is supplied", () => {
    // The parameter is optional so every existing call site keeps its meaning.
    expect(retryShouldAskQuestions("2026-09-01T00:00:00Z", true, undefined)).toBe(true);
  });
});
