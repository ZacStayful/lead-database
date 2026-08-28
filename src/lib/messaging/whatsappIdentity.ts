/**
 * Matching a WhatsApp chat to a landlord (§28).
 *
 * ⚠️ TWO CHECKS ARE REQUIRED, NOT ONE. Both traps below were found in LIVE data
 * from the real workspace, not inferred from documentation.
 *
 * TRAP 1 — THE LID. A chat can carry a WhatsApp "LID" rather than a phone
 * number, and TimelinesAI surfaces it in the `phone` field anyway:
 *     { "phone": "+236974988349577", "jid": "236974988349577@lid" }
 * That value is not dialable and belongs to nobody. Matching on `phone` would
 * silently bind the wrong landlord. So: require the jid to end
 * "@s.whatsapp.net" before treating anything as a number.
 *
 * TRAP 2 — THE JID CHECK IS NOT SUFFICIENT ON ITS OWN. Also live:
 *     { "phone": "+0", "jid": "0@s.whatsapp.net" }
 * That PASSES the jid test. It is caught only by normalisation, which rejects
 * anything under 7 digits or all zeros — the rule §18 already uses for duplicate
 * landlords. Both checks, never either.
 *
 * normalisePhone here MIRRORS the SQL normalised_phone (0070) and the two must
 * stay in step. The test asserts it against a fixture table copied from running
 * the SQL, duplicated on purpose (§27.2): two normalisers that drift are a
 * silent mis-match of a landlord to a lead.
 */

export interface TimelinesChat {
  id?: number | string;
  name?: string | null;
  phone?: string | null;
  jid?: string | null;
  is_group?: boolean;
  is_allowed_to_message?: boolean;
}

const DIALABLE_SUFFIX = "@s.whatsapp.net";

/** TRAP 1: only a real WhatsApp user jid may be read as a phone number. */
export function isDialableJid(jid: string | null | undefined): boolean {
  return typeof jid === "string" && jid.toLowerCase().endsWith(DIALABLE_SUFFIX);
}

/**
 * Mirror of SQL normalised_phone (0070): digits only; null if fewer than 7
 * digits or all zeros; otherwise the last 9 digits.
 */
export function normalisePhone(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length < 7) return null;
  if (/^0+$/.test(digits)) return null;
  return digits.slice(-9);
}

/**
 * The only sanctioned way to get a number out of a chat. Returns null for a
 * group, a LID, a missing jid, or anything that fails normalisation — which is
 * what catches the live "+0" chat.
 */
export function phoneFromChat(chat: TimelinesChat): string | null {
  if (!chat || chat.is_group) return null;
  if (!isDialableJid(chat.jid)) return null;

  // Prefer the jid's own prefix over the `phone` field: the jid is the
  // authoritative identity and cannot disagree with itself.
  const fromJid = String(chat.jid).split("@")[0];
  const normalised = normalisePhone(fromJid) ?? normalisePhone(chat.phone);
  if (!normalised) return null;

  return fromJid;
}

/** The comparable key — what to match against normalised_phone(leads.phone). */
export function matchKeyFromChat(chat: TimelinesChat): string | null {
  const phone = phoneFromChat(chat);
  return phone ? normalisePhone(phone) : null;
}

/**
 * WhatsApp itself may refuse the send. Check before calling, so the failure is
 * ours and legible rather than the vendor's and opaque.
 */
export function isAllowedToMessage(chat: TimelinesChat): boolean {
  return chat?.is_allowed_to_message !== false;
}

/** Best-effort UK-aware E.164 for a lead's stored phone, for a first send. */
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[\s\-()]/g, "");
  if (!normalisePhone(cleaned)) return null;
  if (cleaned.startsWith("+")) return cleaned;
  if (cleaned.startsWith("0")) return cleaned.replace(/^0/, "+44");
  return `+${cleaned}`;
}
