import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CHAT_WRITABLE_SLOTS,
  ATTESTATION_KEYS,
  answerableOptions,
  answerableQuestions,
  answersToProfile,
  isChatWritable,
  refusalMessage,
} from "../profile";
import { templateById } from "../templates";
import type { Answer, Question } from "../schemas";

const T3 = templateById("never-see-the-messages")!;
const T6 = templateById("rules-keep-changing")!;
const T7 = templateById("what-would-it-earn")!;

/** One question with a slot, and the answer given to it. */
function ask(slot: string, answer: string): { questions: Question[]; answers: Answer[] } {
  const q: Question = {
    id: "q1",
    question: `about ${slot}`,
    options: [],
    allowOther: true,
    slot,
    depth: 0,
    calls: 0,
  };
  return { questions: [q], answers: [{ id: "q1", question: q.question, answer, depth: 0 }] };
}

const mapping = (slot: string, answer: string, t = T7) => {
  const { questions, answers } = ask(slot, answer);
  return answersToProfile(questions, answers, t);
};

const map = (slot: string, answer: string, t = T7) => {
  const { questions, answers } = ask(slot, answer);
  return answersToProfile(questions, answers, t).patch as Record<string, unknown>;
};

/**
 * ⚠️ `Question.slot` IS A STRING THE MODEL CHOSE. A mapper that trusted it
 * would let a hallucinated slot name write an arbitrary key into a column
 * every ad surface reads — §27.1's standing rule, one layer down.
 */
describe("the writable set is closed", () => {
  it("refuses a slot nobody declared", () => {
    for (const invented of ["lead_balance", "account_status", "is_active", "id", "email"]) {
      expect(isChatWritable(invented)).toBe(false);
      expect(map(invented, "whatever")).toEqual({});
    }
  });

  /**
   * ⚠️ THE TWO ATTESTATIONS ARE NOT CHAT-WRITABLE, AND THAT IS THE POINT.
   * `review_quote_confirmed` unlocks quoting a real person, and
   * `stats_confirmed_at` records that the published figures are evidenceable.
   * Both are a deliberate tick by somebody attesting to something; neither may
   * be inferred from a sentence a model mapped onto a slot.
   */
  it.each(ATTESTATION_KEYS)("never lets a chat answer set %s", (key) => {
    expect(isChatWritable(key)).toBe(false);
    expect(map(key, "yes")).toEqual({});
  });

  it("carries no key that is not a real slot", () => {
    expect(new Set(CHAT_WRITABLE_SLOTS).size).toBe(CHAT_WRITABLE_SLOTS.length);
  });

  /**
   * ⚠️ THE LIST AND THE SWITCH ARE TWO DEFENCES AND NO BEHAVIOURAL TEST CAN
   * TELL THEM APART: a slot with no `case` writes nothing whether or not the
   * list rejected it first, which the mutation run proved by deleting the
   * check and watching everything stay green. What IS worth catching is the
   * two drifting — a case added without the list, or a key added with no case
   * — either of which turns a documented rule into a decorative one.
   */
  it("agrees exactly with the cases the mapper actually handles", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/ads/profile.ts"), "utf8");
    const body = src.slice(src.indexOf("for (const [slot, raw] of"));
    const cases = Array.from(body.matchAll(/^\s{6}case "(\w+)":/gm)).map((m) => m[1]);
    expect(new Set(cases)).toEqual(new Set(CHAT_WRITABLE_SLOTS));
  });
});

/**
 * ⚠️ AN UNPARSEABLE ANSWER SETS NOTHING, and every guess it declines to make
 * fails towards a quieter advert: no fee published, no place named, no figure
 * stated. A wrong value here is on a live advert in the operator's own name.
 */
