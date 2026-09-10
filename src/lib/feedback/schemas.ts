import { z } from "zod";

/**
 * The shapes the model may return, and the pure functions that make its output
 * safe to render.
 *
 * ⚠️ THE SCHEMA IS FIXED, THE CONTENT IS GENERATED. That distinction is the
 * whole design. Every question a customer sees is written for their submission
 * — there is no question bank — but the number of questions, the number of
 * options, the depth of simplification and the terminal fallback are all
 * decided here, in code, where they can be tested and cannot be talked out of.
 *
 * ⚠️ NOTHING THE MODEL RETURNS BRANCHES ANY CODE. Options are rendered as text
 * and the chosen answer is fed back into the synthesis prompt. A hallucinated
 * option costs a slightly worse brief; it can never take a wrong code path.
 * This is `claudeMapping.ts`'s third contract point, restated for this feature.
 */

/** Three good questions beat five padded ones, and five is where a form starts to feel like work. */
export const MIN_QUESTIONS = 3;
export const MAX_QUESTIONS = 5;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;

/**
 * How many times one question may be simplified before it must become
 * answerable by anyone. Two, because the ladder has to terminate somewhere and
 * a customer tapping "not sure" three times is telling you the question was
 * never the problem.
 */
export const MAX_DEPTH = 2;

/** Total simplify calls one ticket may spend. Past this, questions drop straight to terminal. */
export const MAX_SIMPLIFY_PER_TICKET = 6;

export const MAX_ANSWER_LENGTH = 600;

export const REQUEST_CLASSES = [
  "bug",
  "feature",
  "plan_or_billing",
  "support_question",
] as const;
export type RequestClass = (typeof REQUEST_CLASSES)[number];

export const SEVERITIES = ["blocker", "major", "minor", "cosmetic"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const PRIOR_ART_KINDS = ["none", "duplicate", "shipped", "deferred"] as const;
export type PriorArtKind = (typeof PRIOR_ART_KINDS)[number];

// --------------------------------------------------------------------------
// Questions
// --------------------------------------------------------------------------

export const QuestionSchema = z.object({
  question: z
    .string()
    .describe("One question, in the customer's own language. Never two questions joined by 'and'."),
  options: z
    .array(z.string())
    .describe("Two to four concrete answers they can tap. Use the literal words they would have seen on screen."),
  allow_other: z
    .boolean()
    .describe("True when a short typed answer would add something the options cannot capture."),
});

export const QuestionSetSchema = z.object({
  request_class: z
    .enum(REQUEST_CLASSES)
    .describe(
      "What this actually is, judged from the account state as much as the words. Someone at zero credits reporting no leads is plan_or_billing, not bug."
    ),
  questions: z
    .array(QuestionSchema)
    .describe("Three to five questions. Fewer, if the report is already clear."),
});

export const SimplifiedQuestionSchema = z.object({
  question: z.string().describe("The same thing asked more simply, or one half of the original decision."),
  options: z.array(z.string()).describe("Concrete answers. Two is better than four here."),
  allow_other: z.boolean(),
});

export type Question = {
  id: string;
  question: string;
  options: string[];
  allowOther: boolean;
  depth: number;
};

/** What the customer sent back. `depth` is how far the question was simplified before they answered. */
export type Answer = { id: string; question: string; answer: string; depth: number };

// --------------------------------------------------------------------------
// The brief
// --------------------------------------------------------------------------

export const BriefSchema = z.object({
  title: z.string().describe("A short imperative title for the work. Not a restatement of the complaint."),
  request_class: z.enum(REQUEST_CLASSES),
  severity: z
    .enum(SEVERITIES)
    .nullable()
    .describe("Null for anything that is not a bug."),
  prior_art_kind: z
    .enum(PRIOR_ART_KINDS)
    .describe(
      "Whether an earlier ticket or a CLAUDE.md §12 entry already covers this. 'shipped' means it exists and they could not find it, which is a different bug entirely."
    ),
  prior_art_detail: z
    .string()
    .describe("One or two sentences naming the ticket reference or § entry. Empty string when prior_art_kind is 'none'."),
  understanding: z.string().describe("What the problem or request actually is, in plain prose."),
  could_not_determine: z
    .array(z.string())
    .describe("What remains genuinely unknown after the answers. Be honest; an empty list should be rare."),
  acceptance_criteria: z
    .array(z.string())
    .describe("Checkable statements. Draw them from what the customer said 'working' would look like."),
  files_to_look_at: z
    .array(z.string())
    .describe("Real repository paths, taken from the screen list you were given. Never invent one."),
  claude_sections: z
    .array(z.number())
    .describe("CLAUDE.md section numbers to read first."),
  invariants_at_risk: z
    .array(z.string())
    .describe(
      "Quote any numbered invariant this change comes near. An empty list is correct when it comes near none."
    ),
  plan_considerations: z
    .string()
    .describe("Ship to everyone or gate by tier, and whether both products need it. Invariant 6 applies."),
  needs_migration: z.boolean(),
  out_of_scope: z.array(z.string()),
  open_questions: z.array(z.string()).describe("What the person implementing this should decide, not guess."),
});

export type Brief = z.infer<typeof BriefSchema>;

// --------------------------------------------------------------------------
// Making model output safe to render
// --------------------------------------------------------------------------

function clean(value: unknown, cap = 300): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, cap) : "";
}

