import type Anthropic from "@anthropic-ai/sdk";
import { productContext } from "./productContext";
import { MAX_DEPTH, MAX_OPTIONS, MAX_QUESTIONS, MIN_OPTIONS, MIN_QUESTIONS } from "./schemas";
import type { Answer, Question } from "./schemas";

/**
 * What Claude is told, and in what order.
 *
 * ⚠️ THE ORDER IS A CACHING DECISION, NOT A STYLISTIC ONE. `productContext()`
 * is roughly 3,000 tokens and is IDENTICAL on every call of all three kinds, so
 * it goes first with the cache breakpoint immediately after it. Everything that
 * varies — the customer, their words, the ticket history — goes in the user
 * turn. Move one varying byte above the breakpoint and every request pays full
 * price for the pack. `usage.cache_read_input_tokens` is how you check.
 */

/**
 * The pack, then the task, with the breakpoint between them.
 *
 * Typed as the SDK's own block type rather than an inferred literal, so a
 * `cache_control` that drifts to the wrong block is a type error rather than a
 * silent cache miss.
 */
export function systemFor(instructions: string): Anthropic.TextBlockParam[] {
  return [
    { type: "text", text: productContext(), cache_control: { type: "ephemeral" } },
    { type: "text", text: instructions },
  ];
}

// --------------------------------------------------------------------------
// Asking
// --------------------------------------------------------------------------

/**
 * ⚠️ THE ANTI-PATTERNS ARE THE IMPORTANT HALF OF THIS PROMPT. Anyone can get a
 * model to produce five questions. The failure that kills the feature is five
 * questions that are annoying to answer, and every rule below is a specific
 * shape of annoying that was going to happen by default.
 */
export const QUESTIONS_INSTRUCTIONS = [
  "# Your job",
  "",
  "A customer of the product above has just reported a bug or asked for a feature.",
  "You are going to ask them a few questions so that an engineer can act on it",
  "without a follow-up conversation. Their answers become the specification.",
  "",
  `Return between ${MIN_QUESTIONS} and ${MAX_QUESTIONS} questions, each with ${MIN_OPTIONS} to ${MAX_OPTIONS} options they can tap.`,
  "",
  "# What makes a good question here",
  "",
  "- Ask what an engineer cannot work out for themselves from the report and the account state.",
  "- Use the literal words the customer would have seen on screen. You have the screen list above; use it.",
  "- Prefer a concrete choice over an open question. 'Which of these did you press?' beats 'what did you do?'.",
  "- Ask what 'working' would look like to them. That answer becomes the acceptance criteria, so it is usually the most valuable question you will ask.",
  "- Where the glossary shows one customer phrase maps to several different things in the product, resolving which one they mean is worth a question on its own.",
  "",
  "# Never do these",
  "",
  "- Never ask something they already told you. Re-read their words first.",
  "- Never ask something the account state already answers. You can see their balance, their plan and their products.",
  "- Never ask about a screen they cannot see. The account state says which products they hold.",
  "- Never ask for a browser version, an operating system, a console error or a network log. They will not know and will feel stupid for not knowing.",
  "- Never ask two things in one question. Split them.",
  "- Never ask them to reproduce it on demand.",
  "- Never pad. Three good questions are better than five, and you are not scored on length.",
  "",
  "# Classifying it",
  "",
  "Judge `request_class` from the account state as much as the words. Someone",
  "sitting at zero credits reporting that leads have stopped is describing",
  "correct behaviour they do not understand: that is `plan_or_billing`, not",
  "`bug`, and your questions should follow that reading rather than hunting for",
  "a fault that is not there.",
  "",
  "Read the invariants above before deciding anything is broken. Several of the",
  "most-reported 'bugs' in this product are deliberate behaviour.",
].join("\n");

export function questionsUser(params: {
  kind: string;
  summary: string;
  body: string;
  page: string | null;
  account: string;
}): string {
  return [
    "# This customer's account, right now",
    "",
    params.account,
    "",
    "# What they submitted",
    "",
    `They chose: ${params.kind === "bug" ? "something is broken" : "I would like something new"}`,
    params.page ? `They were on: ${params.page}` : "They did not say which screen.",
    "",
    "Summary they typed:",
    params.summary,
    "",
    "Detail they typed:",
    params.body,
  ].join("\n");
}

// --------------------------------------------------------------------------
// Simplifying
// --------------------------------------------------------------------------

/**
 * ⚠️ THERE IS NO SKIP BUTTON, AND THIS PROMPT IS WHY THAT IS FAIR.
 *
 * A customer who cannot answer a compulsory question is stuck, so "I'm not sure"
 * has to lead somewhere. It leads here. The code guarantees the ladder
 * terminates (`normaliseSimplified`); this prompt is what makes the middle rung
 * actually easier rather than merely different.
 */