describe("the fee", () => {
  it.each([
    ["Yes, put the fee on it", true],
    ["yep", true],
    ["No, keep the fee off", false],
    ["rather not", false],
  ])("reads %s as %s", (answer, expected) => {
    expect(map("fee_public", answer).fee_public).toBe(expected);
  });

  /**
   * ⚠️ AN UNSET fee_public READS AS FALSE EVERYWHERE, so the fee stays off the
   * advert. Guessing "yes" from an ambiguous sentence publishes a price the
   * operator never agreed to publish.
   */
  it.each([
    "maybe",
    "I suppose so if it helps",
    // ⚠️ THIS ONE FOUND A REAL BUG. A prefix check reads "yes and no" as yes
    // and publishes the operator's fee on a sentence that plainly declined.
    "yes and no",
    "yes, though I'd rather not put the amount",
    "no, unless yes is better",
    "",
  ])("declines to guess from %s", (answer) => {
    expect(map("fee_public", answer)).not.toHaveProperty("fee_public");
  });

  it("reads a percentage out of prose", () => {
    expect(map("fee_pct", "we charge 15%").fee_pct).toBe(15);
    expect(map("fee_pct", "about 12.5 per cent").fee_pct).toBe(12.5);
  });

  it("refuses a percentage that cannot be one", () => {
    expect(map("fee_pct", "a hundred and fifty")).not.toHaveProperty("fee_pct");
    expect(map("fee_pct", "150%")).not.toHaveProperty("fee_pct");
  });

  /**
   * ⚠️ THE SPEC'S OWN RULE, AT THE POINT OF TYPING. "Under 8% or over 30% is
   * almost certainly a typo, and a wrong fee in a live ad is worse than no
   * ad." `feeVerdict` has implemented it since 0156 and the write path never
   * asked it — so the number was stored, `resolveSlots` then refused the same
   * number, and the fee vanished off the ad with the reason recorded in a
   * `warnings` array nothing rendered.
   */
  it.each(["3%", "we charge 4 per cent", "45%", "31%"])(
    "refuses %s as a likely typo rather than storing it",
    (answer) => {
      const m = mapping("fee_pct", answer);
      expect(m.patch).not.toHaveProperty("fee_pct");
      expect(m.refusals[0]?.reason).toBe("fee_looks_like_a_typo");
    }
  );

  it.each(["8%", "30%", "15%", "12.5%"])("takes %s, which is an ordinary fee", (answer) => {
    expect(mapping("fee_pct", answer).patch).toHaveProperty("fee_pct");
    expect(mapping("fee_pct", answer).refusals).toHaveLength(0);
  });

  /**
   * ⚠️ AND IT SAYS WHY, QUOTING THE NUMBER BACK. "That doesn't look right"
   * about a fee they cannot see is the shape of refusal this whole change
   * exists to remove — an operator answering exactly what was asked and being
   * told they had not.
   */
  it("says what it refused and how to insist", () => {
    const [refusal] = mapping("fee_pct", "45%").refusals;
    const said = refusalMessage(refusal);
    expect(said).toContain("45%");
    expect(said).toContain("8% to 30%");
    expect(said.toLowerCase()).toContain("send it again");
    expect(said).not.toContain("fee_pct");
    expect(said).not.toContain("fee_looks_like_a_typo");
  });

  /**
   * Unreadable is still unreadable, and must not be dressed as a typo — the
   * two want opposite sentences, one asking them to insist and one asking them
   * to try again.
   *
   * ⚠️ "45ish" IS A TYPO AND "15ish" IS A FEE. `asCount` reads a number out of
   * prose deliberately, and that forgiveness is right: an operator who writes
   * "about 15" means 15. Only the value decides.
   */
  it("keeps an unreadable fee separate from an out-of-range one", () => {
    expect(mapping("fee_pct", "45ish or so, depends").refusals[0]?.reason).toBe(
      "fee_looks_like_a_typo"
    );
    expect(mapping("fee_pct", "15ish or so, depends").patch.fee_pct).toBe(15);
    expect(mapping("fee_pct", "whatever the market does").refusals[0]?.reason).toBe("unreadable");
  });

  it.each([
    ["Of gross", "gross"],
    ["we take it off the net", "net"],
  ])("reads the basis from %s", (answer, expected) => {
    expect(map("fee_basis", answer).fee_basis).toBe(expected);
  });

  it("declines a basis that says both or neither", () => {
    expect(map("fee_basis", "gross or net, depends")).not.toHaveProperty("fee_basis");
    expect(map("fee_basis", "the usual")).not.toHaveProperty("fee_basis");
  });

  it.each([
    ["Plus VAT", "exclusive"],
    ["ex VAT", "exclusive"],
    ["Including VAT", "inclusive"],
    ["incl vat", "inclusive"],
    ["Rather not say", "not_stated"],
  ])("reads the VAT treatment from %s", (answer, expected) => {
    expect(map("fee_vat", answer).fee_vat).toBe(expected);
  });
});

/**
 * ⚠️ "No", "none", "anywhere" ARE NOT A TOWN. An operator declining to narrow
 * is the unlocated case, and storing their refusal puts "Landlords in None" on
 * an advert.
 */
describe("the town", () => {
  it("takes a real one", () => {
    expect(map("city", "Leeds").city).toBe("Leeds");
    expect(map("city", "Newcastle upon Tyne").city).toBe("Newcastle upon Tyne");
  });

  it.each(["No", "none", "anywhere", "n/a", "Run it without a place name", "skip"])(
    "refuses %s",
    (answer) => {
      expect(map("city", answer)).not.toHaveProperty("city");
    }
  );

  it("refuses a sentence, because a sentence is not a place", () => {
    expect(map("city", "I would rather it covered the whole county")).not.toHaveProperty("city");
  });
});

