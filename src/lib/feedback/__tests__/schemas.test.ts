import { describe, expect, it } from "vitest";
import {
  MAX_DEPTH,
  MAX_OPTIONS,
  MAX_QUESTIONS,
  answersComplete,
  collectAnswers,
  normaliseBrief,
  normaliseQuestions,
  normaliseSimplified,
  terminalQuestion,
  type Question,
} from "../schemas";

const q = (over: Partial<Question> = {}): Question => ({
  id: "q1",
  question: "Which did you use?",
  options: ["Reject", "Discard"],
  allowOther: false,
  depth: 0,
  ...over,
});

describe("normaliseQuestions", () => {
  it("keeps a well-formed set and numbers the ids", () => {
    const out = normaliseQuestions({
      request_class: "bug",
      questions: [
        { question: "A?", options: ["one", "two"], allow_other: false },
        { question: "B?", options: ["x", "y", "z"], allow_other: true },
      ],
    });
    expect(out?.requestClass).toBe("bug");
    expect(out?.questions.map((x) => x.id)).toEqual(["q1", "q2"]);
    expect(out?.questions[0].depth).toBe(0);
  });

  it("caps the count, so the form never becomes work", () => {
    const out = normaliseQuestions({
      request_class: "feature",
      questions: Array.from({ length: 12 }, (_, i) => ({
        question: `Q${i}?`,
        options: ["a", "b"],
        allow_other: false,
      })),
    });
    expect(out?.questions).toHaveLength(MAX_QUESTIONS);
  });

  it("de-duplicates options case-insensitively", () => {
    const out = normaliseQuestions({
      request_class: "bug",
      questions: [{ question: "A?", options: ["Reject", "reject", "Discard"], allow_other: false }],
    });
    expect(out?.questions[0].options).toEqual(["Reject", "Discard"]);
  });

  it("caps the options, so no question becomes a wall of choices", () => {
    const out = normaliseQuestions({
      request_class: "bug",
      questions: [{ question: "A?", options: ["a", "b", "c", "d", "e", "f"], allow_other: false }],
    });
    expect(out?.questions[0].options).toHaveLength(MAX_OPTIONS);
  });

  it("drops a repeated question rather than asking it twice", () => {
    const out = normaliseQuestions({
      request_class: "bug",
      questions: [
        { question: "Same?", options: ["a", "b"], allow_other: false },
        { question: "SAME?", options: ["c", "d"], allow_other: false },
      ],
    });
    expect(out?.questions).toHaveLength(1);
  });

  it("turns a question with too few options into a typed answer, not a dead end", () => {
    // ⚠️ There is no skip button, so a question rendered with one option and no
    // text box would be unanswerable and the customer would be stuck.
    const out = normaliseQuestions({
      request_class: "bug",
      questions: [{ question: "What happened?", options: ["only one"], allow_other: false }],
    });
    expect(out?.questions[0].options).toEqual([]);
    expect(out?.questions[0].allowOther).toBe(true);
  });

  it("returns null on junk so the caller degrades instead of rendering nothing", () => {
    expect(normaliseQuestions(null)).toBeNull();
    expect(normaliseQuestions({ questions: "nope" })).toBeNull();
    expect(normaliseQuestions({ questions: [{ question: "   " }] })).toBeNull();
  });

  it("falls back to a safe class rather than trusting an invented one", () => {
    const out = normaliseQuestions({
      request_class: "catastrophe",
      questions: [{ question: "A?", options: ["a", "b"], allow_other: false }],
    });
    expect(out?.requestClass).toBe("bug");
  });
});

