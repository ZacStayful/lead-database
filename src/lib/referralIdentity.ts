/**
 * What this operator is called to a LANDLORD (§41, 0131).
 *
 * §41 renders a details table — Who, Company, Phone, Email — straight off the
 * account row, and the customer could edit none of it. These four overrides sit
 * beside `operator_intro`, which is the other half of the same block of the same
 * email.
 *
 * ⚠️ OVERRIDES, NOT COPIES. Each column is nullable and NULL means "use my
 * account details", so a customer who sets nothing still has exactly one value
 * and there is nothing to drift. That is the whole reason this is not four extra
 * fields the dashboard writes on save.
 *
 * ⚠️ AND NONE OF IT REACHES THE ACCOUNT. `customers.email` is the login and the
 * Stripe billing address (§43.3: move it without Stripe and the next unmatched
 * invoice provisions a duplicate customer and a second auth user).
 * `business_name` / `contact_name` are Monday matcher tier 3 — the only tier
 * that resolves two of eighteen live customers. `phone` is where the operator's
 * own SMS alerts go. `resolveReferralOperator` READS those columns and nothing
 * anywhere writes them from here.
 *
 * Pure, so every rule below is testable without a client — the position §40.12
 * takes for the same reason.
 */
import { normaliseEmail } from "@/lib/emailAddress";
import type { ReferralOperator } from "@/lib/landlordReferral";

export const MAX_REFERRAL_NAME_CHARS = 120;
export const MAX_REFERRAL_PHONE_CHARS = 40;
export const MAX_REFERRAL_EMAIL_CHARS = 200;

/**
 * ⚠️ ONE STRING, SO THE THREE CALL SITES CANNOT DRIFT. `landlordReferralSend`
 * selects the operator TWICE — once on the send path and again, forty lines
 * away, on the retry path — and `landlordNudgeSend` and the admin test route
 * each select it a third and fourth time. Changing one and missing another
 * means a retried referral silently reverts to the account details, which is
 * invisible until a landlord is looking at the wrong phone number.
 */
export const REFERRAL_OPERATOR_COLUMNS =
  "business_name, contact_name, email, phone, operator_intro, " +
  "referral_business_name, referral_contact_name, referral_email, referral_phone";

/** The raw row shape `REFERRAL_OPERATOR_COLUMNS` returns. */
export interface ReferralIdentityRow {
  business_name?: string | null;
  contact_name?: string | null;
  email?: string | null;
  phone?: string | null;
  operator_intro?: string | null;
  referral_business_name?: string | null;
  referral_contact_name?: string | null;
  referral_email?: string | null;
  referral_phone?: string | null;
}

/** Trimmed, or null — "" and "   " both mean "not set", so they mean "fall back". */
function value(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim();
  return v === "" ? null : v;
}

/**
 * The operator as a landlord should see them.
 *
 * ⚠️ IT RETURNS A `ReferralOperator`, deliberately, so that nothing downstream
 * changes. `buildReferralCopy`, `operatorLabel` and the nudge's `operatorLine`
 * all keep reading the same four field names — they simply receive resolved
 * values instead of raw ones. A second, override-aware code path through the
 * copy builder is how the subject line and the details table would eventually
 * disagree about who this operator is.
 */
export function resolveReferralOperator(row: ReferralIdentityRow): ReferralOperator {
  return {
    business_name: value(row.referral_business_name) ?? value(row.business_name),
    contact_name: value(row.referral_contact_name) ?? value(row.contact_name),
    phone: value(row.referral_phone) ?? value(row.phone),
    email: value(row.referral_email) ?? value(row.email),
    operator_intro: value(row.operator_intro),
  };
}

/**
 * Just the two names, for the message drafter and the merge fields.
 *
 * ⚠️ THE DRAFTED WHATSAPPS HAVE TO AGREE WITH THE EMAIL. `{{my_company}}` and
 * the `OPERATOR:` line in the draft prompt are landlord-facing too. Left reading
 * the account columns, an operator who sets a public company name introduces
 * themselves to the SAME landlord under one name by email and a different one by
 * WhatsApp — which is worse than either name on its own.
 *
 * Only the names: the drafter is never given a phone or an email (draftContext's
 * `DraftCustomer` has no field for either, deliberately), and
 * `messaging_booking_link` is the caller's to pass through.
 */