describe("the landing page", () => {
  it("accepts a bare domain and makes it https", () => {
    expect(map("landing_url", "adco.example/quote").landing_url).toBe("https://adco.example/quote");
  });

  /**
   * ⚠️ WHAT IS STORED IS STILL ALWAYS https — the button on a live ad must not
   * send anybody over http. What changed is that a typed `http://` is UPGRADED
   * and said out loud, where it used to be binned in silence. That silence is
   * what made the first real run look like it had lost an answer the operator
   * had given.
   */
  it("upgrades http to https rather than binning it, and says so", () => {
    const m = mapping("landing_url", "http://adco.example");
    expect(m.patch.landing_url).toBe("https://adco.example/");
    expect(m.notes).toEqual([{ slot: "landing_url", kind: "url_upgraded" }]);
    expect(m.refusals).toEqual([]);
  });

  it("refuses something that is not a URL at all, WITH A REASON", () => {
    const m = mapping("landing_url", "call me");
    expect(m.patch).not.toHaveProperty("landing_url");
    // ⚠️ The reason is the point. A bare `undefined` is what this replaced.
    expect(m.refusals).toEqual([
      { slot: "landing_url", reason: "not_a_url", answer: "call me" },
    ]);
  });

  it("tells a dotless host apart from unparseable text", () => {
    // Two different things to say: one is not an address at all, the other
    // looks like one and could not be a public site.
    expect(mapping("landing_url", "our website").refusals[0]?.reason).toBe("not_a_url");
    expect(mapping("landing_url", "intranet").refusals[0]?.reason).toBe("no_dot");
  });

  it("refuses a scheme the button cannot open, checked before prefixing", () => {
    // ⚠️ `new URL("https://javascript:alert(1)")` PARSES — it reads `javascript`
    // as the host — so a check after the https prefix waves this through.
    for (const bad of ["javascript:alert(1)", "mailto:me@adco.example", "data:text/html,x"]) {
      expect(mapping("landing_url", bad).refusals[0]?.reason, bad).toBe("unsupported_scheme");
    }
  });

  it("refuses a credential and a non-public host", () => {
    expect(mapping("landing_url", "https://u:p@adco.example").refusals[0]?.reason)
      .toBe("has_credentials");
    expect(mapping("landing_url", "http://127.0.0.1:3000").refusals[0]?.reason)
      .toBe("not_public");
  });

  it("strips the punctuation a paste picks up from prose", () => {
    expect(mapping("landing_url", "adco.example/quote.").patch.landing_url)
      .toBe("https://adco.example/quote");
  });
});

/**
 * ⚠️ MATCHED AGAINST THE TEMPLATE'S OWN OPTIONS. A service the model invented
 * must not become a ticked key, because a ticked key is what licenses naming
 * it on the advert.
 */
describe("the multi-selects", () => {
  it("ticks what they said, from the template's own vocabulary", () => {
    expect(map("included", "cleaning and linen", T3).included).toEqual(["cleaning", "linen"]);
  });

  it("does not tick a service the template does not offer", () => {
    const got = map("included", "cleaning, gardening, dog walking", T3).included as string[];
    expect(got).toEqual(["cleaning"]);
  });

  it("ticks nothing when they name nothing we know", () => {
    expect(map("included", "the usual stuff", T3).included).toEqual([]);
  });

  it("is ignored on a template that does not own that slot", () => {
    expect(map("handled", "licensing", T3)).not.toHaveProperty("handled");
    expect(map("handled", "licensing and fire safety", T6).handled).toEqual([
      "licensing",
      "fire_safety",
    ]);
  });
});

describe("the numbers", () => {
  it("reads counts out of prose", () => {
    expect(map("properties_managed", "about 140 right now").properties_managed).toBe(140);
    expect(map("properties_managed", "1,240").properties_managed).toBe(1240);
    expect(map("years_trading", "8 years").years_trading).toBe(8);
  });

  /** A Google score out of range is a mis-parse, not a seven-star business. */
  it("refuses a review score that cannot be one", () => {
    expect(map("review_score", "4.9").review_score).toBe(4.9);
    expect(map("review_score", "9.2")).not.toHaveProperty("review_score");
  });

  it("refuses zero and nonsense", () => {
    expect(map("years_trading", "0")).not.toHaveProperty("years_trading");
    expect(map("properties_managed", "lots")).not.toHaveProperty("properties_managed");
  });
});

