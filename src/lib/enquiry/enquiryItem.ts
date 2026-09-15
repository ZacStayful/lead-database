/**
 * Deciding what to do with one item on the Monday enquiries board (§57).
 *
 * Facebook lead ads write into board 18420649520, group `topics` / "New
 * enquiries" — the same board, group and column ids POST /api/enquiry writes
 * to. This module is the pure half of the sync that turns such an item into an
 * enquiry: no client, no clock of its own, every input passed in. The route is
 * the only thing that touches the database.
 *
 * ⚠️ NOTHING HERE MAY BE MADE CONFIGURABLE. Every constant below protects a
 * timing detail of Monday's Facebook integration or a bound on what can be
 * chased, not a policy an admin should be weighing up. A `system_settings` row
 * invites somebody to set the settle delay to 0 to "make it faster", and the
 * failure that produces is a customer created from a half-populated item.
 */

import { isJunkName } from "@/lib/leadQuality";

/**
 * How old an item must be before we read it.
 *
 * ⚠️ MONDAY'S FACEBOOK INTEGRATION CREATES THE ITEM AND THEN POPULATES THE
 * CELLS. Measured on the live board: a Meta test lead created at 13:35:21Z
 * carried a "Date added" cell reading 19:35 — six hours out, so something
 * wrote that row after creating it. Reading at t+0 can therefore yield a name
 * with no email, which would create a useless customer AND burn the item's one
 * claim, so the real data would never be picked up.
 *
 * It also removes the race where the website route has created its Monday item
 * but not yet written the customer row.
 *
 * ⚠️ But a delay cannot PROVE the cells arrived — `missing_email` below is the
 * structural guarantee, because it defers without claiming. The delay reduces
 * churn; the defer is what makes late cells correct.
 */
export const ITEM_SETTLE_MS = 60_000;

/**
 * How old an item may be and still start a booking chase.
 *
 * ⚠️ THIS, NOT THE CUTOFF ROW, IS WHAT MAKES FORWARD-ONLY SAFE. §32.4 and
 * 0149's header both reject a global `system_settings` cutoff for exactly this
 * shape of rule — a global is one bad read away from enrolling the whole back
 * catalogue. The answer is to bound the LADDER rather than the ingest: an item
 * older than this is still turned into a customer (a lead is never lost) and
 * is never chased. So the worst case of a cutoff misread to 1970 is a few
 * dozen idempotent customer upserts and ZERO MESSAGES SENT.
 */
export const MAX_CHASE_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * How long an item with no email cell is waited on before being given up on.
 *
 * `customers.email` is `not null unique`, so an item with no email cannot
 * become a customer at all. Deferring rather than claiming is what lets a
 * late-populating cell still land; this bounds the deferring so a genuinely
 * empty item does not get re-read for ever.
 */
export const INCOMPLETE_ITEM_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * The Status labels an item may carry and still be ingested.
 *
 * ⚠️ NOTHING ON A MONDAY ITEM SAYS WHERE IT CAME FROM. Checked on the live
 * board: the Meta test lead, the website enquiries and the hand-typed ones all
 * report the same `creator_id`. There is no integration marker to key on, so
 * the status cell is the discriminator instead — Facebook and the website both
 * leave it on "New Enquiries", and setting any other status is a deliberate
 * one-click opt-out on the board for somebody already being worked by hand.
 *
 * An empty cell counts: a brand-new item can arrive before the status is set.
 */
export const INGESTABLE_STATUS_LABELS: readonly string[] = ["New Enquiries"];

/** Domains that only ever appear in a test submission. */
const TEST_EMAIL_DOMAINS = new Set([
  "meta.com",
  "facebook.com",
  "example.com",
  "test.com",
]);

/**
 * Meta's test-lead shape. Its testing tool stamps this phrase into EVERY field
 * — `test lead: dummy data for full_name`, `…for contact_number`, `…for
 * prefered_plan` — so checking every cell rather than just the name catches a
 * partially populated one too.
 */
const META_DUMMY = /\btest lead\b|\bdummy data\b/i;

/** Deliberately loose: the strict check is `ukMobileE164`, not this. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type EnquiryJunkReason = "meta_dummy" | "test_email" | "junk_name";

export interface EnquiryItemFields {
  name: string;
  email: string;
  mobile: string;
  websiteUrl: string;
  propertiesManaged: string;
  preferredPlan: string;
  currentLeadSource: string;
}

/**
 * Why this item does not describe a real person, or null if it does.
 *
 * ⚠️ A REASON, NEVER A BOOLEAN. "Why was that lead dropped" is the only
 * question anyone will ever ask of this function, and §40.8 records twenty
 * webhook events discarded silently because the drop path returned nothing
 * anybody could see.
 */
