import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  COPY_INSTRUCTIONS,
  PROMPT_VERSIONS,
  QUESTIONS_INSTRUCTIONS,
  SIMPLIFY_INSTRUCTIONS,
  angleListFor,
  copyUser,
  questionsUser,
  simplifyUser,
  systemFor,
} from "./prompts";
import {
  AdCopySchema,
  QuestionSetSchema,
  SimplifiedQuestionSchema,
  normaliseQuestions,
  normaliseSimplified,
  terminalQuestion,
  type Answer,
  type Question,
} from "./schemas";
import { fallbackTemplate } from "./fallback";
import { answerableQuestion, answerableQuestions } from "./profile";
import { templateById, type AdTemplate } from "./templates";
import { validateAdCopy, type AdRejection, type ValidationContext } from "./validateAdCopy";
import type { AdCopy } from "./metaFields";
import type { GenerationKind, LedgerEntry } from "./ledger";

/**
 * The model calls (§65), and the contract that makes them safe to depend on.
 *
 * This is the fourth model call site in the codebase and it inherits
 * `claudeMapping.ts`'s contract wholesale:
 *
 *   1. IT ONLY EVER PROPOSES. Questions are shown to the operator, who answers
 *      them. Copy is shown to the operator, who reads it before publishing.
 *      Nothing here decides anything and nothing here publishes anything.
 *   2. IT ALWAYS DEGRADES. No API key, a timeout, malformed output, two
 *      rejections in a row — every one of them ends with a real questionnaire
 *      or the template's own default text, which is an advert we are content
 *      to have written.
 *   3. NOTHING IT RETURNS IS TRUSTED VERBATIM. Questions go through
 *      `normaliseQuestions`; copy goes through `validateAdCopy`, which
 *      REJECTS rather than repairs.
 *
 * ⚠️ NO FUNCTION HERE THROWS. Every caller is a request handler the operator
 * is watching a spinner on; a rejected promise in this file is a bug.
 *
 * ⚠️ AND NOTHING HERE WRITES TO THE DATABASE. Each call returns the ledger
 * rows it earned and the route persists them — which keeps this file pure
 * enough to unit test, and is why `adsRoutes.test.ts` asserts that every route
 * importing from here also calls `recordGenerations`.
 */

export const AD_MODEL = "claude-opus-5";

/**
 * ⚠️ `maxRetries: 0`, AND IT IS THE DIFFERENCE BETWEEN A BUDGET AND A WISH.
 * The SDK retries twice by default on a 429 or a 5xx, so a single "60-second"
 * call is really up to three of them plus backoff — which walks straight
 * through a 60-second function ceiling and gets killed mid-flight, leaving the
 * draft in `generating` with nobody to clear it. We do our own retry, once,
 * with a shorter timeout and a reason fed back.
 */
function client(timeout: number): Anthropic {
  return new Anthropic({ timeout, maxRetries: 0 });
}

/** The operator is watching a spinner, on a 60-second route. */
const QUESTIONS_TIMEOUT_MS = 25_000;
/** One question, a much smaller prompt, and they are mid-form. */
const SIMPLIFY_TIMEOUT_MS = 15_000;
/**
 * Runs on a 300-second route, after they have committed. The budget is
 * 60 + 45 with room to persist a failure well before the ceiling — a draft
 * stuck in `generating` because the lambda died is worse than a failed one.
 */
const COPY_TIMEOUT_MS = 60_000;
const COPY_RETRY_TIMEOUT_MS = 45_000;

/**
 * ⚠️ EXPLICIT ON EVERY CALL. Left to the SDK's default a long answer is
 * TRUNCATED, `messages.parse` then yields null, and the null becomes the
 * template's default text — so the failure presents as "the model wrote
 * something generic" rather than as an error. Generous, because the cost of
 * being wrong is silent.
 */
const MAX_TOKENS = {
  questions: 4_000,
  simplify: 1_500,
  /** Default effort, so this has to cover the thinking as well as the output. */
  copy: 8_000,
} as const;

