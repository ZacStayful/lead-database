/**
 * What we tell a customer when their card is declined, and what we deliberately
 * do not tell them.
 *
 * Pure — no IO, no Stripe types, no database shapes — so the whole decision is
 * unit-testable under vitest.config.mts's "pure units only" rule. The impure
 * halves live in declineDetail.ts (reading Stripe) and cardDeclines.ts (writing
 * the audit row and sending).
 *
 * ⚠️ SUPPRESSION IS THE POINT OF THIS FILE.
 * ------------------------------------------
 * Stripe hands back decline codes we must never repeat to the cardholder.
 * `lost_card`, `stolen_card`, `pickup_card`, `fraudulent`, `merchant_blacklist`,
 * `restricted_card`, `revocation_of_authorization` and `security_violation` all
 * collapse to one neutral outcome — "your bank declined it, call the number on
 * your card" — for three reasons, each sufficient on its own:
 *
 *   1. Telling somebody testing a stolen card that we can SEE it is reported
 *      stolen tells them exactly how much we know. Stripe's own guidance is to
 *      show a generic decline for this family.
 *   2. Issuers use these as catch-alls. A perfectly legitimate customer whose
 *      bank threw a risk block gets `stolen_card` surprisingly often, and
 *      accusing a paying customer of card theft is not a recoverable email.
 *   3. It is not ours to say. The issuer owns that conversation and we would be
 *      relaying an accusation we cannot substantiate.
 *
 * The true code is still stored on card_decline_events and still shown to
 * admins — that split is the whole reason the raw codes go in the table.
 * `adminLabel` below is the admin wording; it must never reach an email.
 *
 * The other thing that never reaches a customer is Stripe's own
 * `charge.outcome.seller_message`. Its name says who it is for, and it spells
 * the suppressed code out in plain English ("The bank returned the decline code
 * lost_card"). sendCardDeclinedEmail has no parameter for it, which makes that
 * a compile-time guarantee rather than a comment.
 */

/** The reasons we are willing to describe to a customer. */
export type DeclineReasonKey =
  | "insufficient_funds"
  | "expired_card"
  | "incorrect_cvc"
  | "incorrect_number"
  | "incorrect_expiry"
  | "authentication_required"
  | "processing_error"
  | "try_again_later"
  | "generic_decline"
  | "card_not_supported"
  | "currency_not_supported"
  | "transaction_not_allowed"
  | "card_velocity_exceeded"
  | "withdrawal_count_limit_exceeded"
  | "invalid_account"
  | "new_account_information_available"
  | "bank_declined"
  | "unknown";

export interface DeclineCopy {
  /** Customer-facing, short. Leads the email. */
  headline: string;
  /** One sentence: what happened. */
  explain: string;
  /** One sentence: what they should do about it. */
  fix: string;
  /** Blunt wording for the admin badge. NEVER shown to a customer. */
  adminLabel: string;
}

/**
 * Codes whose true meaning is withheld from the customer. See the file header.
 *
 * Some of these arrive as `decline_code` and some as `code` — `fraudulent` in
 * particular — so declineReasonKey() tests both against this list, and does so
 * BEFORE any table lookup so no later branch can leak one.
 */
export const SUPPRESSED_DECLINE_CODES: readonly string[] = [
  "lost_card",
  "stolen_card",
  "pickup_card",
  "fraudulent",
  "merchant_blacklist",
  "restricted_card",
  "revocation_of_authorization",
  "security_violation",
] as const;

export function isSuppressedDeclineCode(code?: string | null): boolean {
  const normalised = normalise(code);
  return normalised !== null && SUPPRESSED_DECLINE_CODES.includes(normalised);
}

