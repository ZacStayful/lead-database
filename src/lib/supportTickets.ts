import type { LeadType } from "@/lib/types";

/**
 * The support-ticket vocabulary, labels and validators (CLAUDE.md §46).
 *
 * ⚠️ THIS MODULE MUST STAY FREE OF SERVER IMPORTS. `SupportTicketsTable` is a
 * `"use client"` component and needs the status labels, so nothing here may
 * reach `supabase-js`, `crypto`, or `emails.ts` — the same trap
 * `featureRequest.ts` records, for the same reason. Anything needing a database
 * client or the product/plan helpers lives in `supportTicketLog.ts`.
 *
 * Everything here is pure, so it is unit-testable: `vitest.config.mts` is
 * pure-units-only and the repo has no route-test harness.
 */

/** Which door a ticket came through. Mirrors 0133's `source` CHECK. */
export const TICKET_SOURCES = ["feedback_form", "support_form", "admin"] as const;
export type TicketSource = (typeof TICKET_SOURCES)[number];

/** What kind of ask it is. Mirrors 0133's `kind` CHECK. */
export const TICKET_KINDS = ["support", "feature", "bug"] as const;
export type TicketKind = (typeof TICKET_KINDS)[number];

/** Where it has got to. Mirrors 0133's `status` CHECK. */
export const TICKET_STATUSES = ["open", "in_progress", "done", "wont_do"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** How the customer actually reached us. Mirrors 0133's `channel` CHECK. */
export const TICKET_CHANNELS = ["in_app", "email", "whatsapp", "phone"] as const;
export type TicketChannel = (typeof TICKET_CHANNELS)[number];

/** A ticket in one of these is finished and stamps `resolved_at`. */
export const TERMINAL_STATUSES: readonly TicketStatus[] = ["done", "wont_do"];

/** Length ceilings, mirroring 0133's CHECK constraints exactly. */
export const MAX_SUBMITTER_NAME = 120;
export const MAX_SUBMITTER_EMAIL = 200;
export const MAX_SUBMITTER_BUSINESS = 200;
export const MAX_SUBJECT = 200;
export const MAX_BODY = 10000;
export const MAX_PAGE = 80;
export const MAX_NOTE = 5000;
export const MAX_CLAUDE_SECTION = 40;

/**
 * The human reference, e.g. `STF-0007`.
 *
 * Formatting lives here rather than in the schema so it can change without a
 * migration — the §43.2 discipline that keeps the reset ceilings in TypeScript
 * while `consume_reset_budget` has no opinion about them. Past 9999 it simply
 * grows a digit rather than truncating: a wrong reference on a customer email
 * is worse than a long one.
 */
export function ticketReference(reference: number): string {
  return `STF-${String(reference).padStart(4, "0")}`;
}

/** What an admin sees. Blunt on purpose — this is the working queue. */
export function adminStatusLabel(status: TicketStatus): string {
  switch (status) {
    case "open":
      return "Open";
    case "in_progress":
      return "In progress";
    case "done":
      return "Done";
    case "wont_do":
      return "Won't do";
  }
}

/**
 * What the customer sees on their own ticket.
 *
 * ⚠️ `wont_do` MUST NEVER RENDER TO A CUSTOMER AS "Won't do". They asked us for
 * something and a blunt refusal in a dashboard, with no accompanying sentence
 * and nobody to reply to, reads as contempt. "Not planned" is GitHub's own
 * wording for the same state and describes the decision rather than dismissing
 * the person. `in_progress` likewise says what is happening to their request,
 * not what our queue calls it.
 */
export function customerStatusLabel(status: TicketStatus): string {
  switch (status) {
    case "open":
      return "Logged";
    case "in_progress":
      return "Being worked on";
    case "done":
      return "Done";
    case "wont_do":
      return "Not planned";
  }
}

/** Human label for the ticket's kind. */
export function kindLabel(kind: TicketKind): string {
  switch (kind) {
    case "support":
      return "Support";
    case "feature":
      return "Feature request";
    case "bug":
      return "Bug";
  }
}

/** Human label for how it reached us. */
export function channelLabel(channel: TicketChannel): string {
  switch (channel) {
    case "in_app":
      return "In app";
    case "email":
      return "Email";
    case "whatsapp":
      return "WhatsApp";
    case "phone":
      return "Phone";
  }
}

/**
 * Whether a ticket from this source is shown back to the customer.
 *
 * ⚠️ A FORM TICKET IS THE CUSTOMER'S OWN WORDS; A HAND-LOGGED ONE IS OURS ABOUT
 * THEM. Showing somebody the request they typed is honest. Showing them an
 * admin's summary of a phone call — which may reasonably read "sounds like she
 * is about to churn" — is not. So `admin` defaults to hidden and sharing one is
 * a deliberate second act through PATCH. The column defaults `false` in the
 * database too, so a writer that forgets to call this fails closed.
 *
 * An anonymous submission is never visible: there is nobody to show it to, and
 * `customer_id is null` can never match the customer read's `.eq` on a uuid.
 */
export function defaultVisibility(
  source: TicketSource,
  customerId: string | null
): boolean {
  if (!customerId) return false;
  return source === "feedback_form" || source === "support_form";
}

/**
 * When a ticket is resolved, given the status it is moving to.
 *
 * ⚠️ Deliberately CLEARS on a return to open or in_progress, unlike
 * `cancelled_at` (first cancellation wins, §3) and `pool_first_entered_at`
 * (stamped once and never cleared, §19). A support ticket legitimately
 * round-trips — reopened because the fix did not work — and a stale resolved
 * date printed beside an open ticket is a lie the admin list would render.
 */
export function nextResolvedAt(status: TicketStatus, now: Date): string | null {
  return TERMINAL_STATUSES.includes(status) ? now.toISOString() : null;
}

/**
 * The CLOSED ALLOW-LIST of fields a PATCH may write.
 *
 * ⚠️ THE KEY COMES FROM THIS LIST, NEVER FROM THE BODY — the §40.14 rule that
 * `adminSettings.ts` states for `system_settings`, and it matters as much here.
 * `status`, `reference`, `source`, `customer_id`, `submitted_at` and
 * `backfill_key` are all absent, so no shape of PATCH body can rewrite who
 * raised a ticket, when they raised it, or its reference. Status has its own
 * route because it is one field pressed from a table row.
 */
export const TICKET_PATCH_FIELDS = [
  "kind",
  "product",
  "visible_to_customer",
  "shipped_migration",
  "shipped_claude_section",
] as const;
export type TicketPatchField = (typeof TICKET_PATCH_FIELDS)[number];

export type Verdict<T> = { ok: true; value: T } | { ok: false; error: string };

function str(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

function capped(
  raw: unknown,
  max: number,
  field: string
): Verdict<string | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, error: `${field} must be text.` };
  const value = raw.trim();
  if (!value) return { ok: true, value: null };
  if (value.length > max) {
    return { ok: false, error: `${field} must be ${max} characters or fewer.` };
  }
  return { ok: true, value };
}

