/**
 * Lead contact-quality — the rules, in one place.
 *
 * A lead is worth £15 to the operator it is sold to, and reject does not refund
 * (invariant 4). So a landlord whose "mobile" is a Dubai landline, or whose name
 * is the word `asdf`, is money taken for nothing. Nothing checked any of this
 * before: `ingestLead` writes whatever Monday or n8n hands it, and
 * `autoAssignLead` sells it minutes later.
 *
 * Pure and dependency-free, like `leadResale.ts`, so the ingest path, the admin
 * surface and vitest all read ONE definition. The database is the authority on
 * whether a failed lead is actually routed — 0109 carries the clause in
 * `lead_retired_from_allocation()` and `lead_pool_barred()` — and what lives
 * here is the verdict those columns are written from.
 *
 * ⚠️ This is a SYNTACTIC check and cannot be anything else without a vendor. It
 * proves a number is shaped like a UK mobile, not that anyone answers it. The
 * privacy policy already names Twilio Lookup and ZeroBounce for that; neither is
 * implemented, and adding one belongs behind this module rather than inside it.
 */

/** Why a lead's contact details are not usable — the whole vocabulary. */
export type LeadQualityCode =
  | "name_missing"
  | "name_junk"
  | "phone_missing"
  | "phone_placeholder"
  | "phone_foreign"
  | "phone_not_uk_mobile"
  | "email_missing"
  | "email_malformed";

/** The lead columns these rules read. Narrow, so a form row can pass one. */
export interface QualityCheckableLead {
  lead_name?: string | null;
  phone?: string | null;
  email?: string | null;
}

export interface LeadQualityVerdict {
  ok: boolean;
  /** EVERY failing reason, not just the first — an admin needs to know whether
   *  this is one fixable field or a bin job. */
  codes: LeadQualityCode[];
  /** The number in national `07…` form when valid, else null. */
  normalisedPhone: string | null;
  /** Trimmed and lowercased when valid, else null. */
  normalisedEmail: string | null;
}

/**
 * Email shape. Moved here from `leadImport.ts`, which now imports it, so the
 * spreadsheet importer and the quality gate cannot drift apart about what an
 * email address looks like.
 */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Whole-string placeholders. Matched case-insensitively, anchored. */
const PLACEHOLDER_NAMES = new Set([
  "test", "testing", "asdf", "qwerty", "n/a", "n\\a", "na", "none", "nil",
  "unknown", "tbc", "tba", "anon", "anonymous", "no name", "noname",
  "notgiven", "not given", "landlord", "customer", "-", ".",
]);

// Deliberately NOT \p{L}: the project's TypeScript target predates the unicode
// regex flag, and a name is judged by these rules in the browser too. The ranges
// cover Latin, Latin-1 accents, Latin Extended-A/B, Greek, Cyrillic, Arabic,
// Hebrew, Devanagari and CJK — enough that a real landlord's name is never read
// as "contains no letters".
const HAS_LETTER =
  /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/;

// The no-vowel rule is applied ONLY to names written in basic Latin. A name in
// any other script has no vowels by this test and would be failed wholesale.
const ONLY_BASIC_LATIN = /^[A-Za-z\s'.-]+$/;

export type UkMobileFailure = "missing" | "placeholder" | "foreign" | "not_mobile";

export type UkMobileResult =
  | { ok: true; value: string }
  | { ok: false; reason: UkMobileFailure };

/**
 * A UK phone string → national `07…` form, or a reason it is not a UK mobile.
 *
 * ⚠️ THE ORDER OF STEPS 3–5 IS THE WHOLE POINT OF THIS FUNCTION.
 *
 * 89 of the 193 management leads in the live book store the number as `+44`
 * followed by a FULL NATIONAL number — `+4407304208011`, `+4407581051622`. The
 * obvious implementation (strip `+44`, prefix `0`) turns that into
 * `007304208011` and rejects 46% of the management book. Stripping the leading
 * zeros AFTER removing the country code and BEFORE re-adding a single one is
 * what makes both `+447711387707` and `+4407304208011` land on the same answer.
 *
 * Do not "simplify" this to a `startsWith('+44')` slice.
 */
export function normaliseUkMobile(raw: string | null | undefined): UkMobileResult {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: false, reason: "missing" };

  const digits = text.replace(/\D/g, "");
  if (!digits) return { ok: false, reason: "missing" };

  // `0000 0000000` and `00` are placeholders somebody typed to get past a
  // required field. The same rule normalised_phone() uses in 0070 — a number
  // that is all zeros identifies nobody.
  if (/^0+$/.test(digits)) return { ok: false, reason: "placeholder" };

  // Did the caller signal an international number, with a `+` or the `00`
  // dialling prefix? That is what separates `0031…` (the Netherlands) from
  // `0793…`, a UK national number that merely begins with a zero.
  const hadPlus = text.startsWith("+");
  const hadZeroZero = /^00/.test(digits);

  // The forms this string could plausibly be, most literal first.
  const candidates: string[] = [];
  if (hadPlus || hadZeroZero) {
    const bare = hadZeroZero ? digits.replace(/^0+/, "") : digits;
    // An explicit country code that is not ours is a fact, not a typo. Saying
    // so beats `not_mobile`, because an admin reading the reason can tell an
    // overseas landlord from a mistyped UK number.
    if (!bare.startsWith("44")) return { ok: false, reason: "foreign" };
    candidates.push(bare.slice(2));
  } else {
    candidates.push(digits);
    // A bare `44…` with no `+` and no `00`. Offered as a SECOND candidate
    // rather than assumed, so a national number is never mangled by it.
    if (digits.startsWith("44")) candidates.push(digits.slice(2));
  }

  for (const candidate of candidates) {
    // THE LINE THAT MATTERS. `+4407304208011` reaches here as `07304208011` and
    // `+447711387707` as `7711387707`; stripping leading zeros and then adding
    // exactly one puts both into the same national form. Adding a `0` without
    // stripping first yields `007304208011` and loses 89 live leads.
    const national = `0${candidate.replace(/^0+/, "")}`;
    if (/^07\d{9}$/.test(national)) return { ok: true, value: national };
  }

  return { ok: false, reason: "not_mobile" };
}