export function resolveOperatorNames(row: ReferralIdentityRow): {
  business_name: string | null;
  contact_name: string | null;
} {
  const resolved = resolveReferralOperator(row);
  return {
    business_name: resolved.business_name ?? null,
    contact_name: resolved.contact_name ?? null,
  };
}

/** What the customer typed, before validation. */
export interface ReferralDetailsInput {
  referral_contact_name?: unknown;
  referral_business_name?: unknown;
  referral_phone?: unknown;
  referral_email?: unknown;
}

/** What is written to the row. Null clears an override. */
export interface ReferralDetailsPatch {
  referral_contact_name: string | null;
  referral_business_name: string | null;
  referral_phone: string | null;
  referral_email: string | null;
}

export type ReferralDetailsField = keyof ReferralDetailsPatch;

export type ReferralDetailsVerdict =
  | { ok: true; patch: ReferralDetailsPatch }
  | { ok: false; field: ReferralDetailsField; message: string };

/**
 * Matches the bar `looksLikePhone` sets in sms.ts (10–15 digits), rewritten
 * rather than imported because that one is module-private.
 *
 * ⚠️ A LANDLINE IS VALID HERE, and §36's `normaliseUkMobile` is the wrong rule
 * for this field even though it is the right rule two files away. That one
 * exists because a WhatsApp hand-off needs a mobile; this is a number a landlord
 * rings, and an office landline is the ordinary case. Refusing it would be us
 * overruling an operator about how to be contacted.
 */
function looksLikeDialable(raw: string): boolean {
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15;
}

function name(
  raw: unknown,
  field: ReferralDetailsField
): { ok: true; value: string | null } | { ok: false; field: ReferralDetailsField; message: string } {
  if (raw == null) return { ok: true, value: null };
  if (typeof raw !== "string") {
    return { ok: false, field, message: "That does not look like text." };
  }
  const v = raw.trim().replace(/\s+/g, " ");
  // Clearing a field is a legitimate save: it means "go back to my account
  // details", which is the only way to undo an override.
  if (!v) return { ok: true, value: null };
  if (v.length > MAX_REFERRAL_NAME_CHARS) {
    return {
      ok: false,
      field,
      message: `Keep it under ${MAX_REFERRAL_NAME_CHARS} characters.`,
    };
  }
  return { ok: true, value: v };
}

/**
 * Validate the four at SAVE time. Never throws, and names the offending field
 * so the card can point at it — the shape `validateOperatorIntro` uses.
 */
export function validateReferralDetails(
  input: ReferralDetailsInput
): ReferralDetailsVerdict {
  const contact = name(input.referral_contact_name, "referral_contact_name");
  if (!contact.ok) return contact;

  const business = name(input.referral_business_name, "referral_business_name");
  if (!business.ok) return business;

  let phone: string | null = null;
  if (input.referral_phone != null) {
    if (typeof input.referral_phone !== "string") {
      return {
        ok: false,
        field: "referral_phone",
        message: "That does not look like a phone number.",
      };
    }
    const raw = input.referral_phone.trim();
    if (raw) {
      if (raw.length > MAX_REFERRAL_PHONE_CHARS || !looksLikeDialable(raw)) {
        return {
          ok: false,
          field: "referral_phone",
          message:
            "That does not look like a phone number a landlord could ring. A landline is fine.",
        };
      }
      phone = raw;
    }
  }

  let email: string | null = null;
  if (input.referral_email != null) {
    if (typeof input.referral_email !== "string") {
      return {
        ok: false,
        field: "referral_email",
        message: "That does not look like an email address.",
      };
    }
    const raw = input.referral_email.trim();
    if (raw) {
      // ⚠️ NO UNIQUENESS CHECK, and that is not an omission. This is not a
      // login: two operators in one office may legitimately publish the same
      // enquiries@ address, and `customers.email` — which IS unique — is
      // untouched by this route.
      const normalised = normaliseEmail(raw);
      if (!normalised || normalised.length > MAX_REFERRAL_EMAIL_CHARS) {
        return {
          ok: false,
          field: "referral_email",
          message: "That does not look like an email address.",
        };
      }
      email = normalised;
    }
  }

  return {
    ok: true,
    patch: {
      referral_contact_name: contact.value,
      referral_business_name: business.value,
      referral_phone: phone,
      referral_email: email,
    },
  };
}