export const DECLINE_COPY: Record<DeclineReasonKey, DeclineCopy> = {
  insufficient_funds: {
    headline: "There weren't enough funds on the card",
    explain:
      "Your bank declined the payment because there wasn't enough available on the card at the time.",
    fix: "Top the account up and pay below, or use a different card.",
    adminLabel: "insufficient funds",
  },
  expired_card: {
    headline: "The card has expired",
    explain: "The card we have on file has passed its expiry date.",
    fix: "Add your new card in Settings and we'll take it from there.",
    adminLabel: "expired card",
  },
  incorrect_cvc: {
    headline: "The security code didn't match",
    explain:
      "The short security code on the card didn't match your bank's records.",
    fix: "Re-enter the card in Settings, checking the security code on the back.",
    adminLabel: "CVC wrong",
  },
  incorrect_number: {
    headline: "The card number wasn't accepted",
    explain: "The card number didn't pass your bank's check.",
    fix: "Re-enter the card number in Settings.",
    adminLabel: "card number wrong",
  },
  incorrect_expiry: {
    headline: "The expiry date didn't match",
    explain: "The expiry date on file didn't match your bank's records.",
    fix: "Re-enter the card in Settings with the correct expiry date.",
    adminLabel: "expiry wrong",
  },
  authentication_required: {
    headline: "Your bank wants you to approve it",
    explain:
      "Your bank needs you to confirm this payment yourself — usually a tap in your banking app or a code by text.",
    fix: "Use the payment button below; the confirmation happens on that page.",
    adminLabel: "3DS not completed",
  },
  processing_error: {
    headline: "A temporary problem at the bank",
    explain:
      "Something went wrong at your bank's end while the payment was going through. There is nothing wrong with your card.",
    fix: "Nothing to change — pay below, or leave it and we'll try again.",
    adminLabel: "processing error",
  },
  try_again_later: {
    headline: "Your bank asked us to try again later",
    explain:
      "Your bank declined this attempt and asked us to come back to it later.",
    fix: "Nothing to change. If the next attempt fails too, it's worth a call to your bank.",
    adminLabel: "try again later",
  },
  generic_decline: {
    headline: "Your bank declined the payment",
    explain:
      "Your bank declined the payment without telling us why — often a security block on a payment it hasn't seen before.",
    fix: "Call the number on the back of your card and ask them to allow it, or use another card.",
    adminLabel: "generic decline",
  },
  card_not_supported: {
    headline: "This card can't be used for this",
    explain:
      "Your bank doesn't allow this card to be used for this kind of payment.",
    fix: "Add a different card in Settings.",
    adminLabel: "card not supported",
  },
  currency_not_supported: {
    headline: "The card can't pay in pounds",
    explain: "This card can't be charged in pounds sterling.",
    fix: "Add a card that can pay in pounds.",
    adminLabel: "currency not supported",
  },
  transaction_not_allowed: {
    headline: "Your bank blocked this transaction",
    explain: "Your bank doesn't allow this type of payment on this card.",
    fix: "Ask your bank to allow it, or use a different card.",
    adminLabel: "transaction not allowed",
  },
  card_velocity_exceeded: {
    headline: "The card has hit a spending limit",
    explain: "The card has reached a spending limit set by your bank.",
    fix: "Wait for the limit to reset, ask your bank to raise it, or use another card.",
    adminLabel: "velocity limit",
  },
  withdrawal_count_limit_exceeded: {
    headline: "The card has hit a transaction limit",
    explain:
      "The card has reached the number of transactions your bank allows in this period.",
    fix: "Wait for the limit to reset, or use another card.",
    adminLabel: "transaction limit",
  },
  invalid_account: {
    headline: "The account isn't available",
    explain:
      "Your bank says the account behind this card isn't valid or is no longer open.",
    fix: "Add a different card in Settings.",
    adminLabel: "invalid account",
  },
  new_account_information_available: {
    headline: "The card details have changed",
    explain: "Your bank says this card has been replaced with new details.",
    fix: "Add the replacement card in Settings.",
    adminLabel: "card replaced",
  },
  bank_declined: {
    // The suppression bucket. Deliberately says nothing about why.
    headline: "Your bank declined the payment",
    explain:
      "Your bank declined the payment and hasn't told us why. Only they can say what happened.",
    fix: "Call the number on the back of your card, or use a different card.",
    adminLabel: "bank declined (see code)",
  },
  unknown: {
    headline: "The payment didn't go through",
    explain:
      "Your bank declined the payment and we don't have a reason from them.",
    fix: "Try paying below with the same card, or add a different one.",
    adminLabel: "unknown",
  },
};

/**
 * Stripe code → the reason we describe.
 *
 * ⚠️ `card_declined` is DELIBERATELY ABSENT. It is the outer `code` that
 * accompanies a specific `decline_code`, so if it were in this table it would
 * shadow every specific reason and collapse the whole feature into one generic
 * message. `{ code: "card_declined" }` on its own must fall through to
 * "unknown".
 */
const CODE_TO_KEY: Record<string, DeclineReasonKey> = {
  insufficient_funds: "insufficient_funds",

  expired_card: "expired_card",

  incorrect_cvc: "incorrect_cvc",
  invalid_cvc: "incorrect_cvc",

  incorrect_number: "incorrect_number",
  invalid_number: "incorrect_number",

  incorrect_expiry: "incorrect_expiry",
  invalid_expiry_month: "incorrect_expiry",
  invalid_expiry_year: "incorrect_expiry",

  authentication_required: "authentication_required",

  processing_error: "processing_error",
  try_again_later: "try_again_later",

  do_not_honor: "generic_decline",
  generic_decline: "generic_decline",

  card_not_supported: "card_not_supported",
  currency_not_supported: "currency_not_supported",
  transaction_not_allowed: "transaction_not_allowed",

  card_velocity_exceeded: "card_velocity_exceeded",
  withdrawal_count_limit_exceeded: "withdrawal_count_limit_exceeded",

  invalid_account: "invalid_account",
  new_account_information_available: "new_account_information_available",
};

function normalise(value?: string | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed === "" ? null : trimmed;
}

/**
 * Which reason to describe, given whatever Stripe returned.
 *
 * ORDER IS THE RULE, not an implementation detail:
 *   1. Suppression, on either field, before anything else — so no lookup can
 *      leak a fraud-flavoured code however the table later changes.
 *   2. `declineCode` (Stripe's specific reason from the issuer).
 *   3. `code` (the broader error code — where expired_card, incorrect_cvc,
 *      authentication_required and processing_error normally arrive).
 *   4. `failureCode` (from the Charge, when no PaymentIntent error existed).
 *   5. "unknown" — a normal outcome, not a failure. The customer still gets an
 *      email, because they still need to fix it.
 */
export function declineReasonKey(input: {
  declineCode?: string | null;
  code?: string | null;
  failureCode?: string | null;
}): DeclineReasonKey {
  if (
    isSuppressedDeclineCode(input.declineCode) ||
    isSuppressedDeclineCode(input.code) ||
    isSuppressedDeclineCode(input.failureCode)
  ) {
    return "bank_declined";
  }

  for (const candidate of [input.declineCode, input.code, input.failureCode]) {
    const normalised = normalise(candidate);
    if (normalised && CODE_TO_KEY[normalised]) return CODE_TO_KEY[normalised];
  }

  return "unknown";
}

export function declineCopyFor(key: DeclineReasonKey): DeclineCopy {
  return DECLINE_COPY[key] ?? DECLINE_COPY.unknown;
}

/** True when the key was reached by suppression rather than by the table. */
export function isSuppressedKey(key: DeclineReasonKey): boolean {
  return key === "bank_declined";
}