/** Distinct, non-empty, capped. Used for both options and the brief's list fields. */
function cleanList(value: unknown, cap: number, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    const text = clean(item, cap);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * The question every ladder ends at.
 *
 * ⚠️ THIS IS WHY THERE IS NO SKIP BUTTON. Removing the escape hatch is only
 * defensible because the bottom of the ladder is always answerable: a free-text
 * box needs no product knowledge, no vocabulary and no certainty, and whatever
 * they type is worth more than the silence a skip would have produced.
 */
export function terminalQuestion(id: string, subject: string): Question {
  return {
    id,
    question: `In your own words: ${subject}`,
    options: [],
    allowOther: true,
    depth: MAX_DEPTH,
  };
}

/**
 * Turn a model question set into something renderable, or null.
 *
 * Null means degrade: the caller sends the ticket on unclarified rather than
 * showing a broken form.
 */
export function normaliseQuestions(raw: unknown): { requestClass: RequestClass; questions: Question[] } | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;

  const requestClass = REQUEST_CLASSES.includes(body.request_class as RequestClass)
    ? (body.request_class as RequestClass)
    : "bug";

  if (!Array.isArray(body.questions)) return null;

  const questions: Question[] = [];
  const seen = new Set<string>();
  for (const entry of body.questions) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const text = clean(e.question, 200);
    if (!text) continue;
    // A model that asks the same thing twice has lost the thread; keep the first.
    const key = text.toLowerCase();
    if (seen.has(key)) continue;

    const options = cleanList(e.options, 80, MAX_OPTIONS);
    // Fewer than two options is not a choice. Rather than drop the question —
    // it may be the most useful one — turn it into a typed answer.
    const allowOther = options.length < MIN_OPTIONS ? true : e.allow_other === true;

    seen.add(key);
    questions.push({
      id: `q${questions.length + 1}`,
      question: text,
      options: options.length >= MIN_OPTIONS ? options : [],
      allowOther,
      depth: 0,
    });
    if (questions.length >= MAX_QUESTIONS) break;
  }

  if (!questions.length) return null;
  return { requestClass, questions };
}

/**
 * A simplified replacement for one question.
 *
 * ⚠️ TERMINALITY IS ENFORCED HERE, NOT ASKED FOR. The prompt tells the model
 * that depth 2 must be answerable by anyone; this guarantees it. A model that
 * returns another four-way multiple choice at the bottom of the ladder would
 * otherwise leave a customer stuck in front of a compulsory question with no
 * skip button, which is the one state this feature must never produce.
 */
export function normaliseSimplified(raw: unknown, previous: Question): Question {
  const depth = Math.min(previous.depth + 1, MAX_DEPTH);
  if (depth >= MAX_DEPTH) return terminalQuestion(previous.id, previous.question);

  if (!raw || typeof raw !== "object") return terminalQuestion(previous.id, previous.question);
  const e = raw as Record<string, unknown>;
  const text = clean(e.question, 200);
  if (!text) return terminalQuestion(previous.id, previous.question);

  const options = cleanList(e.options, 80, MAX_OPTIONS);
  return {
    id: previous.id,
    question: text,
    options: options.length >= MIN_OPTIONS ? options : [],
    allowOther: options.length < MIN_OPTIONS ? true : e.allow_other === true,
    depth,
  };
}

/** Every question answered. The submit control is gated on this. */
export function answersComplete(questions: Question[], answers: Answer[]): boolean {
  if (!questions.length) return false;
  const byId = new Map(answers.map((a) => [a.id, a.answer.trim()]));
  return questions.every((q) => (byId.get(q.id) ?? "").length > 0);
}

/** Pair the questions with what came back, dropping anything unrecognised. */
export function collectAnswers(questions: Question[], raw: unknown): Answer[] {
  if (!Array.isArray(raw)) return [];
  const byId = new Map(questions.map((q) => [q.id, q]));
  const out: Answer[] = [];
  const used = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const id = clean(e.id, 16);
    const question = byId.get(id);
    if (!question || used.has(id)) continue;
    const answer = clean(e.answer, MAX_ANSWER_LENGTH);
    if (!answer) continue;
    used.add(id);
    out.push({ id, question: question.question, answer, depth: question.depth });
  }
  return out;
}

/** Clamp a model brief into something renderable. Never throws. */
export function normaliseBrief(raw: unknown): Brief | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  const title = clean(b.title, 160);
  const understanding = clean(b.understanding, 2000);
  if (!title || !understanding) return null;

  return {
    title,
    request_class: REQUEST_CLASSES.includes(b.request_class as RequestClass)
      ? (b.request_class as RequestClass)
      : "bug",
    severity: SEVERITIES.includes(b.severity as Severity) ? (b.severity as Severity) : null,
    prior_art_kind: PRIOR_ART_KINDS.includes(b.prior_art_kind as PriorArtKind)
      ? (b.prior_art_kind as PriorArtKind)
      : "none",
    prior_art_detail: clean(b.prior_art_detail, 500),
    understanding,
    could_not_determine: cleanList(b.could_not_determine, 300, 8),
    acceptance_criteria: cleanList(b.acceptance_criteria, 300, 12),
    files_to_look_at: cleanList(b.files_to_look_at, 200, 12),
    claude_sections: Array.isArray(b.claude_sections)
      ? Array.from(
          new Set(
            b.claude_sections
              .filter((n): n is number => typeof n === "number" && Number.isFinite(n))
              .map((n) => Math.trunc(n))
              .filter((n) => n > 0 && n < 1000)
          )
        ).slice(0, 8)
      : [],
    invariants_at_risk: cleanList(b.invariants_at_risk, 400, 6),
    plan_considerations: clean(b.plan_considerations, 800),
    needs_migration: b.needs_migration === true,
    out_of_scope: cleanList(b.out_of_scope, 300, 8),
    open_questions: cleanList(b.open_questions, 300, 8),
  };
}
