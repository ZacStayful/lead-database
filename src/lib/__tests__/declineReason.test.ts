import { describe, expect, it } from "vitest";

import {
  DECLINE_COPY,
  SUPPRESSED_DECLINE_CODES,
  declineCopyFor,
  declineReasonKey,
  isSuppressedDeclineCode,
  isSuppressedKey,
  type DeclineReasonKey,
} from "@/lib/declineReason";

describe("fraud-code suppression", () => {
  it.each(SUPPRESSED_DECLINE_CODES)(
    "%s resolves to the neutral bank_declined key",
    (code) => {
      expect(declineReasonKey({ declineCode: code })).toBe("bank_declined");
      expect(declineReasonKey({ code })).toBe("bank_declined");
      expect(declineReasonKey({ failureCode: code })).toBe("bank_declined");
    }
  );

  /**
   * THE test of this module. If somebody later adds "helpful" copy for
   * stolen_card, this is what stops it reaching a cardholder.
   */
  it("says nothing about why the bank declined", () => {
    const copy = DECLINE_COPY.bank_declined;
    const customerFacing = `${copy.headline} ${copy.explain} ${copy.fix}`;
    expect(customerFacing).not.toMatch(
      /stolen|lost|fraud|blacklist|restrict|revok|security|pickup/i
    );
    for (const code of SUPPRESSED_DECLINE_CODES) {
      expect(customerFacing).not.toContain(code);
    }
  });

  it("suppresses regardless of which field carries the code", () => {
    // The real shape: decline_code is specific, code is the outer card_declined.
    expect(
      declineReasonKey({ declineCode: "stolen_card", code: "card_declined" })
    ).toBe("bank_declined");
    // fraudulent commonly arrives as `code`, not `decline_code`.
    expect(declineReasonKey({ declineCode: null, code: "fraudulent" })).toBe(
      "bank_declined"
    );
  });

  it("suppression outranks a specific reason on the other field", () => {
    // Contrived, but this is exactly what an ordering bug would look like:
    // the table lookup must never run before the suppression check.
    expect(
      declineReasonKey({
        declineCode: "lost_card",
        code: "insufficient_funds",
      })
    ).toBe("bank_declined");
  });

  it("bank_declined is reachable ONLY by suppression", () => {
    const nonSuppressed = [
      "insufficient_funds",
      "expired_card",
      "incorrect_cvc",
      "do_not_honor",
      "generic_decline",
      "processing_error",
      "authentication_required",
      "card_velocity_exceeded",
      "invalid_account",
    ];
    for (const code of nonSuppressed) {
      expect(declineReasonKey({ declineCode: code })).not.toBe("bank_declined");
    }
  });

  it("isSuppressedDeclineCode normalises and rejects non-strings", () => {
    expect(isSuppressedDeclineCode("  STOLEN_CARD ")).toBe(true);
    expect(isSuppressedDeclineCode("insufficient_funds")).toBe(false);
    expect(isSuppressedDeclineCode(null)).toBe(false);
    expect(isSuppressedDeclineCode(undefined)).toBe(false);
    expect(isSuppressedDeclineCode("")).toBe(false);
  });

  it("isSuppressedKey marks only the suppression bucket", () => {
    expect(isSuppressedKey("bank_declined")).toBe(true);
    expect(isSuppressedKey("unknown")).toBe(false);
    expect(isSuppressedKey("insufficient_funds")).toBe(false);
  });
});