export type TicketWrite = {
  kind: TicketKind;
  channel: TicketChannel;
  customer_id: string | null;
  submitter_name: string;
  submitter_email: string;
  submitter_business: string | null;
  subject: string;
  body: string;
  product: LeadType | null;
  submitted_at: string | null;
};

/**
 * Validate a hand-logged ticket.
 *
 * ⚠️ `submitted_at` IS settable here and nowhere else: a phone call logged the
 * next morning happened yesterday, and forcing it to `now()` would put it out
 * of order in a list that sorts on exactly that column. `visible_to_customer`
 * is NOT settable on create — the announcements create route refuses `status`
 * for the same reason, that there is no shape of request which should bring
 * something into existence already shared.
 */
export function validateTicketWrite(body: unknown): Verdict<TicketWrite> {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Expected an object." };
  }
  const b = body as Record<string, unknown>;

  const kind = str(b.kind);
  if (!kind || !TICKET_KINDS.includes(kind as TicketKind)) {
    return { ok: false, error: `Kind must be one of: ${TICKET_KINDS.join(", ")}.` };
  }

  const rawChannel = str(b.channel) ?? "email";
  if (!TICKET_CHANNELS.includes(rawChannel as TicketChannel)) {
    return {
      ok: false,
      error: `Channel must be one of: ${TICKET_CHANNELS.join(", ")}.`,
    };
  }

  const name = capped(b.submitter_name, MAX_SUBMITTER_NAME, "Name");
  if (!name.ok) return name;
  if (!name.value) return { ok: false, error: "A name is required." };

  const email = capped(b.submitter_email, MAX_SUBMITTER_EMAIL, "Email");
  if (!email.ok) return email;
  if (!email.value) return { ok: false, error: "An email address is required." };

  const business = capped(b.submitter_business, MAX_SUBMITTER_BUSINESS, "Business");
  if (!business.ok) return business;

  const subject = capped(b.subject, MAX_SUBJECT, "Subject");
  if (!subject.ok) return subject;
  if (!subject.value) return { ok: false, error: "A subject is required." };

  const text = capped(b.body, MAX_BODY, "Details");
  if (!text.ok) return text;
  if (!text.value) return { ok: false, error: "The details are required." };

  const productVerdict = readProduct(b.product);
  if (!productVerdict.ok) return productVerdict;

  let submittedAt: string | null = null;
  if (b.submitted_at !== undefined && b.submitted_at !== null) {
    if (typeof b.submitted_at !== "string") {
      return { ok: false, error: "The date must be text." };
    }
    const parsed = new Date(b.submitted_at);
    if (Number.isNaN(parsed.getTime())) {
      return { ok: false, error: "That is not a date we can read." };
    }
    submittedAt = parsed.toISOString();
  }

  const customerId = str(b.customer_id);

  return {
    ok: true,
    value: {
      kind: kind as TicketKind,
      channel: rawChannel as TicketChannel,
      customer_id: customerId,
      submitter_name: name.value,
      submitter_email: email.value,
      submitter_business: business.value,
      subject: subject.value,
      body: text.value,
      product: productVerdict.value,
      submitted_at: submittedAt,
    },
  };
}

