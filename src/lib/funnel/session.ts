import { normaliseEmail } from "@/lib/emailAddress";
import { ukMobileE164 } from "@/lib/leadQuality";
import { holdsProduct, type ProductCustomerFields } from "@/lib/products";

/**
 * The funnel's pure rules (batch 02 Phase 2): what n8n may send to create a
 * session, who is already set up, the preview rate limit and the switch.
 * No reads and no writes, so all of it is a pure unit under
 * vitest.config.mts's "PURE UNITS ONLY" rule; funnel/server.ts does the I/O.
 */

/** 02 Phase 2: the preview limit, per token, per rolling 24 hours. */
export const FUNNEL_PREVIEW_LIMIT = 20;
export const FUNNEL_PREVIEW_WINDOW_SECONDS = 24 * 60 * 60;

/**
 * Increment then compare (0165, consume_funnel_preview): the count includes
 * the request being judged, so the 20th preview is allowed and the 21st is
 * not. A null count is an unknown session.
 */
export function previewAllowed(count: number | null | undefined): boolean {
  return typeof count === "number" && count >= 1 && count <= FUNNEL_PREVIEW_LIMIT;
}

/**
 * Only the literal "true" is on, the way every switch here is read, and an
 * absent or unreadable value is off. The funnel takes payments, so it fails
 * closed.
 */
export function funnelEnabledFrom(value: string | null | undefined): boolean {
  return (value ?? "").trim() === "true";
}

/**
 * "Already an active or paid Management customer" (02 Phase 2). Per product,
 * through holdsProduct, never account_status alone (invariant 6). `past_due`
 * counts: they hold the product and have a card to fix, not a plan to buy.
 * A waitlisted enquirer, which every enquiry creates (§55), is not set up,
 * and nor is somebody who cancelled: both may use the funnel.
 */
export function isAlreadySetUp(customer: ProductCustomerFields | null | undefined): boolean {
  if (!customer) return false;
  return holdsProduct(customer, "management");
}

/* ------------------------------------------------------------------ *
 * POST /api/funnel/session — what n8n sends
 * ------------------------------------------------------------------ */

export interface FunnelSessionRequest {
  mondayItemId: string | null;
  name: string;
  /** Lower-case and trimmed (normaliseEmail), as funnel_sessions.email requires. */
  email: string;
  /** E.164 when it resolves to a UK mobile, otherwise as sent (§57.8). Null when absent. */
  phone: string | null;
}

export type FunnelSessionRequestError =
  | "email_invalid"
  | "name_missing"
  | "monday_item_id_invalid"
  | "management_only";

export type ParsedSessionRequest =
  | { ok: true; value: FunnelSessionRequest }
  | { ok: false; error: FunnelSessionRequestError };

const MONDAY_ID = /^[0-9]{1,20}$/;

/**
 * A closed set of named fields (the §27.1 rule): nothing else in the body
 * reaches the table. Each limit mirrors a 0165 CHECK, so a bad body is a 400
 * with a reason rather than a 23514 from the insert.
 *
 * ⚠️ Management only. The funnel never sells Guaranteed Rent (02 locked
 * decision 1), so a body naming that product is refused rather than quietly
 * sold the wrong thing.
 */
export function parseSessionRequest(body: unknown): ParsedSessionRequest {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};

  if (namesOtherProduct(b)) return { ok: false, error: "management_only" };

  const email = normaliseEmail(b.email);
  if (!email || email.length > 320) return { ok: false, error: "email_invalid" };

  const name = typeof b.name === "string" ? b.name.trim().replace(/\s+/g, " ") : "";
  if (!name) return { ok: false, error: "name_missing" };

  let mondayItemId: string | null = null;
  const rawId = b.monday_item_id;
  if (rawId !== undefined && rawId !== null && rawId !== "") {
    const id = typeof rawId === "number" && Number.isSafeInteger(rawId) ? String(rawId) : rawId;
    if (typeof id !== "string" || !MONDAY_ID.test(id.trim())) {
      return { ok: false, error: "monday_item_id_invalid" };
    }
    mondayItemId = id.trim();
  }

  return {
    ok: true,
    value: {
      mondayItemId,
      name: name.slice(0, 200),
      email,
      phone: sessionPhone(b.phone),
    },
  };
}

/**
 * True when a body names a product other than Management, in any spelling
 * (`guaranteed_rent`, "Guaranteed rent", `gr`). Absent means Management: the
 * funnel sells nothing else. Shared by both funnel routes so they refuse alike.
 */
export function namesOtherProduct(body: unknown): boolean {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const raw = b.product ?? b.lead_type ?? b.leadType;
  if (raw === undefined || raw === null || raw === "") return false;
  if (typeof raw !== "string") return true;
  return raw.trim().toLowerCase().replace(/[\s-]+/g, "_") !== "management";
}

/** The order a session moves through (0165's step CHECK). */
export const FUNNEL_STEPS = [
  "started",
  "questions_done",
  "previewed",
  "checkout_started",
  "paid",
] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];

/**
 * A step only ever moves forward: previewing again after starting checkout
 * must not walk the session back to `previewed`, and nothing here may stamp
 * `paid` (only payment does, with paid_at, in Phase 5).
 */
export function advanceStep(current: FunnelStep, reached: Exclude<FunnelStep, "paid">): FunnelStep {
  return FUNNEL_STEPS.indexOf(reached) > FUNNEL_STEPS.indexOf(current) ? reached : current;
}

/**
 * The phone as it should be stored. A UK mobile becomes E.164; anything else
 * is kept as sent, because a number nobody can read is still something Zac can
 * see and fix (§40.9A, §57.8). Over 40 characters is not a phone number and is
 * dropped, matching the 0165 CHECK.
 */
export function sessionPhone(raw: unknown): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const text = String(raw).trim();
  if (!text) return null;
  const uk = ukMobileE164(text);
  if (uk.ok) return uk.value;
  return text.length <= 40 ? text : null;
}