describe("resolution order", () => {
  it("decline_code outranks code", () => {
    expect(
      declineReasonKey({
        declineCode: "insufficient_funds",
        code: "card_declined",
      })
    ).toBe("insufficient_funds");
  });

  it("code is used when decline_code is absent", () => {
    expect(declineReasonKey({ code: "expired_card" })).toBe("expired_card");
    expect(declineReasonKey({ code: "authentication_required" })).toBe(
      "authentication_required"
    );
  });

  it("failure_code is the last resort", () => {
    expect(declineReasonKey({ failureCode: "expired_card" })).toBe(
      "expired_card"
    );
    expect(
      declineReasonKey({ code: "processing_error", failureCode: "expired_card" })
    ).toBe("processing_error");
  });

  /**
   * card_declined is the OUTER code that accompanies a specific decline_code.
   * If it were ever in the table it would shadow every specific reason and
   * collapse the whole feature into one generic message.
   */
  it("card_declined alone falls through to unknown", () => {
    expect(declineReasonKey({ code: "card_declined" })).toBe("unknown");
    expect(declineReasonKey({ declineCode: "card_declined" })).toBe("unknown");
  });

  it("normalises case and whitespace", () => {
    expect(declineReasonKey({ declineCode: "  INSUFFICIENT_FUNDS " })).toBe(
      "insufficient_funds"
    );
  });

  it("degrades to unknown rather than throwing", () => {
    expect(declineReasonKey({})).toBe("unknown");
    expect(declineReasonKey({ declineCode: "" })).toBe("unknown");
    expect(declineReasonKey({ declineCode: "   " })).toBe("unknown");
    expect(declineReasonKey({ declineCode: "totally_made_up" })).toBe("unknown");
    expect(
      declineReasonKey({ declineCode: null, code: null, failureCode: null })
    ).toBe("unknown");
  });
});

describe("the code table", () => {
  /**
   * A literal fixture, deliberately not derived from CODE_TO_KEY — a test that
   * builds its expectation from the thing under test passes whatever changed.
   */
  const CASES: [string, DeclineReasonKey][] = [
    ["insufficient_funds", "insufficient_funds"],
    ["expired_card", "expired_card"],
    ["incorrect_cvc", "incorrect_cvc"],
    ["invalid_cvc", "incorrect_cvc"],
    ["incorrect_number", "incorrect_number"],
    ["invalid_number", "incorrect_number"],
    ["incorrect_expiry", "incorrect_expiry"],
    ["invalid_expiry_month", "incorrect_expiry"],
    ["invalid_expiry_year", "incorrect_expiry"],
    ["authentication_required", "authentication_required"],
    ["processing_error", "processing_error"],
    ["try_again_later", "try_again_later"],
    ["do_not_honor", "generic_decline"],
    ["generic_decline", "generic_decline"],
    ["card_not_supported", "card_not_supported"],
    ["currency_not_supported", "currency_not_supported"],
    ["transaction_not_allowed", "transaction_not_allowed"],
    ["card_velocity_exceeded", "card_velocity_exceeded"],
    ["withdrawal_count_limit_exceeded", "withdrawal_count_limit_exceeded"],
    ["invalid_account", "invalid_account"],
    ["new_account_information_available", "new_account_information_available"],
  ];

  it.each(CASES)("%s maps to %s", (code, key) => {
    expect(declineReasonKey({ declineCode: code })).toBe(key);
  });

  it("every key has complete, substituted copy", () => {
    for (const [key, copy] of Object.entries(DECLINE_COPY)) {
      for (const field of ["headline", "explain", "fix", "adminLabel"] as const) {
        expect(copy[field], `${key}.${field}`).toBeTruthy();
        expect(copy[field].trim(), `${key}.${field}`).not.toBe("");
        // No unsubstituted template placeholder ever reaches an inbox.
        expect(copy[field], `${key}.${field}`).not.toMatch(/\$\{|\{\{/);
      }
    }
  });

  it("declineCopyFor never returns undefined", () => {
    expect(declineCopyFor("insufficient_funds")).toBe(
      DECLINE_COPY.insufficient_funds
    );
    // An unrecognised key would be a type error, but the runtime fallback is
    // what stops a stored reason_key from a future build blanking an email.
    expect(declineCopyFor("not_a_key" as DeclineReasonKey)).toBe(
      DECLINE_COPY.unknown
    );
  });
});