function readProduct(raw: unknown): Verdict<LeadType | null> {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, value: null };
  }
  if (raw !== "management" && raw !== "guaranteed_rent") {
    return {
      ok: false,
      error: "Product must be management, guaranteed_rent, or left blank.",
    };
  }
  return { ok: true, value: raw };
}

/**
 * Validate a partial update, over `TICKET_PATCH_FIELDS` only.
 *
 * ⚠️ THE TYPE CHECK COMES BEFORE ANY COERCION. `Number(true)` is 1 and
 * `Number(null)` is 0, both finite — §40.14 caught exactly that bug in the
 * messaging settings route, where a boolean posted at a number field stored as
 * "1". Here it bites on `visible_to_customer`, where a truthy coercion would
 * silently publish an admin's private note-taking to a customer's dashboard.
 */
export function validateTicketPatch(
  body: unknown
): Verdict<Record<string, unknown>> {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Expected an object." };
  }
  const b = body as Record<string, unknown>;
  const patch: Record<string, unknown> = {};

  for (const key of Object.keys(b)) {
    if (!TICKET_PATCH_FIELDS.includes(key as TicketPatchField)) {
      return { ok: false, error: `Unknown field: ${key}` };
    }
  }

  if ("kind" in b) {
    const kind = str(b.kind);
    if (!kind || !TICKET_KINDS.includes(kind as TicketKind)) {
      return { ok: false, error: `Kind must be one of: ${TICKET_KINDS.join(", ")}.` };
    }
    patch.kind = kind;
  }

  if ("product" in b) {
    const verdict = readProduct(b.product);
    if (!verdict.ok) return verdict;
    patch.product = verdict.value;
  }

  if ("visible_to_customer" in b) {
    if (typeof b.visible_to_customer !== "boolean") {
      return { ok: false, error: "visible_to_customer must be true or false." };
    }
    patch.visible_to_customer = b.visible_to_customer;
  }

  if ("shipped_migration" in b) {
    const raw = b.shipped_migration;
    if (raw === null || raw === "") {
      patch.shipped_migration = null;
    } else if (typeof raw !== "string" || !/^[0-9]{4}[a-z]?$/.test(raw.trim())) {
      return {
        ok: false,
        error: "A migration reference looks like 0133, or 0100a.",
      };
    } else {
      patch.shipped_migration = raw.trim();
    }
  }

  if ("shipped_claude_section" in b) {
    const verdict = capped(
      b.shipped_claude_section,
      MAX_CLAUDE_SECTION,
      "The CLAUDE.md section"
    );
    if (!verdict.ok) return verdict;
    patch.shipped_claude_section = verdict.value;
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, error: "Nothing to update." };
  }
  return { ok: true, value: patch };
}

/** Validate the tick-box / status select. */
export function validateStatusWrite(body: unknown): Verdict<TicketStatus> {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Expected an object." };
  }
  const status = str((body as Record<string, unknown>).status);
  if (!status || !TICKET_STATUSES.includes(status as TicketStatus)) {
    return {
      ok: false,
      error: `Status must be one of: ${TICKET_STATUSES.join(", ")}.`,
    };
  }
  return { ok: true, value: status as TicketStatus };
}

/** Validate an appended note. */
export function validateNoteWrite(body: unknown): Verdict<string> {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Expected an object." };
  }
  const verdict = capped((body as Record<string, unknown>).body, MAX_NOTE, "A note");
  if (!verdict.ok) return verdict;
  if (!verdict.value) return { ok: false, error: "A note cannot be empty." };
  return { ok: true, value: verdict.value };
}
