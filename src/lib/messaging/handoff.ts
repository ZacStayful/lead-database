/**
 * The WhatsApp hand-off: sending without a TimelinesAI connection (§40.15).
 *
 * A customer with no connected workspace has, until now, had a Send WhatsApp
 * button that opens a modal and stops. Production says how many that is: one of
 * twenty-one active customers has a connection, so twenty have been looking at
 * a button that cannot send.
 *
 * This builds a wa.me deep link instead. The link carries two things and no
 * more — WHO to message and WHAT to say — so tapping it opens the customer's
 * OWN WhatsApp with the text already in the box, and pressing send sends from
 * THEIR number. Stayful's number never appears in the conversation, and no
 * account, token or subscription is involved on their side.
 *
 * ⚠️ NOTHING COMES BACK. There is no provider id, no delivery receipt and no
 * reply capture, which is why the caller records a whatsapp_click and never a
 * message_sent, and why no lead_messages row is written for it. §40.15 states
 * the cost in full; the short version is that the paid path is better and the
 * modal has to keep saying so.
 *
 * ⚠️ normaliseUkMobile IS THE RIGHT NORMALISER, NOT toE164. toE164 is the loose
 * 0070 IDENTITY rule — seven digits, not all zeros — whose job is deciding
 * whether two records describe the same person. sendOneMessage already learned
 * this the hard way (§36): a number one digit short sailed through it and came
 * back as a bare http_400 from the vendor. The strict rule is also the only one
 * that survives the shape 90 of the 449 live leads are stored in, `+44` followed
 * by a national trunk zero — leadQuality.ts:131 records that stripping leading
 * zeros before re-adding one is what stopped it losing 89 of them.
 */
import { normaliseUkMobile } from "@/lib/leadQuality";
import { toE164 } from "@/lib/messaging/whatsappIdentity";

/**
 * ⚠️ AN EXPORTED CONSTANT WITH A TEST PINNING IT, never a URL typed into JSX
 * (§40.11, the same rule that guards TIMELINES_SIGNUP_URL's refby parameter).
 *
 * wa.me is WhatsApp's own short form and wants BARE digits — no `+`, no spaces,
 * no punctuation. api.whatsapp.com/send would also work; this one is shorter
 * and behaves the same on mobile and on WhatsApp Web.
 */
export const WHATSAPP_DEEP_LINK_BASE = "https://wa.me/";

/**
 * Mirrors validateDraft's MAX_CHARS. A hand-off carries the same text a send
 * would have carried, so it is held to the same ceiling rather than a new one.
 */
export const HANDOFF_MAX_TEXT = 480;

/**
 * A wa.me link for this lead and this message, or null when there is no usable
 * mobile or nothing to say.
 *
 * ⚠️ IT REJECTS, IT DOES NOT REPAIR — validateDraft's rule, for the same reason.
 * Null means the caller renders no hand-off option at all, which is the honest
 * outcome for a landline: a link WhatsApp cannot open reads as a broken feature,
 * where an absent one reads as missing data, and §18E's rule is that missing
 * data disables while missing setup explains.
 *
 * A foreign number is a fact, not an error (§36.2) — landlords abroad exist and
 * WhatsApp is how you reach them — so it goes through as E.164 and WhatsApp
 * decides.
 */
export function whatsappHandoffLink(
  phone: string | null | undefined,
  text: string
): string | null {
  const body = text.trim();
  if (!body || body.length > HANDOFF_MAX_TEXT) return null;

  const digits = handoffDigits(phone);
  if (!digits) return null;

  return `${WHATSAPP_DEEP_LINK_BASE}${digits}?text=${encodeURIComponent(body)}`;
}

/** Bare E.164 digits wa.me will accept, or null. Exported for the tests. */
export function handoffDigits(phone: string | null | undefined): string | null {
  const uk = normaliseUkMobile(phone);

  // The national form is `07…`; wa.me wants `447…`.
  if (uk.ok) return `44${uk.value.slice(1)}`;

  // Only an explicitly foreign number gets a second chance. not_mobile,
  // missing and placeholder are all "there is nothing here to message".
  if (uk.reason !== "foreign") return null;

  const e164 = toE164(phone);
  if (!e164) return null;

  const bare = e164.replace(/^\+/, "");
  if (!/^[0-9]{10,15}$/.test(bare)) return null;
  return bare;
}
