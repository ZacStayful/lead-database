import { z } from "zod";
import { AD_TEMPLATE_IDS } from "./templates";
import { AD_MAX_DEPTH } from "./copy";

/**
 * What the model may return, and the pure functions that make it safe to
 * render (§65).
 *
 * ⚠️ COPIED FROM `src/lib/feedback/schemas.ts`, NOT EXTRACTED FROM IT. §50's
 * ladder has never run in production — all ten tickets carry `ai_status =
 * null` — so there is no shared behaviour to preserve, only shared shapes, and
 * the constants genuinely differ (see the budget below). Converging the two is
 * a Deferred item for once both have actually run.
 *
 * ⚠️ NOTHING THE MODEL RETURNS BRANCHES ANY CODE. `template_id` is checked
 * against the union and falls back; options are rendered as text. A
 * hallucination costs a slightly worse ad, never a wrong code path.
 */

export const MAX_DEPTH = AD_MAX_DEPTH;
export const MIN_QUESTIONS = 3;
export const MAX_QUESTIONS = 8;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_ANSWER_LENGTH = 600;

/**
 * ⚠️ THE SIMPLIFY BUDGET SCALES WITH THE QUESTION COUNT, and §50's flat
 * `MAX_DEPTH * 3 = 6` breaks twice if copied straight across.
 *
 * A template can ask eight slot questions where a support ticket asks three,
 * so a flat six is exhausted by the first four rewordings — and §50 can
 * tolerate running out because the ticket still sends unclarified. An ad with
 * no answers cannot be built at all.
 */
export function maxSimplify(questionCount: number): number {
  return MAX_DEPTH * Math.max(1, Math.ceil(questionCount / 2));
}

export type Question = {
  id: string;
  question: string;
  options: string[];
  allowOther: boolean;
  depth: number;
  /**
   * ⚠️ WHICH SLOT THIS ANSWER FILLS, AND IT IS THE ONLY LINK BETWEEN THE CHAT
   * AND THE PROFILE. Without it an answer is prose nobody can file, so a
   * second ad would ask every question again — which is exactly the
   * promise the setup/ad slot split makes. `profile.ts` checks it against a
   * closed list before writing anything, because this string came from a model.
   */
  slot: string;
  /**
   * ⚠️ WHAT THEY ANSWERED, STORED BESIDE THE QUESTION IT ANSWERS.
   *
   * Nothing else persists an answer, and without it "Rewrite the words" has
   * nothing to rewrite from — it would have to ask every question again, which
   * is not what that button says. One array means one compare-and-swap, so a
   * simplify still in flight cannot resurrect a question over a filed answer.
   * §50's simplify route already keeps the answer across a rewording for the
   * same reason.
   */
  answer?: string;
  /**
   * ⚠️ MODEL CALLS ACTUALLY MADE, NOT THE DEPTH. §50 spends its budget by
   * summing depth, which charges TWO UNITS FOR ZERO MODEL CALLS every time a
   * question drops straight to terminal — no key, a timeout, the budget
   * already gone. Counting calls is exact, is derived from the stored
   * questions exactly as the depth was, and cannot drift from what was spent.
   */
  calls: number;
};

export type Answer = { id: string; question: string; answer: string; depth: number };

export function simplifySpent(questions: Question[]): number {
  return questions.reduce((n, q) => n + (Number.isFinite(q.calls) ? Math.max(0, q.calls) : 0), 0);
}

export function canSimplify(questions: Question[]): boolean {
  return simplifySpent(questions) < maxSimplify(questions.length);
}

// ---------------------------------------------------------------------------
// What the model is asked for
// ---------------------------------------------------------------------------

export const QuestionSchema = z.object({
  question: z
    .string()
    .describe("One question, in the operator's own language. Never two joined by 'and'."),
  options: z
    .array(z.string())
    .describe("Two to four concrete answers they can tap. Use words they would recognise from their own business."),
  allow_other: z
    .boolean()
    .describe("True when a short typed answer would add something the options cannot capture."),
  slot: z
    .string()
    .describe("Which slot key this question fills, exactly as given in the list of what is missing. Empty string if none."),
});

export const QuestionSetSchema = z.object({
  template_id: z
    .enum(AD_TEMPLATE_IDS)
    .describe("Which of the four templates fits what they asked for and what their account already knows."),
  reason: z
    .string()
    .describe("One sentence, addressed to the operator, saying why this angle suits them. Not a description of the template."),
  questions: z
    .array(QuestionSchema)
    .describe("Only what is genuinely missing. Three to eight. Fewer is better."),
});

export const SimplifiedQuestionSchema = z.object({
  question: z.string().describe("The same thing asked more simply, or one half of the original decision."),
  options: z.array(z.string()).describe("Concrete answers. Two is better than four here."),
  allow_other: z.boolean(),
});

/**
 * ⚠️ THE MODEL WRITES THE ON-IMAGE HEADLINE NOW TOO.
 *
 * It used to be slot substitution and the model was told, in capitals, that it
 * did not write it. That made "no invented figure" structurally impossible
 * rather than merely checked — but it also meant every "what would it earn" ad
 * in the country carried the identical sub-line, and the model, handed four
 * fixed fields and asked for three more, had nowhere to go but restating them.
 * The first real ad said the same thing four times over.
 *
 * The figure rules run over these two as well, so an invented number is still
 * refused; the safety is a check rather than an impossibility. The spec's own
 * headline and sub are shown as the register to write in, and remain the
 * fallback.
 */
