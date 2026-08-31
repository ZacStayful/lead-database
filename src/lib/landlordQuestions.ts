/**
 * The questions a landlord is asked once, at /p/[token] (§41).
 *
 * ⚠️ THE QUESTIONS ARE THE SPINE, THE CARDS ARE NOT. A lead with no analysis
 * still gets asked all three; the deck attaches whatever cards its report
 * supports. Pairing them rigidly would mean a landlord whose report was thin
 * silently never gets asked how to reach them, which is the half of this
 * feature the operators actually need.
 *
 * ⚠️ THE CHIPS ARE A CLOSED LIST, validated server-side. This is written by an
 * unauthenticated caller holding a token, so "whatever they posted" must never
 * reach the column — the §27.1 standing rule, applied to a public endpoint.
 */

export const CONTACT_METHODS = ["whatsapp", "phone", "email"] as const;
export type ContactMethod = (typeof CONTACT_METHODS)[number];

export const CONTACT_METHOD_LABELS: Record<ContactMethod, string> = {
  whatsapp: "WhatsApp",
  phone: "A phone call",
  email: "Email",
};

export const CONTACT_TIMES = [
  "Weekday mornings",
  "Weekday afternoons",
  "Weekday evenings",
  "Weekends",
  "Any time is fine",
] as const;

/**
 * ⚠️ "What it could earn after running costs" IS FIRST DELIBERATELY.
 *
 * long_let_annual_income and the cost percentages are both in the database and
 * both withheld: showing them means showing costs, and the costs the report
 * states are net of STAYFUL'S fee, not the operator's (rules 2 and 3 in
 * landlordDeck.ts). So the most motivating number available becomes the reason
 * for the call instead — the operator answers it, on the phone, with their own
 * figures. A compliance constraint turned into the hook.
 */
export const WANT_CHIPS = [
  "What it could earn after running costs",
  "How much work is involved for me",
  "Who deals with the guests",
  "Whether my mortgage or lease allows it",
  "How quickly it could start",
  "Something else",
] as const;

export const MAX_WANTS = 8; // matches the CHECK on leads.landlord_wants
export const MAX_TIME_CHARS = 120;
export const MAX_NOTE_CHARS = 1000;

export interface LandlordAnswers {
  contactMethod: ContactMethod | null;
  contactTime: string | null;
  wants: string[] | null;
  note: string | null;
}

export type AnswerVerdict =
  | { ok: true; answers: LandlordAnswers }
  | { ok: false; reason: string };

function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().replace(/\s+/g, " ");
  if (!t) return null;
  return t.slice(0, max);
}

/**
 * Validate one submission. Pure, so the closed lists are testable without a
 * request. Unknown chips are DROPPED rather than rejecting the whole
 * submission: a landlord who answered three questions should not lose all of
 * them because a stale tab posted a retired chip.
 */
export function validateAnswers(body: unknown): AnswerVerdict {
  if (typeof body !== "object" || body === null) {
    return { ok: false, reason: "malformed" };
  }
  const b = body as Record<string, unknown>;

  const method =
    typeof b.contact_method === "string" &&
    (CONTACT_METHODS as readonly string[]).includes(b.contact_method)
      ? (b.contact_method as ContactMethod)
      : null;

  const time = cleanText(b.contact_time, MAX_TIME_CHARS);
  const note = cleanText(b.note, MAX_NOTE_CHARS);

  let wants: string[] | null = null;
  if (Array.isArray(b.wants)) {
    const allowed = new Set<string>(WANT_CHIPS);
    const picked = b.wants
      .filter((w): w is string => typeof w === "string" && allowed.has(w))
      .slice(0, MAX_WANTS);
    wants = picked.length > 0 ? picked : null;
  }

  // Nothing usable at all is a no-op, not a 400: an empty submit should not
  // read to the landlord as an error they have to solve.
  if (!method && !time && !wants && !note) {
    return { ok: false, reason: "empty" };
  }

  return { ok: true, answers: { contactMethod: method, contactTime: time, wants, note } };
}

/** How the operator reads the answers back. Shared by the lead page and export. */
export function describeAnswers(a: {
  landlord_contact_method?: string | null;
  landlord_contact_time?: string | null;
  landlord_wants?: string[] | null;
}): string[] {
  const out: string[] = [];
  const m = a.landlord_contact_method as ContactMethod | null | undefined;
  if (m && CONTACT_METHOD_LABELS[m]) {
    // Phrased as what they ASKED FOR, not as an instruction. Three operators
    // can hold one lead and all read this; "call Tuesday morning" from three
    // of them at once is the pile-on §40.12 exists to prevent.
    out.push(`Asked to be contacted by ${CONTACT_METHOD_LABELS[m]}`);
  }
  if (a.landlord_contact_time) out.push(`Best time: ${a.landlord_contact_time}`);
  if (a.landlord_wants?.length) out.push(`Wants to know: ${a.landlord_wants.join("; ")}`);
  return out;
}