/**
 * Does this read as a human name?
 *
 * ⚠️ A JUNK DETECTOR, NOT A FORMAT CHECK, and that is a measured decision rather
 * than a loose one. 87 of the 437 leads in the live book carry a single-token
 * name — "Adam", "Ann", "Josh", "Emily" — every one of them with a valid mobile
 * and a working email. Requiring a surname would discard a fifth of the book to
 * catch three bad rows.
 *
 * So this fails only on evidence that the value is NOT a name, and passes a lone
 * first name, a lowercase one, an accented one and a non-Latin one.
 */
export function isJunkName(raw: string | null | undefined): boolean {
  const name = String(raw ?? "").trim();
  if (!name) return false; // absence is `name_missing`, a different fact

  if (name.length < 2) return true;
  if (name.includes("@")) return true;              // an email in the name field
  if (/\d/.test(name)) return true;
  if (!HAS_LETTER.test(name)) return true;          // no letter, in any script
  if (/(.)\1{2,}/.test(name)) return true;          // "xxx", "aaaa"
  if (PLACEHOLDER_NAMES.has(name.toLowerCase())) return true;

  // No vowel at all. Length-gated at 4 so genuine short surnames ("Ng", "Ba")
  // are never caught; `Dbncc` is 5.
  if (name.length >= 4 && ONLY_BASIC_LATIN.test(name) && !/[aeiouy]/i.test(name)) {
    return true;
  }

  return false;
}

/** The verdict. Collects every reason rather than stopping at the first. */
export function assessLeadQuality(lead: QualityCheckableLead): LeadQualityVerdict {
  const codes: LeadQualityCode[] = [];

  const name = String(lead.lead_name ?? "").trim();
  if (!name) codes.push("name_missing");
  else if (isJunkName(name)) codes.push("name_junk");

  const phone = normaliseUkMobile(lead.phone);
  if (!phone.ok) {
    codes.push(
      phone.reason === "missing"
        ? "phone_missing"
        : phone.reason === "placeholder"
          ? "phone_placeholder"
          : phone.reason === "foreign"
            ? "phone_foreign"
            : "phone_not_uk_mobile"
    );
  }

  const email = String(lead.email ?? "").trim();
  if (!email) codes.push("email_missing");
  else if (!EMAIL_RE.test(email)) codes.push("email_malformed");

  return {
    ok: codes.length === 0,
    codes,
    normalisedPhone: phone.ok ? phone.value : null,
    normalisedEmail: !email || !EMAIL_RE.test(email) ? null : email.toLowerCase(),
  };
}

const CODE_TEXT: Record<LeadQualityCode, string> = {
  name_missing: "No name",
  name_junk: "The name does not read as a person",
  phone_missing: "No phone number",
  phone_placeholder: "The phone number is a placeholder",
  phone_foreign: "The phone number is not a UK number",
  phone_not_uk_mobile: "The phone number is not a UK mobile (07)",
  email_missing: "No email address",
  email_malformed: "The email address is not a valid address",
};

/** Human-readable reasons, for the admin surface. */
export function describeLeadQuality(codes: LeadQualityCode[]): string {
  if (!codes.length) return "Contact details look usable.";
  return codes.map((code) => CODE_TEXT[code]).join(" · ");
}

/** The lead columns the allocation gate reads. */
export interface QualityGateFields {
  lead_quality_status?: string | null;
  lead_quality_override_at?: string | null;
}

/**
 * May this lead be routed?
 *
 * `pending` PASSES deliberately. It means "nothing has judged this row yet" —
 * a lead that predates 0109, or one written by a path that does not stamp — and
 * an unchecked lead being sold is recoverable where an unchecked lead being
 * silently withheld is not. It is also what makes 0109 inert on apply.
 *
 * The database enforces the same rule under `assign_lead_to_customer`'s row
 * lock; this exists so `autoAssignLead` can skip the candidate round trips, and
 * to guard the contention-cap write that never reaches SQL.
 */
export function passesQualityGate(lead: QualityGateFields): boolean {
  if (lead.lead_quality_status !== "failed") return true;
  return Boolean(lead.lead_quality_override_at);
}
