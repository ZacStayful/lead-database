// ============================================================================
// Live contact verification for the 'invalid_contact' reject reason.
//
// checkPhone  -> Twilio Lookup v2 (Line Type Intelligence add-on required).
// checkEmail  -> ZeroBounce validate.
//
// Both calls are bounded by a short per-call timeout and fail SAFE: any network
// error, timeout, missing credential or unparseable response resolves to
// 'inconclusive', which resolveContactClaim treats as "could not verify" and
// processes the reject as normal (favoured_customer). We never deny a customer's
// claim on the strength of a call we couldn't actually complete.
//
// PII rule: never log the raw phone, email or provider response body. Only the
// outcome + status strings are safe to log; the full record is persisted to
// lead_assignments.contact_validation_result (access-controlled), not to logs.
// ============================================================================

type PhoneResult = { status: "valid_mobile" | "invalid" | "inconclusive" };
type EmailResult = { status: "valid" | "invalid" | "inconclusive" };

const EXTERNAL_CALL_TIMEOUT_MS = 6000;

function toE164UK(rawPhone: string): string {
  const cleaned = rawPhone.replace(/[\s\-()]/g, "");
  return cleaned.startsWith("+") ? cleaned : cleaned.replace(/^0/, "+44");
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = EXTERNAL_CALL_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function checkPhone(rawPhone: string | null): Promise<PhoneResult> {
  // No number on file, or credentials missing -> can't verify.
  if (!rawPhone || !rawPhone.trim()) return { status: "inconclusive" };
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    return { status: "inconclusive" };
  }

  try {
    const e164 = toE164UK(rawPhone);
    // Buffer is used here deliberately — this requires the Node.js runtime (not
    // Edge). If this ever needs to run on Edge, replace with
    // btoa(`${sid}:${token}`) instead.
    const auth = Buffer.from(
      `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
    ).toString("base64");

    const res = await fetchWithTimeout(
      `https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(
        e164
      )}?Fields=line_type_intelligence`,
      { headers: { Authorization: `Basic ${auth}` } }
    );
    if (!res.ok) return { status: "inconclusive" };

    const data = await res.json();
    if (!data.valid) return { status: "invalid" };

    const lineType = data.line_type_intelligence?.type;
    if (lineType === "mobile") return { status: "valid_mobile" };
    return { status: "invalid" }; // real number, but not a mobile — doesn't clear the claim
  } catch {
    // Covers network errors AND our own timeout abort — both are "couldn't verify."
    return { status: "inconclusive" };
  }
}

export async function checkEmail(email: string | null): Promise<EmailResult> {
  if (!email || !email.trim()) return { status: "inconclusive" };
  if (!process.env.ZEROBOUNCE_API_KEY) return { status: "inconclusive" };

  try {
    const url = `https://api.zerobounce.net/v2/validate?api_key=${process.env.ZEROBOUNCE_API_KEY}&email=${encodeURIComponent(
      email
    )}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return { status: "inconclusive" };

    const data = await res.json();
    if (data.status === "valid") return { status: "valid" };
    if (data.status === "invalid") return { status: "invalid" };
    // catch-all, unknown, spamtrap, abuse, do_not_mail — ambiguous, not a clean pass
    return { status: "inconclusive" };
  } catch {
    return { status: "inconclusive" };
  }
}

export type ClaimOutcome = "claim_confirmed" | "claim_denied" | "favoured_customer";

export type ContactValidationResult = {
  outcome: ClaimOutcome;
  phoneStatus: PhoneResult["status"];
  emailStatus: EmailResult["status"];
  checkedAt: string;
};

export async function resolveContactClaim(
  phone: string | null,
  email: string | null,
  now: string = new Date().toISOString()
): Promise<ContactValidationResult> {
  const [phoneResult, emailResult] = await Promise.all([
    checkPhone(phone),
    checkEmail(email),
  ]);

  let outcome: ClaimOutcome;
  if (
    phoneResult.status === "inconclusive" ||
    emailResult.status === "inconclusive"
  ) {
    outcome = "favoured_customer"; // can't verify one or both — process the reject as normal
  } else if (
    phoneResult.status === "valid_mobile" &&
    emailResult.status === "valid"
  ) {
    outcome = "claim_denied"; // both genuinely check out — deny automatically
  } else {
    outcome = "claim_confirmed"; // at least one genuinely failed — process the reject as normal
  }

  return {
    outcome,
    phoneStatus: phoneResult.status,
    emailStatus: emailResult.status,
    checkedAt: now,
  };
}
