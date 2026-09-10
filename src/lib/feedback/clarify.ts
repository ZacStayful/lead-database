import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  QUESTIONS_INSTRUCTIONS,
  SIMPLIFY_INSTRUCTIONS,
  SYNTHESIS_INSTRUCTIONS,
  questionsUser,
  simplifyUser,
  synthesisUser,
  systemFor,
} from "./prompts";
import {
  BriefSchema,
  QuestionSetSchema,
  SimplifiedQuestionSchema,
  normaliseBrief,
  normaliseQuestions,
  normaliseSimplified,
  terminalQuestion,
  type Answer,
  type Brief,
  type Question,
  type RequestClass,
} from "./schemas";

/**
 * The three model calls, and the contract that makes them safe to depend on.
 *
 * This is the second model call site in the codebase and it inherits
 * `claudeMapping.ts`'s contract wholesale, because the reasoning is identical:
 *
 *   1. IT ONLY EVER PROPOSES. Questions are shown to the customer, who answers
 *      them or asks for something simpler. The brief is shown to an engineer,
 *      who reads it before writing code. Nothing here decides anything.
 *   2. IT ALWAYS DEGRADES. No API key, a timeout, a network failure, malformed
 *      output — every one of them ends with the ticket logged and emailed
 *      exactly as it would have been before this feature existed. A customer
 *      must never be unable to report a problem because a model was
 *      unreachable, and 0133 already guarantees the row lands first.
 *   3. NOTHING IT RETURNS IS TRUSTED VERBATIM. Everything goes through the pure
 *      validators in `schemas.ts` before it is rendered or written to a
 *      CHECK-constrained column.
 *
 * ⚠️ NO FUNCTION HERE THROWS. Callers are request handlers on the customer's
 * critical path; a rejected promise anywhere in this file is a bug.
 */

/** The customer is looking at a spinner. */
const QUESTIONS_TIMEOUT_MS = 25_000;
/** One question, a much smaller prompt, and they are mid-form. */
const SIMPLIFY_TIMEOUT_MS = 15_000;
/** Runs after they have committed. Quality matters more than speed. */
const SYNTHESIS_TIMEOUT_MS = 90_000;

export const CLARIFY_MODEL = "claude-opus-5";

export function isClarifyConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function client(timeout: number): Anthropic {
  return new Anthropic({ timeout });
}

/** One place to log a failure, so no branch quietly forgets to. */
function swallow(where: string, error: unknown): null {
  // Never log prompt or response bodies — `contactValidation.ts`'s PII rule
  // applies to a model call as much as to a lookup, and these prompts carry a
  // customer's own words about their business.
  console.error(`feedback/clarify: ${where} failed, degrading`, error);
  return null;
}

export type QuestionSet = { requestClass: RequestClass; questions: Question[] };

/**
 * Generate the questions. Null means "ask nothing and send it through".
 */
export async function generateQuestions(params: {
  kind: string;
  summary: string;
  body: string;
  page: string | null;
  account: string;
}): Promise<QuestionSet | null> {
  if (!isClarifyConfigured()) return null;
  try {
    const response = await client(QUESTIONS_TIMEOUT_MS).messages.parse({
      model: CLARIFY_MODEL,
      max_tokens: 4000,
      system: systemFor(QUESTIONS_INSTRUCTIONS),
      // The customer is waiting, and picking three good questions is a
      // well-specified judgement rather than a hard problem.
      output_config: { effort: "low", format: zodOutputFormat(QuestionSetSchema) },
      messages: [{ role: "user", content: questionsUser(params) }],
    });
    return normaliseQuestions(response.parsed_output);
  } catch (error) {
    return swallow("generateQuestions", error);
  }
}

/**
 * Ask one question again, more simply.
 *
 * ⚠️ NEVER RETURNS NULL. There is no skip control, so a customer who taps "not
 * sure" and gets nothing back would be stuck in front of a compulsory question.
 * Every failure path lands on the terminal free-text form, which anyone can
 * answer.
 */
export async function simplifyQuestion(params: {
  question: Question;
  summary: string;
  body: string;
  account: string;
}): Promise<Question> {
  const floor = terminalQuestion(params.question.id, params.question.question);
  if (!isClarifyConfigured()) return floor;
  try {
    const response = await client(SIMPLIFY_TIMEOUT_MS).messages.parse({
      model: CLARIFY_MODEL,
      max_tokens: 1500,
      system: systemFor(SIMPLIFY_INSTRUCTIONS),
      output_config: { effort: "low", format: zodOutputFormat(SimplifiedQuestionSchema) },
      messages: [{ role: "user", content: simplifyUser(params) }],
    });
    return normaliseSimplified(response.parsed_output, params.question);
  } catch (error) {
    swallow("simplifyQuestion", error);
    return floor;
  }
}

/**
 * Turn the request and its answers into a brief. Null means the ticket stays
 * as it is and the sweeper retries later.
 */
export async function synthesiseBrief(params: {
  kind: string;
  summary: string;
  body: string;
  page: string | null;
  account: string;
  answers: Answer[];
  history: string;
}): Promise<Brief | null> {
  if (!isClarifyConfigured()) return null;
  try {
    const response = await client(SYNTHESIS_TIMEOUT_MS).messages.parse({
      model: CLARIFY_MODEL,
      max_tokens: 8000,
      system: systemFor(SYNTHESIS_INSTRUCTIONS),
      // Default effort. This one runs after the customer has committed, it is
      // the deliverable, and it is the only call where thinking earns its cost.
      output_config: { format: zodOutputFormat(BriefSchema) },
      messages: [{ role: "user", content: synthesisUser(params) }],
    });
    return normaliseBrief(response.parsed_output);
  } catch (error) {
    return swallow("synthesiseBrief", error);
  }
}
