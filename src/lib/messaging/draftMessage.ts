/**
 * Writing a WhatsApp message to a landlord — the first one, or a follow-up.
 *
 * Mirrors src/lib/claudeMapping.ts — the codebase's other model call — in every
 * structural respect: client built inside the call with a timeout, structured
 * output through zodOutputFormat, gated on ANTHROPIC_API_KEY, and NEVER throws.
 *
 * It differs in one deliberate way, and it matters. claudeMapping falls back to
 * a duller heuristic mapping, because a duller mapping is still useful. Here the
 * fallback is NOTHING — the operator's empty textarea. A canned template pasted
 * into WhatsApp is exactly the mass-outreach pattern that gets a number
 * restricted, and the number at risk is the operator's own.
 *
 * ⚠️ TONE IS A SAFETY CONSTRAINT HERE, NOT A STYLE PREFERENCE. This is a cold
 * message from a real person's real WhatsApp. Long, polished, obviously-templated
 * text is the ban profile. Short and specific is also, separately, what gets
 * replies.
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { renderDraftPrompt, type DraftContext } from "./draftContext";
import { validateDraft, type DraftRejection } from "./validateDraft";

const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Written to lead_messages.prompt_version so v2 can ask what converted.
 *
 * ⚠️ PER SHAPE, NOT ONE CONSTANT. A cold opener and a fourth follow-up are
 * different prompts doing different jobs, and lumping them under one version
 * would collapse the only join that can ever answer "does chasing work" into a
 * single bucket. Bump the shape's own version when you change its prompt.
 */
export const PROMPT_VERSION = "wa_first_v1";
export const FOLLOWUP_PROMPT_VERSION = "wa_followup_v1";

export function promptVersionFor(ctx: DraftContext): string {
  return ctx.step ? FOLLOWUP_PROMPT_VERSION : PROMPT_VERSION;
}

const DraftResponse = z.object({
  message: z.string().describe("The WhatsApp message, plain text, no links."),
});

export type DraftResult =
  | { ok: true; text: string; modelId: string | null; promptVersion: string }
  | { ok: false; code: "not_configured" | "model_error" | DraftRejection };

export function isDraftingConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * ⚠️ TWO SHAPES, AND USING THE WRONG ONE IS NOT A COSMETIC ERROR. The opener
 * tells the model to greet the landlord by name and name the property "so it
 * does not read as a scam". Sent as step 3, that message re-introduces the
 * operator to somebody they have already messaged twice — which reads as an
 * automated blast, which is precisely what this whole feature has to avoid.
 *
 * What the two share is every safety rule: no price, no unsupplied figure, no
 * link, no promise. Those are duplicated rather than factored out on purpose —
 * a shared constant is a shared constant to forget, and validateDraft enforces
 * all of them anyway as the third layer.
 */
function systemPrompt(ctx: DraftContext): string {
  if (ctx.step) return followUpSystemPrompt();
  return [
    "You write the first WhatsApp message from a property operator to a landlord who has enquired about short-let management.",
    "",
    "You are writing AS the operator, in their voice. Plain British English.",
    "",
    "GOAL: get a reply. Not a booking, not a sale. One easy question they can answer in a word.",
    "",
    "HARD RULES:",
    "- 40 to 70 words. Two or three short sentences. Longer reads as marketing.",
    "- Open with the landlord's first name.",
    "- Name the property — the street or the area — in the first sentence, so it does not read as a scam.",
    "- End with ONE easy question.",
    "- NEVER mention price, fees, commission, percentages of income, what you charge, what it costs, or that anything is free. Not even 'no fee'. Pricing is a later conversation.",
    "- NEVER state a number that was not given to you below. No estimating, no rounding up, no 'properties like yours earn'.",
    "- NEVER include a link, a URL or a web address.",
    "- No emoji, no bullet points, no bold, no capitals for emphasis.",
    "- Do not promise occupancy, income, guaranteed rent or any timescale.",
    "- Do not claim to have visited the property, to have guests waiting, or to know anything about the landlord you were not told.",
    "",
    "IF NO FIGURES ARE GIVEN: write a message with no numbers in it at all. That is a normal, good message — most landlords reply to the person who sounds human, not the one with a spreadsheet.",
  ].join("\n");
}

function followUpSystemPrompt(): string {
  return [
    "You write a follow-up WhatsApp from a property operator to a landlord who enquired about short-let management, was messaged already, and has not replied.",
    "",
    "You are writing AS the operator, in their voice. Plain British English.",
    "",
    "GOAL: get a reply. One easy question they can answer in a word.",
    "",
    "THIS IS THE PART THAT MATTERS:",
    "- They have already had your earlier message. Do NOT reintroduce yourself, do not explain who you are again, and do not restate what you do.",
    "- Do NOT repeat the earlier message in different words. Say something new, or say very little.",
    "- Shorter than the first. 15 to 45 words. By the third or fourth attempt, one line is right.",
    "- No guilt, no pressure, no 'just bumping this to the top of your inbox', no 'I noticed you have not replied'. Assume they are busy, not rude.",
    "- It is fine to give them an easy way out — 'happy to leave it if the timing is wrong' reads as human and often gets the reply.",
    "",
    "HARD RULES, the same as every message on this thread:",
    "- End with ONE easy question, or one short offer they can decline.",
    "- NEVER mention price, fees, commission, percentages of income, what you charge, what it costs, or that anything is free. Not even 'no fee'.",
    "- NEVER state a number that was not given to you below. No estimating, no 'properties like yours earn'.",
    "- NEVER include a link, a URL or a web address.",
    "- No emoji, no bullet points, no bold, no capitals for emphasis.",
    "- Do not promise occupancy, income, guaranteed rent or any timescale.",
    "- Do not claim to have visited the property, to have guests waiting, or to know anything about the landlord you were not told.",
    "",
    "Using their first name is optional here — you have already used it. A short message that does not need it is better than one that shoehorns it in.",
  ].join("\n");
}

/**
 * Returns a validated draft, or a reason. Never throws, never partially
 * succeeds, and never returns text the validator refused.
 */
export async function draftWhatsappMessage(
  ctx: DraftContext
): Promise<DraftResult> {
  if (!isDraftingConfigured()) return { ok: false, code: "not_configured" };

  try {
    const client = new Anthropic({ timeout: REQUEST_TIMEOUT_MS });
    const response = await client.messages.parse({
      model: "claude-opus-5",
      max_tokens: 2000,
      system: systemPrompt(ctx),
      // A sixty-word message is a small judgement and the operator is watching
      // a spinner — the same reasoning claudeMapping gives for its own setting.
      output_config: {
        effort: "low",
        format: zodOutputFormat(DraftResponse),
      },
      messages: [{ role: "user", content: renderDraftPrompt(ctx) }],
    });

    const parsed = response.parsed_output;
    const verdict = validateDraft(parsed?.message, ctx);
    if (!verdict.ok) {
      console.warn("[draftMessage] rejected by validator", verdict.reason);
      return { ok: false, code: verdict.reason };
    }

    return {
      ok: true,
      text: verdict.text,
      // The model that actually served the turn, not the alias we asked for —
      // otherwise "which prompt converted on which model" is a join that lies.
      modelId: response.model ?? null,
      promptVersion: promptVersionFor(ctx),
    };
  } catch (e) {
    console.error(
      "[draftMessage] model call failed",
      e instanceof Error ? e.message : e
    );
    return { ok: false, code: "model_error" };
  }
}