export function isAdModelConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * ⚠️ NEVER LOGS A PROMPT OR A COMPLETION. `contactValidation.ts`'s PII rule
 * applies to a model call as much as to a lookup, and these prompts carry a
 * business's fee, its review score and whatever its owner typed into the box.
 * The provider's own error object is logged because it carries status codes
 * rather than bodies.
 */
function swallow(where: string, error: unknown): null {
  console.error(`ads/generate: ${where} failed, degrading`, error);
  return null;
}

/** What every call hands back for the route to persist. */
function entry(
  kind: GenerationKind,
  outcome: LedgerEntry["outcome"],
  extra: Partial<LedgerEntry> = {}
): LedgerEntry {
  return {
    kind,
    outcome,
    attempt: 1,
    modelId: null,
    promptVersion: null,
    rejectReason: null,
    cacheReadTokens: null,
    ...extra,
  };
}

/**
 * `usage.cache_read_input_tokens`, so the prompt cache is a measurement.
 *
 * ⚠️ ZERO AND NULL MEAN DIFFERENT THINGS and both are stored. Zero is a cache
 * MISS, which is the reading that would tell us the five-minute window is not
 * being hit; null is the provider not reporting, which tells us nothing.
 */
function cacheRead(usage: unknown): number | null {
  if (!usage || typeof usage !== "object") return null;
  const n = (usage as { cache_read_input_tokens?: unknown }).cache_read_input_tokens;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

export type QuestionSet = {
  template: AdTemplate;
  reason: string;
  questions: Question[];
  /** True when this came from `fallback.ts` rather than the model. */
  degraded: boolean;
  entries: LedgerEntry[];
};

/**
 * Pick a template and ask for what is missing.
 *
 * ⚠️ IT NEVER RETURNS NOTHING. §50 treats an empty question list as success —
 * the ticket still sends unclarified — and here it is a dead end, because an
 * advert with no answers cannot be built at all. Every degraded path lands on
 * `fallbackQuestionnaire`, which asks the same things in our own words.
 */
export async function generateQuestions(params: {
  prompt: string;
  account: string;
  /** Set by the switch route, which is asking for one template specifically. */
  forcedTemplate?: AdTemplate | null;
  fallback: () => Question[];
}): Promise<QuestionSet | null> {
  const kind: GenerationKind = params.forcedTemplate ? "template" : "questions";

  /**
   * ⚠️ NULL WHEN THE FALLBACK ASKS NOTHING, which is a real state rather than
   * a defensive one: a customer whose profile is already complete has nothing
   * missing, so `fallbackQuestionnaire` correctly returns an empty list. The
   * route reads null as "we could not ask, and there is nothing to ask" and
   * says so — rendering an empty form with a Send button would be worse than
   * any error message.
   */
  const degrade = (
    outcome: LedgerEntry["outcome"],
    extra?: Partial<LedgerEntry>
  ): QuestionSet | null => {
    const chosen = params.forcedTemplate
      ? { template: params.forcedTemplate, reason: "" }
      : fallbackTemplate();
    const questions = params.fallback();
    if (!questions.length) return null;
    return {
      template: chosen.template,
      reason: chosen.reason,
      questions,
      degraded: true,
      entries: [entry(kind, outcome, { promptVersion: PROMPT_VERSIONS.questions, ...extra })],
    };
  };

  if (!isAdModelConfigured()) return degrade("error", { rejectReason: "not_configured" });

  try {
    const response = await client(QUESTIONS_TIMEOUT_MS).messages.parse({
      model: AD_MODEL,
      max_tokens: MAX_TOKENS.questions,
      system: systemFor(QUESTIONS_INSTRUCTIONS),
      // Choosing an angle and three good questions is a well-specified
      // judgement, and the operator is waiting.
      output_config: { effort: "low", format: zodOutputFormat(QuestionSetSchema) },
      messages: [
        {
          role: "user",
          content: questionsUser({
            prompt: params.prompt,
            account: params.account,
            forcedTemplate: params.forcedTemplate ?? null,
          }),
        },
      ],
    });

    const parsed = normaliseQuestions(response.parsed_output);
    const common = {
      modelId: response.model,
      promptVersion: PROMPT_VERSIONS.questions,
      cacheReadTokens: cacheRead(response.usage),
    };

    if (!parsed) return degrade("error", { ...common, rejectReason: "unparseable" });

    // ⚠️ THE SWITCH ROUTE'S TEMPLATE WINS OVER THE MODEL'S. It is answering a
    // tap on a named angle; a model returning a different id there would
    // silently ignore what the operator just asked for.
    const template =
      params.forcedTemplate ??
      (parsed.templateId ? templateById(parsed.templateId) : null) ??
      fallbackTemplate().template;

    return {
      template,
      reason: parsed.reason || fallbackTemplate().reason,
      // ⚠️ FILTERED HERE, AT THE ONLY BOUNDARY THE MODEL'S QUESTIONS CROSS.
      // An option the slot cannot store must never be offered — that is what
      // produced "Message straight to my phone (WhatsApp or Messenger)" as an
      // answer to a URL, and then a refusal for the answer it had invited.
      questions: answerableQuestions(parsed.questions, template),
      degraded: false,
      entries: [entry(kind, "ok", common)],
    };
  } catch (error) {
    swallow("generateQuestions", error);
    return degrade("error", { rejectReason: "call_failed" });
  }
}

// ---------------------------------------------------------------------------
// Simplifying
// ---------------------------------------------------------------------------

export type SimplifyResult = { question: Question; entries: LedgerEntry[] };

/**
 * Ask one question again, more simply.
 *
 * ⚠️ NEVER RETURNS NULL, AND THAT IS WHY THERE IS NO SKIP BUTTON. An operator
 * who taps "not sure" and gets nothing back is stranded in front of a
 * compulsory question. Every failure lands on the terminal free-text form,
 * which anybody can answer.
 *
 * ⚠️ `billed` IS WHETHER A MODEL CALL WAS MADE, not whether it succeeded.
 * `Question.calls` is the simplify budget, and charging for a free
 * drop-to-terminal is §50's bug: it spends two units of budget on a path that
 * never reached the provider.
 */
export async function simplifyQuestion(params: {
  question: Question;
  account: string;
}): Promise<SimplifyResult> {
  if (!isAdModelConfigured()) {
    return {
      question: terminalQuestion(params.question.id, params.question.question, params.question.calls),
      entries: [
        entry("simplify", "error", {
          promptVersion: PROMPT_VERSIONS.simplify,
          rejectReason: "not_configured",
        }),
      ],
    };
  }

  try {
    const response = await client(SIMPLIFY_TIMEOUT_MS).messages.parse({
      model: AD_MODEL,
      max_tokens: MAX_TOKENS.simplify,
      system: systemFor(SIMPLIFY_INSTRUCTIONS),
      output_config: { effort: "low", format: zodOutputFormat(SimplifiedQuestionSchema) },
      messages: [{ role: "user", content: simplifyUser(params) }],
    });
    return {
      // Same filter on the simplify rung, which is where the bug happened: the
      // operator tapped "Not sure what this means?" and the reworded question
      // offered a destination the schema had no way to keep.
      question: answerableQuestion(
        normaliseSimplified(response.parsed_output, params.question, true)
      ),
      entries: [
        entry("simplify", "ok", {
          modelId: response.model,
          promptVersion: PROMPT_VERSIONS.simplify,
          cacheReadTokens: cacheRead(response.usage),
        }),
      ],
    };
  } catch (error) {
    swallow("simplifyQuestion", error);
    // ⚠️ A call that failed is still a call we made, so it is billed. The
    // budget exists to bound what we spend, not what we received.
    return {
      question: normaliseSimplified(null, params.question, true),
      entries: [
        entry("simplify", "error", {
          promptVersion: PROMPT_VERSIONS.simplify,
          rejectReason: "call_failed",
        }),
      ],
    };
  }
}

// ---------------------------------------------------------------------------
// The copy
// ---------------------------------------------------------------------------

export type CopyResult = {
  copy: AdCopy;
  /** True when both attempts were refused and this is the template's own text. */
  degraded: boolean;
  entries: LedgerEntry[];
};

/**
 * The template's own words, run through the same validator that refused the
 * model's.
 *
 * ⚠️ IT MUST PASS. `defaultPrimaryText`, `defaultHeadline` and
 * `defaultDescription` are written to name no service and state no figure
 * precisely so they survive a customer who has ticked nothing — and the unit
 * suite drives every default through `validateAdCopy` against an empty
 * selection. If one ever fails, this returns it anyway: an advert the operator
 * reads before publishing beats a blank page, and the ledger says it happened.
 */
export function defaultCopyFor(ctx: ValidationContext): AdCopy {
  const t = ctx.template;
  return {
    message: t.defaultPrimaryText,
    headline: t.defaultHeadline,
    description: t.defaultDescription,
    call_to_action_type: t.metaCta,
    link_url: ctx.slots.landing_url ?? "",
  };
}

/**
 * Write the advert: one attempt, one retry with the refusal fed back, then the
 * template's own text.
 *
 * ⚠️ THE RETRY IS TOLD WHY, IN ITS OWN TERMS. A bare "try again" produces the
 * same copy with different adjectives; "it stated a number the customer never
 * gave us" produces copy without the number. The mapping from our rejection
 * codes to that sentence lives in `prompts.ts`, so the code never reaches the
 * model and the sentence never reaches the ledger.
 */
export async function generateCopy(params: {
  ctx: ValidationContext;
  account: string;
  answers: Answer[];
  cta: string;
  figures: string[];
  previousMessage?: string | null;
}): Promise<CopyResult> {
  const fallback = (entries: LedgerEntry[]): CopyResult => ({
    copy: defaultCopyFor(params.ctx),
    degraded: true,
    entries,
  });

  if (!isAdModelConfigured()) {
    return fallback([
      entry("copy", "error", {
        promptVersion: PROMPT_VERSIONS.copy,
        rejectReason: "not_configured",
      }),
    ]);
  }

  const entries: LedgerEntry[] = [];
  let lastRejection: { reason: AdRejection; detail: string } | null = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const timeout = attempt === 1 ? COPY_TIMEOUT_MS : COPY_RETRY_TIMEOUT_MS;
    try {
      const response = await client(timeout).messages.parse({
        model: AD_MODEL,
        max_tokens: MAX_TOKENS.copy,
        system: systemFor(COPY_INSTRUCTIONS),
        // ⚠️ DEFAULT EFFORT, and the only call here that gets it. This is the
        // deliverable, it runs after the operator has committed, and it is the
        // one place thinking earns its cost.
        output_config: { format: zodOutputFormat(AdCopySchema) },
        messages: [
          {
            role: "user",
            content: copyUser({
              template: params.ctx.template,
              account: params.account,
              answers: params.answers,
              fixed: params.ctx.fixed,
              cta: params.cta,
              figures: params.figures,
              previousMessage: params.previousMessage ?? null,
              rejection: lastRejection,
            }),
          },
        ],
      });

      const common = {
        attempt,
        modelId: response.model,
        promptVersion: PROMPT_VERSIONS.copy,
        cacheReadTokens: cacheRead(response.usage),
      };
      const verdict = validateAdCopy(response.parsed_output, params.ctx);

      if (verdict.ok) {
        entries.push(entry("copy", "ok", common));
        return { copy: verdict.copy, degraded: false, entries };
      }

      entries.push(entry("copy", "rejected", { ...common, rejectReason: verdict.reason }));
      lastRejection = { reason: verdict.reason, detail: verdict.detail };
    } catch (error) {
      swallow(`generateCopy attempt ${attempt}`, error);
      entries.push(
        entry("copy", "error", {
          attempt,
          promptVersion: PROMPT_VERSIONS.copy,
          rejectReason: "call_failed",
        })
      );
      // ⚠️ A TIMEOUT IS NOT RETRIED. The first call has already spent 60 of a
      // 300-second ceiling and a provider that just timed out is the least
      // likely to answer in 45. Falling back leaves an advert on the screen.
      return fallback(entries);
    }
  }

  return fallback(entries);
}

/** The angles this template may take, for the UI to echo back. */
export { angleListFor };