describe("the simplification ladder", () => {
  it("deepens by one and keeps the question's id", () => {
    const out = normaliseSimplified(
      { question: "Simpler?", options: ["yes", "no"], allow_other: false },
      q()
    );
    expect(out.depth).toBe(1);
    expect(out.id).toBe("q1");
    expect(out.question).toBe("Simpler?");
  });

  it("ALWAYS terminates at the floor, whatever the model returns", () => {
    // The model is told depth 2 must be answerable by anyone. This is what
    // makes that true rather than requested — and it is the reason removing
    // the skip button is safe.
    const out = normaliseSimplified(
      { question: "Still a four-way choice?", options: ["a", "b", "c", "d"], allow_other: false },
      q({ depth: MAX_DEPTH - 1 })
    );
    expect(out.depth).toBe(MAX_DEPTH);
    expect(out.options).toEqual([]);
    expect(out.allowOther).toBe(true);
  });

  it("terminates when the model fails, so 'not sure' never dead-ends", () => {
    for (const junk of [null, undefined, {}, { question: "" }, "text"]) {
      const out = normaliseSimplified(junk, q());
      expect(out.allowOther || out.options.length >= 2).toBe(true);
    }
  });

  it("never returns a question that cannot be answered", () => {
    const cases = [q(), q({ depth: 1 }), q({ depth: MAX_DEPTH })];
    for (const previous of cases) {
      const out = normaliseSimplified({ question: "x?", options: [] }, previous);
      expect(out.allowOther || out.options.length >= 2).toBe(true);
    }
  });

  it("the terminal question needs no product knowledge to answer", () => {
    const t = terminalQuestion("q3", "which button you pressed");
    expect(t.allowOther).toBe(true);
    expect(t.options).toEqual([]);
    expect(t.depth).toBe(MAX_DEPTH);
  });
});

describe("answers", () => {
  it("is incomplete until every question has one", () => {
    const questions = [q(), q({ id: "q2" })];
    expect(answersComplete(questions, [])).toBe(false);
    expect(answersComplete(questions, [{ id: "q1", question: "", answer: "Reject", depth: 0 }])).toBe(false);
    expect(
      answersComplete(questions, [
        { id: "q1", question: "", answer: "Reject", depth: 0 },
        { id: "q2", question: "", answer: "Discard", depth: 0 },
      ])
    ).toBe(true);
  });

  it("treats whitespace as unanswered", () => {
    expect(answersComplete([q()], [{ id: "q1", question: "", answer: "   ", depth: 0 }])).toBe(false);
  });

  it("is false with no questions, so an empty set never counts as done", () => {
    expect(answersComplete([], [])).toBe(false);
  });

  it("ignores answers to questions that were never asked", () => {
    const out = collectAnswers([q()], [
      { id: "q1", answer: "Reject" },
      { id: "q9", answer: "injected" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].answer).toBe("Reject");
  });

  it("carries the depth through to the brief", () => {
    const out = collectAnswers([q({ depth: 2 })], [{ id: "q1", answer: "dunno" }]);
    expect(out[0].depth).toBe(2);
  });
});

describe("normaliseBrief", () => {
  const good = {
    title: "Stop rejected leads reappearing on the priority list",
    request_class: "bug",
    severity: "major",
    prior_art_kind: "none",
    prior_art_detail: "",
    understanding: "Rejected leads still rank in the priority feed.",
    could_not_determine: ["Whether it survives a refresh."],
    acceptance_criteria: ["A rejected lead never appears in the priority list."],
    files_to_look_at: ["src/lib/leadOrder.ts"],
    claude_sections: [4, 5],
    invariants_at_risk: ["4. Every delivered lead is chargeable."],
    plan_considerations: "Both products.",
    needs_migration: false,
    out_of_scope: [],
    open_questions: [],
  };

  it("accepts a well-formed brief", () => {
    expect(normaliseBrief(good)?.title).toBe(good.title);
  });

  it("rejects one with no understanding, rather than rendering an empty prompt", () => {
    expect(normaliseBrief({ ...good, understanding: "" })).toBeNull();
    expect(normaliseBrief({ ...good, title: "  " })).toBeNull();
    expect(normaliseBrief("nope")).toBeNull();
  });

  it("discards invented enum values instead of writing them to a CHECK-constrained column", () => {
    // 0134 constrains `severity`. An invented value would fail the insert and
    // lose the whole synthesis, so it is dropped here.
    const out = normaliseBrief({ ...good, severity: "apocalyptic", request_class: "wat" });
    expect(out?.severity).toBeNull();
    expect(out?.request_class).toBe("bug");
  });

  it("drops nonsense section numbers", () => {
    const out = normaliseBrief({ ...good, claude_sections: [4, -1, 0, 9999, 4, "x"] });
    expect(out?.claude_sections).toEqual([4]);
  });

  it("coerces needs_migration rather than trusting a truthy string", () => {
    expect(normaliseBrief({ ...good, needs_migration: "yes" })?.needs_migration).toBe(false);
    expect(normaliseBrief({ ...good, needs_migration: true })?.needs_migration).toBe(true);
  });
});