export const AdVariantSchema = z.object({
  angle_key: z
    .string()
    .describe("The key of the angle this text takes, exactly as listed in the brief."),
  message: z
    .string()
    .describe("The primary text, above the image. Name the audience and the service early."),
  headline: z
    .string()
    .describe("Meta's headline, under the image. Aim for 40 characters so it is not shortened."),
  description: z
    .string()
    .describe("Meta's description, beneath the headline. Aim for 30 characters."),
});

export const AdCopySchema = z.object({
  image_headline: z
    .string()
    .describe(
      "The headline drawn ON the image. Wrap one short span in *asterisks* to emphasise it."
    ),
  image_sub: z
    .string()
    .describe("The line under it on the image. One sentence, concrete."),
  /**
   * ⚠️ NOT `.length(5)`. `angleListFor()` drops T8's quote angle when no review
   * has been confirmed, so a template can legitimately offer four — and a
   * schema demanding five would fail every T8 run for a customer without a
   * quote. The count is checked against what was actually OFFERED, in the
   * validator, where the template is in hand.
   */
  variants: z
    .array(AdVariantSchema)
    .describe("One primary text per angle offered, each committing to that angle alone."),
});

// ---------------------------------------------------------------------------
// Making it safe to render
// ---------------------------------------------------------------------------

function clean(value: unknown, cap = 300): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, cap) : "";
}

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
 * defensible because the bottom of the ladder is always answerable: a text box
 * needs no vocabulary and no certainty.
 */
export function terminalQuestion(
  id: string,
  subject: string,
  calls: number,
  slot = ""
): Question {
  return {
    id,
    question: `In your own words: ${subject}`,
    options: [],
    allowOther: true,
    // ⚠️ THE SLOT SURVIVES THE LADDER. An operator who could not follow the
    // question still answers the same thing, and dropping it here would file
    // their answer nowhere — so the people who needed help would be the ones
    // asked again next time.
    slot,
    depth: MAX_DEPTH,
    calls,
  };
}

export function normaliseQuestions(raw: unknown): { templateId: string | null; reason: string; questions: Question[] } | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;

  const templateId = (AD_TEMPLATE_IDS as readonly string[]).includes(body.template_id as string)
    ? (body.template_id as string)
    : null;

  if (!Array.isArray(body.questions)) return null;

  const questions: Question[] = [];
  const seen = new Set<string>();
  for (const entry of body.questions) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const text = clean(e.question, 200);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;

    const options = cleanList(e.options, 80, MAX_OPTIONS);
    const allowOther = options.length < MIN_OPTIONS ? true : e.allow_other === true;

    seen.add(key);
    questions.push({
      id: `q${questions.length + 1}`,
      question: text,
      options: options.length >= MIN_OPTIONS ? options : [],
      allowOther,
      slot: clean(e.slot, 40),
      depth: 0,
      calls: 0,
    });
    if (questions.length >= MAX_QUESTIONS) break;
  }

  if (!questions.length) return null;
  return { templateId, reason: clean(body.reason, 300), questions };
}

/**
 * ⚠️ TERMINALITY IS ENFORCED HERE, NOT ASKED FOR. The prompt tells the model
 * that depth 2 must be answerable by anyone; this guarantees it. A model
 * returning another four-way choice at the bottom would strand a customer in
 * front of a compulsory question with no skip, which is the one state this
 * feature must never produce.
 */
export function normaliseSimplified(raw: unknown, previous: Question, billed: boolean): Question {
  const calls = previous.calls + (billed ? 1 : 0);
  const depth = Math.min(previous.depth + 1, MAX_DEPTH);
  if (depth >= MAX_DEPTH) return terminalQuestion(previous.id, previous.question, calls, previous.slot);

  if (!raw || typeof raw !== "object")
    return terminalQuestion(previous.id, previous.question, calls, previous.slot);
  const e = raw as Record<string, unknown>;
  const text = clean(e.question, 200);
  if (!text) return terminalQuestion(previous.id, previous.question, calls, previous.slot);

  const options = cleanList(e.options, 80, MAX_OPTIONS);
  return {
    id: previous.id,
    question: text,
    options: options.length >= MIN_OPTIONS ? options : [],
    allowOther: options.length < MIN_OPTIONS ? true : e.allow_other === true,
    // ⚠️ NEVER FROM THE REWORDED OUTPUT. The simplify prompt is told it is the
    // SAME question asked better; letting it re-declare the slot would let a
    // rewording quietly file the answer somewhere else.
    slot: previous.slot,
    depth,
    calls,
  };
}

/** Every question answered. The submit control is gated on this. */
export function answersComplete(questions: Question[], answers: Answer[]): boolean {
  if (!questions.length) return false;
  const byId = new Map(answers.map((a) => [a.id, a.answer.trim()]));
  return questions.every((q) => (byId.get(q.id) ?? "").length > 0);
}

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