export function enquiryJunkReason(
  fields: EnquiryItemFields
): EnquiryJunkReason | null {
  // ⚠️ RULE 1 IS THE LOAD-BEARING ONE, AND isJunkName IS THE SECOND LINE, NOT
  // THE FIRST. Verified by running it: isJunkName("test lead: dummy data for
  // full_name") returns FALSE — the string has no digits, no "@", plenty of
  // letters, no repeated run, is not a placeholder word, and the no-vowel rule
  // is skipped because ":" and "_" put it outside basic Latin. Delete this
  // rule believing the name check covers it and Meta's test leads become
  // customers and get WhatsApped.
  const cells = [
    fields.name,
    fields.email,
    fields.mobile,
    fields.websiteUrl,
    fields.propertiesManaged,
    fields.preferredPlan,
    fields.currentLeadSource,
  ];
  if (cells.some((cell) => META_DUMMY.test(String(cell ?? "")))) {
    return "meta_dummy";
  }

  const domain = String(fields.email ?? "").trim().toLowerCase().split("@")[1];
  if (domain && TEST_EMAIL_DOMAINS.has(domain)) return "test_email";

  // Reused verbatim rather than re-derived. §36.3 carries the measurement that
  // keeps it neither too strict nor too loose — 87 of 437 live leads are a
  // lone first name, so a rule demanding a surname would discard a fifth of
  // the book.
  if (isJunkName(fields.name)) return "junk_name";

  return null;
}

export type EnquiryItemAction = "ingest" | "defer" | "skip";

export type EnquiryItemSkipReason =
  | "no_cutoff"
  | "before_cutoff"
  | "not_new_status"
  | "bad_email"
  | "stale_incomplete"
  | EnquiryJunkReason;

export type EnquiryItemDeferReason = "settling" | "missing_email";

export interface EnquiryItemDecision {
  action: EnquiryItemAction;
  /** Set when `action` is "skip". */
  skip?: EnquiryItemSkipReason;
  /** Set when `action` is "defer". */
  defer?: EnquiryItemDeferReason;
  /**
   * Whether a booking chase may start. False for an item past
   * MAX_CHASE_AGE_MS: the customer is still created, nothing is sent.
   */
  chase: boolean;
}

export interface EnquiryItemInput {
  fields: EnquiryItemFields;
  statusLabel: string;
  /** The Monday API's `created_at`. ⚠️ NEVER the board's "Date added" cell. */
  createdAt: Date | null;
  /** Parsed from `enquiry_sync_from`. Null means unreadable — ingest nothing. */
  cutoff: Date | null;
  now: Date;
}

/**
 * What to do with one board item.
 *
 * ⚠️ THE ORDER IS THE RULE, AND THE CALLER MUST CLAIM BETWEEN "skip/defer" AND
 * THE WRITE. Everything answered here is decided WITHOUT a claim, because
 * claiming a half-populated item would permanently bar it from ever being
 * ingested — which is worse than the duplicate a claim prevents.
 */
export function decideEnquiryItem(input: EnquiryItemInput): EnquiryItemDecision {
  const { fields, statusLabel, createdAt, cutoff, now } = input;

  // 1. ⚠️ FAILS CLOSED. An absent, blank or unparseable cutoff means ingest
  //    NOTHING, never "ingest everything" — §42.9's contact_notify_from rule,
  //    where getting this backwards would have emailed 326 stale prospects.
  if (!cutoff || Number.isNaN(cutoff.getTime())) {
    return { action: "skip", skip: "no_cutoff", chase: false };
  }

  // An item with no creation time cannot be placed against the cutoff, and
  // guessing would be guessing in the unsafe direction.
  if (!createdAt || Number.isNaN(createdAt.getTime())) {
    return { action: "skip", skip: "before_cutoff", chase: false };
  }

  // 2. Forward-only. A filter, not a decision about the item.
  if (createdAt.getTime() <= cutoff.getTime()) {
    return { action: "skip", skip: "before_cutoff", chase: false };
  }

  const ageMs = now.getTime() - createdAt.getTime();

  // 3. Still settling — no claim, so the next tick sees it again.
  if (ageMs < ITEM_SETTLE_MS) {
    return { action: "defer", defer: "settling", chase: false };
  }

  // 4. Somebody is working this by hand. Skipping is the safe direction: an
  //    unexpected label never starts an automated chase.
  const label = String(statusLabel ?? "").trim();
  if (label && !INGESTABLE_STATUS_LABELS.includes(label)) {
    return { action: "skip", skip: "not_new_status", chase: false };
  }

  const junk = enquiryJunkReason(fields);
  if (junk) return { action: "skip", skip: junk, chase: false };

  // 5. ⚠️ AN EMPTY EMAIL DEFERS, A MALFORMED ONE SKIPS, and they are separate
  //    outcomes because one is fixable by waiting and the other is not. The
  //    defer is the structural half of the settle delay: it claims nothing, so
  //    a cell that arrives late is still picked up.
  const email = String(fields.email ?? "").trim();
  if (!email) {
    return ageMs < INCOMPLETE_ITEM_GRACE_MS
      ? { action: "defer", defer: "missing_email", chase: false }
      : { action: "skip", skip: "stale_incomplete", chase: false };
  }
  if (!EMAIL_RE.test(email)) {
    return { action: "skip", skip: "bad_email", chase: false };
  }

  // 6. Ingest. The chase is bounded separately — see MAX_CHASE_AGE_MS.
  return { action: "ingest", chase: ageMs <= MAX_CHASE_AGE_MS };
}