describe("the free lists", () => {
  it("splits on commas and 'and'", () => {
    expect(map("councils", "Leeds City Council, Bradford and Kirklees").councils).toEqual([
      "Leeds City Council",
      "Bradford",
      "Kirklees",
    ]);
  });

  it("drops a duplicate", () => {
    expect(map("property_types", "Flats, flats, Houses").property_types).toEqual([
      "Flats",
      "flats",
      "Houses",
    ]);
  });
});

describe("the patch", () => {
  /**
   * ⚠️ A PATCH, NEVER THE WHOLE PROFILE. `merge_ad_profile` applies it with
   * `||`, so a key this omits keeps whatever was there — which is the
   * difference between "they did not answer that" and "they cleared it".
   */
  it("omits what was not answered", () => {
    expect(map("city", "Leeds")).toEqual({ city: "Leeds" });
  });

  it("ignores an answer to a question with no slot", () => {
    const { questions, answers } = ask("", "Leeds");
    expect(answersToProfile(questions, answers, T7).patch).toEqual({});
  });

  it("ignores an empty answer", () => {
    expect(map("city", "   ")).toEqual({});
  });

  it("takes the first answer when two questions claim one slot", () => {
    const questions: Question[] = [
      { id: "q1", question: "a", options: [], allowOther: true, slot: "city", depth: 0, calls: 0 },
      { id: "q2", question: "b", options: [], allowOther: true, slot: "city", depth: 0, calls: 0 },
    ];
    const answers: Answer[] = [
      { id: "q1", question: "a", answer: "Leeds", depth: 0 },
      { id: "q2", question: "b", answer: "Bradford", depth: 0 },
    ];
    expect(answersToProfile(questions, answers, T7).patch.city).toBe("Leeds");
  });
});

/**
 * ⚠️ THE ROOT CAUSE, PINNED. The model writes the options as well as the
 * question, and nothing checked them against the slot they answer — so it
 * offered a destination the schema could not keep, the operator tapped it, and
 * the run was refused for the answer it had invited.
 */
describe("an option the slot cannot store is never offered", () => {
  /** Verbatim from the one draft production ever made (draft dd4a1a7e, 21 Sep). */
  const REAL = "Message straight to my phone (WhatsApp or Messenger)";

  it("drops the exact option that broke the first real run", () => {
    const kept = answerableOptions("landing_url", [REAL, "https://adco.example/quote"]);
    expect(kept).toEqual(["https://adco.example/quote"]);
  });

  it("keeps options the destination slot genuinely accepts", () => {
    expect(
      answerableOptions("destination", ["A page on my own website", "A form inside Facebook"])
    ).toEqual(["A page on my own website", "A form inside Facebook"]);
  });

  it("drops a town that is a refusal and keeps a real one", () => {
    expect(answerableOptions("city", ["Leeds", "Leave it off for now"])).toEqual(["Leeds"]);
  });

  it("drops a fee that is not a number", () => {
    expect(answerableOptions("fee_pct", ["15%", "It depends on the property"])).toEqual(["15%"]);
  });

  it("leaves a free-prose slot alone", () => {
    const opts = ["Same day", "Within a week", "Whenever I get round to it"];
    expect(answerableOptions("turnaround", opts)).toEqual(opts);
  });

  it("leaves a slot nobody can write alone", () => {
    expect(answerableOptions("review_quote", ["anything"])).toEqual(["anything"]);
    expect(answerableOptions(undefined, ["anything"])).toEqual(["anything"]);
  });

  /**
   * ⚠️ A SINGLE BUTTON IS NOT A QUESTION. The ladder already terminates in a
   * plain text box, so the honest degradation when the options are gutted is to
   * ask in words — not to offer the one survivor as though it were a choice.
   */
  it("falls back to free text rather than offering one option", () => {
    const q = {
      id: "q1",
      question: "Where should the button send them?",
      options: [REAL, "Ring me instead"],
      allowOther: false,
      slot: "landing_url",
      depth: 1,
      calls: 1,
    };
    const [out] = answerableQuestions([q]);
    expect(out.options).toEqual([]);
    expect(out.allowOther).toBe(true);
    // The question itself is untouched — only what it offered.
    expect(out.question).toBe(q.question);
    expect(out.depth).toBe(1);
  });

  it("leaves a question whose options all survive exactly as it was", () => {
    const q = {
      id: "q1",
      question: "Which town?",
      options: ["Leeds", "Bradford"],
      allowOther: true,
      slot: "city",
      depth: 0,
      calls: 0,
    };
    expect(answerableQuestions([q])[0]).toBe(q);
  });
});