export const SIMPLIFY_INSTRUCTIONS = [
  "# Your job",
  "",
  "A customer could not answer one of your questions. Ask it again, more simply.",
  "",
  "They cannot skip it — there is no skip control — so this must end up",
  "answerable. Getting a rough answer is worth far more than getting none.",
  "",
  "# How to actually simplify something",
  "",
  "- Do NOT rephrase with synonyms. If they did not understand it, different words for the same idea will not help.",
  "- Either make the options CONCRETE, or split the decision into the single easier half you most need.",
  "- Prefer the literal wording on the screen over a description of it.",
  "- Prefer a yes/no pair over a multiple choice.",
  "- Never introduce a word or a concept they have not already been shown.",
  "- Assume they do not know what anything in the product is called.",
  "",
  `A question may be simplified ${MAX_DEPTH} times. At the last step it must be`,
  "answerable by someone with no technical knowledge and no memory of the",
  "details — a yes/no, or an invitation to say it however they like.",
].join("\n");

export function simplifyUser(params: {
  question: Question;
  summary: string;
  body: string;
  account: string;
}): string {
  return [
    "# The question they could not answer",
    "",
    params.question.question,
    params.question.options.length ? `Options offered: ${params.question.options.join(" / ")}` : "",
    `This is simplification attempt ${params.question.depth + 1} of ${MAX_DEPTH}.`,
    "",
    "# What they originally reported",
    "",
    params.summary,
    params.body,
    "",
    "# Their account",
    "",
    params.account,
  ]
    .filter(Boolean)
    .join("\n");
}

// --------------------------------------------------------------------------
// Synthesising
// --------------------------------------------------------------------------

/**
 * ⚠️ THIS DOES NOT WRITE THE PROMPT. It fills in a structured brief and
 * `render.ts` lays the prompt out. Asking for fifteen sections of markdown gets
 * you twelve, and the three that go missing are always the dull ones — tests,
 * migration order, invariants — which are exactly the ones that decide whether
 * the resulting build is green.
 */
export const SYNTHESIS_INSTRUCTIONS = [
  "# Your job",
  "",
  "Turn one customer request, and the answers they gave, into a brief that an",
  "engineer can implement from without asking them anything further.",
  "",
  "You are writing for someone who knows this codebase well and has never seen",
  "this request. Be concrete. Do not restate the complaint as though it were",
  "analysis.",
  "",
  "# The fields that matter most",
  "",
  "- `could_not_determine` — be honest. An empty list should be rare, and a confident brief built on a guess is worse than an uncertain one. If the answers left something open, say so.",
  "- `files_to_look_at` — ONLY paths from the screen list above. Never invent a path, never guess at one that looks plausible. An empty list is better than a wrong one.",
  "- `invariants_at_risk` — quote any numbered invariant this change comes near. Several of this product's most-reported bugs are deliberate, and this field is what stops one being helpfully undone.",
  "- `acceptance_criteria` — draw them from what the customer said 'working' would look like, not from what you would have asked for.",
  "- `prior_art_kind` — check the recent tickets and the deferred decisions before you assume this is new. If it already shipped, say so: that makes it a regression or a discoverability failure, which is a completely different task.",
  "- `plan_considerations` — the two products are fully parallel. Say whether both need this, and whether it should be gated by tier.",
  "",
  "# Severity",
  "",
  "Null unless it is a bug. `blocker` means they cannot do the core job at all;",
  "reserve it. Most things are `minor`.",
].join("\n");

export function synthesisUser(params: {
  kind: string;
  summary: string;
  body: string;
  page: string | null;
  account: string;
  answers: Answer[];
  history: string;
}): string {
  const qa = params.answers.length
    ? params.answers
        .map(
          (a) =>
            `Q: ${a.question}\nA: ${a.answer}${
              a.depth > 0
                ? `\n(they needed this question simplified ${a.depth} time(s) — they did not follow the wording)`
                : ""
            }`
        )
        .join("\n\n")
    : "They were not asked any questions.";

  return [
    "# This customer's account",
    "",
    params.account,
    "",
    "# What they submitted",
    "",
    `Type: ${params.kind}`,
    params.page ? `Screen: ${params.page}` : "Screen: not stated",
    "",
    "Summary:",
    params.summary,
    "",
    "Detail:",
    params.body,
    "",
    "# What they said when asked",
    "",
    qa,
    "",
    "# Requests already on file",
    "",
    "Check these before deciding this is new work.",
    "",
    params.history,
  ].join("\n");
}
