/**
 * The operator's own introduction (§41).
 *
 * Until this existed there was no operator self-description anywhere in the
 * codebase: draftContext.ts told the model only
 * `OPERATOR: ${contactName}, ${businessName}`, and the referral email could say
 * no more than a company name. Two or three sentences from the operator is the
 * difference between "a local management company will call you" and knowing who.
 *
 * Pure, so the rules are testable without a request — the position §40.12 takes.
 */
import { PRICE_RE } from "@/lib/messaging/validateDraft";

/** Matches the compliance / vetting caps in presentationSettings.ts. */
export const MAX_INTRO_CHARS = 600;
export const MIN_INTRO_CHARS = 20;

/** Same rule validateDraft applies to a generated message. */
const LINK_RE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|co\.uk|net|org|io|app)\b)/i;

export type IntroVerdict =
  | { ok: true; value: string | null }
  | { ok: false; reason: string; message: string };

/**
 * Validate an operator's intro at SAVE time.
 *
 * ⚠️ PRICING IS REFUSED, AND THE REASON IS NOT SQUEAMISHNESS. This text is fed
 * to the WhatsApp drafter as well as the referral email, and validateDraft's
 * PRICE_RE rejects any generated message that mentions a fee. An intro
 * containing one would have the model paraphrase it and every draft would then
 * fail validation — silently, after the fact, with the operator seeing an empty
 * box and no reason. Refusing it here, with the reason said out loud, is the
 * only place it can be explained.
 *
 * PRICE_RE is imported rather than copied so the two can never disagree about
 * what counts as a price.
 *
 * ⚠️ LINKS ARE REFUSED TOO. A link is the strongest spam signal in a cold
 * WhatsApp and the number at risk is the operator's own; `{{booking_link}}` is
 * the one sanctioned way a URL reaches a message (§40.14).
 */
export function validateOperatorIntro(raw: unknown): IntroVerdict {
  if (raw == null) return { ok: true, value: null };
  if (typeof raw !== "string") {
    return { ok: false, reason: "type", message: "That does not look like text." };
  }

  const text = raw.trim().replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
  // Clearing it is a legitimate save, not an error.
  if (!text) return { ok: true, value: null };

  if (text.length > MAX_INTRO_CHARS) {
    return {
      ok: false,
      reason: "too_long",
      message: `Keep it under ${MAX_INTRO_CHARS} characters — this is an introduction, not a brochure.`,
    };
  }
  if (text.length < MIN_INTRO_CHARS) {
    return {
      ok: false,
      reason: "too_short",
      message: "A sentence or two, so a landlord knows who is calling.",
    };
  }
  if (PRICE_RE.test(text)) {
    return {
      ok: false,
      reason: "mentions_price",
      message:
        "Leave pricing out of your introduction. It is also used in WhatsApp messages, where quoting a fee stops the message being sent — and a first contact is not the place to name a price. Your fee belongs in your presentation settings.",
    };
  }
  if (LINK_RE.test(text)) {
    return {
      ok: false,
      reason: "contains_link",
      message:
        "Leave links out. A link in a first message is the strongest spam signal there is, and the number at risk is yours. Add a booking link in Messaging settings instead.",
    };
  }

  return { ok: true, value: text };
}
