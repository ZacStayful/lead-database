/**
 * Writing a first WhatsApp message to a landlord.
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

/** Written to lead_messages.prompt_version so v2 can ask what converted. */
export const PROMPT_VERSION = "wa_first_v1";

const DraftResponse = z.object({
  message: z.string().describe("The WhatsApp message, 40-70 words, plain text."),
});

export type DraftResult =
  | { ok: true; text: string; modelId: string | null; promptVersion: string }
  | { ok: false; code: "not_configured" | "model_error" | DraftRejection };

export function isDraftingConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function systemPrompt(): string {
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
      system: systemPrompt(),
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
      promptVersion: PROMPT_VERSION,
    };
  } catch (e) {
    console.error(
      "[draftMessage] model call failed",
      e instanceof Error ? e.message : e
    );
    return { ok: false, code: "model_error" };
  }
}
