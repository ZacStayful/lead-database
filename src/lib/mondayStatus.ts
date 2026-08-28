import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ENQUIRY_STATUS,
  enquiryBoardId,
  fetchEnquiryBoardIndex,
  fetchEnquiryItem,
  phoneMatchKey,
  setEnquiryStatus,
  type EnquiryBoardItem,
  type EnquiryStatusLabel,
} from "@/lib/monday";
import { holdsProduct, type ProductCustomerFields } from "@/lib/products";
import type { Customer } from "@/lib/types";

/**
 * Which Status label a customer's item on the Monday enquiries board should
 * carry, and the machinery that puts it there.
 *
 * ONE DEFINITION, SEVERAL CALLERS — the same discipline as
 * announcementTargetsCustomer() and customer_can_see_pool_lead(). The Stripe
 * webhook, the pause route, the resume cron and the admin check tool must never
 * each carry their own reading of "is this person a customer": two readings would
 * eventually disagree, and the failure is silent in both directions.
 *
 * WHAT THIS OWNS AND WHAT THE BOARD OWNS
 * --------------------------------------
 * The column has ten labels. Five of them describe a subscription and are owned
 * here: Management Customer, Guaranteed rent customer, Paused, Cancelled, Wants to
 * pay card declined. The other five are the sales pipeline's (Web meeting
 * booked/sat/no show, In the future, In the future due to call) and are never
 * written from code — which is exactly what returning null protects.
 *
 * Group placement stays with the board's own automations. The two Customer
 * date columns do NOT: see the note on startDate in syncCustomerMondayStatus.
 */

/**
 * The columns the label rule reads — deliberately narrow, like
 * AnnouncementCandidate, so a caller cannot hand over a whole row and have some
 * unrelated column quietly start mattering.
 */
export type MondayStatusCandidate = ProductCustomerFields &
  Pick<
    Customer,
    "is_active" | "paused_at" | "cancel_at_period_end" | "gr_cancel_at_period_end"
  >;

/** Everything the orchestrator needs off the customer row. */
type MondayStatusRow = MondayStatusCandidate &
  Pick<
    Customer,
    | "id"
    | "email"
    | "contact_name"
    | "business_name"
    | "phone"
    | "monday_item_id"
    | "monday_board_id"
    | "monday_link_state"
    | "monday_status_label"
  >;

const ROW_COLUMNS =
  "id, email, contact_name, business_name, phone, is_active, paused_at, " +
  "account_status, subscription_status, gr_subscription_status, " +
  "cancel_at_period_end, gr_cancel_at_period_end, " +
  "monday_item_id, monday_board_id, monday_link_state, monday_status_label";

/**
 * The label for this customer, or null for "leave the cell alone".
 *
 * A PURE FUNCTION OF THE ROW, and that is load-bearing rather than tidy. The
 * pending-cancellation flag used to be a parameter, because Stripe's
 * `cancel_at_period_end` was stored nowhere and only the webhook branch holding the
 * event could see it. Every other hook — a GR renewal, a failed payment, a pause, a
 * resume — then recomputed the label without it, decided the customer was simply
 * active, and wrote `Management Customer` back over `Cancelled`. 0087 stores the
 * flag so no caller can get this wrong by omission.
 *
 * ORDER IS THE RULE, not an implementation detail. Read the numbered comments
 * before reordering anything.
 */
export function mondayStatusLabelFor(
  c: MondayStatusCandidate
): EnquiryStatusLabel | null {
  // 0. An archived row never drives the board. §18D: `is_active = false` means a
  //    superseded duplicate signup, and it is precisely that row which carries the
  //    board's stale email in both live mismatch cases (the archived
  //    info@thehostingedit.co.uk and leslie@homelyshortstays.com rows). Without
  //    this rule the archived row and the live one would compete for one cell.
  if (!c.is_active) return null;

  const managementHeld = holdsProduct(c, "management");
  const grHeld = holdsProduct(c, "guaranteed_rent");

  // Management cancellation, derived from subscription_status rather than
  // account_status.
  //
  // This is the trap in the re-subscribe case. `invoice.paid` used to promote
  // account_status only from 'invited'/'waitlisted', so a returning customer kept
  // account_status = 'cancelled' for ever; that is now fixed, but the rule still
  // must not depend on the fix having run, because the same row shape appears
  // between a subscription event and the invoice that follows it. Keying on
  // subscription_status means a customer who is paying reads as a customer
  // whatever account_status says.
  //
  // ENDED vs SCHEDULED TO END are separated deliberately, and the separation is
  // the whole point of this rule. `cancel_at_period_end` means the customer has
  // ASKED to leave; the subscription is still live, still billed for the period
  // they have paid for, and still owed leads. `subscription_status = 'canceled'`
  // means the service has actually stopped. Collapsing the two wrote `Cancelled`
  // on still-paying customers the moment they clicked cancel, which dropped them
  // out of the board's customer groups a fortnight early.
  const managementEnded =
    c.subscription_status === "canceled" ||
    (c.account_status === "cancelled" &&
      c.subscription_status !== "active" &&
      c.subscription_status !== "past_due");
  const managementCancelling =
    managementEnded || c.cancel_at_period_end === true;

  // The GR equivalents. Symmetric on purpose (invariant 6): without
  // gr_cancel_at_period_end a departing GR customer would keep reading as a
  // customer for their whole last paid period, while a departing management
  // customer showed as leaving immediately — the same fact reported a billing
  // period apart for no reason a reader of the board could discover.
  const grEnded = c.gr_subscription_status === "canceled";
  const grCancelling = grEnded || c.gr_cancel_at_period_end === true;

  // "Still a GR relationship": active OR past_due (a billing problem is not a
  // departure) and not on the way out.
  const grStillThere = grHeld && !grCancelling;

  // Which of the two leaving labels rules 1 and 6 should use.
  //
  // Derived ONCE rather than decided inside each branch, because the honest
  // question is about the customer and not about the branch that happens to
  // fire. Somebody whose management subscription has already ended while their
  // GR subscription is still serving out a paid period is still being delivered
  // leads, and a per-branch test reports them as Cancelled — which is exactly
  // the error this rule is being changed to fix, reintroduced one product over.
  const stillServing =
    (c.cancel_at_period_end === true && !managementEnded) ||
    (c.gr_cancel_at_period_end === true && !grEnded);
  const leavingLabel = stillServing
    ? ENQUIRY_STATUS.cancelling
    : ENQUIRY_STATUS.cancelled;

  // 1. Cancellation outranks being active — the board is read as "who is leaving"
  //    and a pending cancellation is the thing worth seeing — but a LIVE GR
  //    subscription outranks the cancellation. Somebody who cancels management and
  //    keeps GR is still a paying customer and must not read as leaving at all.
  //    Management-wins applies only between two live products.
  //
  //    Kept above Paused: a customer who is on their way out is the more
  //    important fact about them, and Cancelling says it without claiming they
  //    have already gone.
  if (managementCancelling && !grStillThere) return leavingLabel;

  // 2. Before 'Management Customer', because a paused customer is
  //    account_status = 'active' AND subscription_status = 'active' — §21 keeps the
  //    routing slot reserved — so testing "held" first would never reach Paused.
  if (c.paused_at) return ENQUIRY_STATUS.paused;

  // 3. Before rule 4, because holdsProduct() counts 'past_due' as held. That is
  //    right for "should I offer them a checkout" and wrong here, where a failed
  //    payment has its own label. Recovery needs no extra handling: invoice.paid
  //    sets subscription_status back to 'active' and rule 4 takes over.
  if (c.subscription_status === "past_due") return ENQUIRY_STATUS.card_declined;

  // 4/5. Management wins for a customer holding both.
  if (managementHeld && !managementCancelling) {
    return ENQUIRY_STATUS.management_customer;
  }
  if (c.gr_subscription_status === "active" && !grCancelling) {
    return ENQUIRY_STATUS.guaranteed_rent_customer;
  }
  if (c.gr_subscription_status === "past_due" && !grCancelling) {
    return ENQUIRY_STATUS.card_declined;
  }

  // 6. A GR customer who has left, or asked to. Reached only when management is not
  //    held, so it cannot fire on somebody who still has the other product.
  //
  //    Keyed on gr_subscription_status and gr_cancel_at_period_end, never
  //    gr_cancelled_at: invariant 6 is explicit that the GR population is
  //    gr_subscription_status, and mapStatus() already writes 'canceled' there on
  //    the cancellation event, so gr_cancelled_at would add no information and one
  //    more column whose staleness could disagree.
  if (!managementHeld && grCancelling) {
    return leavingLabel;
  }

  // 7. No commercial state to report — a waitlisted or invited prospect. Their
  //    hand-set sales label (Web meeting booked, In the future, …) must survive,
  //    so this is the safety mechanism for the whole feature, not a fallthrough.
  return null;
}

export interface MondayStatusSyncOutcome {
  written: boolean;
  label?: EnquiryStatusLabel;
  skipped?:
    | "archived"
    | "no_label"
    | "unchanged"
    | "unlinked"
    | "ambiguous"
    | "not_configured"
    | "not_status_board"
    | "missing_customer"
    | "board_unreadable";
  itemId?: string;
  error?: string;
}

export interface MondayStatusSyncOptions {
  /**
   * Real end of service, for the Customer end date cell. A date sets it, null
   * CLEARS it (the customer changed their mind), undefined leaves it untouched.
   * Only the webhook's subscription branch knows this.
   */
  endDate?: string | null;
  /** Free-text tag for the log line, e.g. "invoice.paid". */
  reason?: string;
}

/**
 * Re-evaluate one customer's board Status and push it if it changed.
 *
 * NEVER THROWS. Every caller logs and continues, following ingest.ts's SMS
 * handling and /api/enquiry's "non-fatal — we still create the account if this
 * fails". The Stripe webhook is why this is a hard contract rather than a
 * preference: that handler DELETES its stripe_events idempotency claim on any
 * throw so Stripe retries, so an exception escaping from here would make Stripe
 * redeliver an invoice that has already been credited.
 */
export async function syncCustomerMondayStatus(
  admin: SupabaseClient,
  customerId: string,
  opts?: MondayStatusSyncOptions
): Promise<MondayStatusSyncOutcome> {
  try {
    // A FRESH read, not a row passed in by the caller. Every hook site fires
    // AFTER its own .update(), so the label has to see post-update state.
    const { data: row } = await admin
      .from("customers")
      .select(ROW_COLUMNS)
      .eq("id", customerId)
      .maybeSingle<MondayStatusRow>();

    if (!row) return { written: false, skipped: "missing_customer" };

    const label = mondayStatusLabelFor(row);
    if (!label) {
      return {
        written: false,
        skipped: row.is_active ? "no_label" : "archived",
      };
    }

    // Zero Monday HTTP on a renewal. invoice.paid fires monthly per customer, so
    // without this line the board would take ~21 pointless mutations a month and
    // every one would appear in its activity log. The cache also gives the right
    // semantics on a shared board: we write on TRANSITIONS, so a manual edit to
    // the Status cell survives until the customer's next lifecycle change.
    //
    // Compared against the CACHE, not the board's current label, deliberately —
    // reading the board would make our write conditional on somebody else's edit.
    const labelUnchanged = row.monday_status_label === label;

    // With no date instruction there is nothing else that could need writing, so
    // this returns without touching Monday at all. That is the monthly
    // invoice.paid path, which is the one that matters for volume.
    if (labelUnchanged && opts?.endDate === undefined) {
      return {
        written: false,
        skipped: "unchanged",
        label,
        itemId: row.monday_item_id ?? undefined,
      };
    }

    const resolved = await resolveItem(admin, row);
    if (!resolved.item) {
      // Record a genuine Monday failure on the row as well as returning it, so a
      // revoked token or an unreachable board shows up in admin instead of the sync
      // simply going quiet. A customer who merely has no item is not an error and
      // gets no stamp — resolveItem has already recorded that as a link state.
      if (resolved.error) {
        await admin
          .from("customers")
          .update({
            monday_status_error: resolved.error.slice(0, 300),
            updated_at: new Date().toISOString(),
          })
          .eq("id", row.id);
      }
      return {
        written: false,
        skipped: resolved.skipped,
        label,
        error: resolved.error,
      };
    }

    // A date instruction costs one item read, but it must not cost a WRITE when
    // the cell already says what we want. customer.subscription.updated fires on
    // all sorts of unrelated changes and arrives here asking to clear an end date
    // that is almost always already empty; without this the board would take a
    // pointless mutation every time.
    if (labelUnchanged && !endDateNeedsWrite(resolved.item.endDate, opts?.endDate)) {
      return {
        written: false,
        skipped: "unchanged",
        label,
        itemId: resolved.item.id,
      };
    }

    // First write wins on the start date. Only sent when the cell is empty, so
    // resume-from-pause, payment recovery and re-subscribe never rewrite it.
    // Mirrors the coalesce on first_contacted_at and first-cancellation-wins on
    // cancelled_at.
    //
    // This is code-owned rather than automation-owned for a measured reason: the
    // board automation "when status changes to Management Customer, set Customer
    // start date to Now" fires on EVERY entry into that label, verified live by
    // clearing the cell and flipping Paused → Management Customer, which
    // re-stamped it. Left alone it would reset the start date of every returning
    // customer the moment this sync began writing labels.
    const isCustomerLabel =
      label === ENQUIRY_STATUS.management_customer ||
      label === ENQUIRY_STATUS.guaranteed_rent_customer;
    const startDate =
      isCustomerLabel && !resolved.item.startDate ? todayIso() : undefined;

    const write = await setEnquiryStatus({
      itemId: resolved.item.id,
      label,
      boardId: row.monday_board_id,
      startDate,
      endDate: opts?.endDate,
    });

    if (!write.written) {
      // Leave monday_status_label UNCHANGED so the customer's next event retries
      // naturally; record why for the admin surface.
      await admin
        .from("customers")
        .update({
          monday_status_error: (write.error ?? write.skipped ?? "unknown").slice(0, 300),
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      return {
        written: false,
        label,
        itemId: resolved.item.id,
        skipped: write.skipped,
        error: write.error,
      };
    }

    await admin
      .from("customers")
      .update({
        monday_status_label: label,
        monday_status_synced_at: new Date().toISOString(),
        monday_status_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);

    return { written: true, label, itemId: resolved.item.id };
  } catch (err) {
    // Belt and braces over a call chain that already returns result objects.
    return {
      written: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Would writing `desired` to the end-date cell actually change anything?
 *
 * `undefined` means "leave it alone", so never. Otherwise compare on the date part
 * only: Monday returns a date cell as "YYYY-MM-DD" or "YYYY-MM-DD HH:MM" depending
 * on whether a time was ever set, and the board's own automation used to write the
 * timed form. Comparing raw strings would treat "2026-08-17 09:05" and "2026-08-17"
 * as different and rewrite the cell on every event.
 */
export function endDateNeedsWrite(
  cell: string,
  desired: string | null | undefined
): boolean {
  if (desired === undefined) return false;
  const current = (cell ?? "").trim().slice(0, 10);
  return current !== (desired ?? "");
}

/** Customer fields the matcher compares against the board. */
export type MondayMatchCandidate = Pick<
  Customer,
  "email" | "contact_name" | "business_name" | "phone"
>;

export type MondayMatchTier = "email" | "phone" | "name";

export interface MondayMatchResult {
  item: EnquiryBoardItem | null;
  matchedBy?: MondayMatchTier;
  /** A tier produced more than one candidate — recorded, never guessed between. */
  ambiguous: boolean;
  /** Tiers that each found exactly one item, but a DIFFERENT one to the winner. */
  disagreements: { tier: MondayMatchTier; itemId: string }[];
  /** Hit counts per tier, for logging and the admin report. */
  counts: Record<MondayMatchTier, number>;
}

/**
 * Pick the board item for a customer. PURE — no IO, no writes, so it can be run
 * read-only against live data before anything is allowed to write.
 *
 * TIERED, and each tier requires EXACTLY ONE match to win: nought or several falls
 * through to the next. Email alone is not enough. Measured on live data, two of
 * eighteen customer items carry the customer's ORIGINAL address while the live row
 * has a newer one, and in both cases the board's address matches an ARCHIVED
 * duplicate row — so those two only resolve on name (and one also on mobile).
 *
 * Tier order is confidence order. Email is the strongest signal because the cell
 * literally holds an address; a name is the weakest because two rows can share
 * one. Requiring a unique hit is what makes the weak tier safe to use at all.
 */
export function matchItemForCustomer(
  items: EnquiryBoardItem[],
  row: MondayMatchCandidate
): MondayMatchResult {
  const email = (row.email ?? "").trim().toLowerCase();
  const byEmail = email ? items.filter((i) => i.emails.includes(email)) : [];

  const phoneKey = phoneMatchKey(row.phone);
  const byPhone = phoneKey ? items.filter((i) => i.phoneKey === phoneKey) : [];

  const names = [row.contact_name, row.business_name]
    .map(normaliseName)
    .filter((n): n is string => Boolean(n));
  const byName = names.length
    ? items.filter((i) => names.includes(normaliseName(i.name) ?? ""))
    : [];

  const tiers: { tier: MondayMatchTier; hits: EnquiryBoardItem[] }[] = [
    { tier: "email", hits: byEmail },
    { tier: "phone", hits: byPhone },
    { tier: "name", hits: byName },
  ];

  const counts = {
    email: byEmail.length,
    phone: byPhone.length,
    name: byName.length,
  };

  const winner = tiers.find((t) => t.hits.length === 1);
  if (!winner) {
    return {
      item: null,
      ambiguous: tiers.some((t) => t.hits.length > 1),
      disagreements: [],
      counts,
    };
  }

  const item = winner.hits[0];

  // A lower tier that ALSO found exactly one item, but a different one. Surfaced
  // rather than decided silently, because it means two signals point at two people
  // and only one can be right.
  //
  // Note this is narrower than "the name on the board differs from the name on the
  // row". Live example: item "Caleb atsu" carries an email belonging to an active
  // customer named "Rose Ama". That is NOT flagged here and should not be — the
  // name tier finds no item called "Rose Ama" at all, so there is no competing
  // match, and email resolves it to the right item. A disagreement needs two
  // tiers each confidently naming a different item.
  const disagreements = tiers
    .filter((t) => t.hits.length === 1 && t.hits[0].id !== item.id)
    .map((t) => ({ tier: t.tier, itemId: t.hits[0].id }));

  return { item, matchedBy: winner.tier, ambiguous: false, disagreements, counts };
}

/**
 * Find the board item for a customer and store the link so the next call skips
 * straight to it. Wraps the pure matcher with the IO.
 */
async function resolveItem(
  admin: SupabaseClient,
  row: MondayStatusRow
): Promise<{
  item: EnquiryBoardItem | null;
  skipped?: MondayStatusSyncOutcome["skipped"];
  /**
   * Set on a genuine failure to reach Monday, as opposed to an ordinary "this
   * customer has no item". Callers log on `error`, so without it a revoked token or
   * a board outage disabled the whole sync in complete silence.
   */
  error?: string;
}> {
  // Already linked: read the one item rather than the whole board. Only trust the
  // stored link when it is on the board that actually HAS a status column — a GR
  // enquiry stores its item on the status-less GR board (§23.7), and short-circuiting
  // on that would strand the customer for ever: the write refuses the board, and a
  // resolution that could have found them a management-board item never runs.
  if (row.monday_item_id && row.monday_board_id === enquiryBoardId()) {
    const one = await fetchEnquiryItem(row.monday_item_id);
    if (!one.ok) {
      return {
        item: null,
        skipped:
          one.error === "not_configured" ? "not_configured" : "board_unreadable",
        error: one.error === "not_configured" ? undefined : one.error,
      };
    }
    // A deleted item, or one that has been moved off this board, falls through to a
    // fresh resolution rather than failing — the stored id is a cache, not a fact.
    if (one.item && one.item.boardId === enquiryBoardId()) {
      return { item: one.item };
    }
  }

  const index = await fetchEnquiryBoardIndex();
  if (!index.ok) {
    return {
      item: null,
      skipped:
        index.error === "not_configured" ? "not_configured" : "board_unreadable",
      error: index.error === "not_configured" ? undefined : index.error,
    };
  }

  const match = matchItemForCustomer(index.items, row);

  if (!match.item) {
    await admin
      .from("customers")
      .update({
        monday_link_state: match.ambiguous ? "ambiguous" : "not_found",
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    console.error("[monday-status] could not resolve board item", {
      customer: row.id,
      email: row.email,
      counts: match.counts,
    });
    return { item: null, skipped: match.ambiguous ? "ambiguous" : "unlinked" };
  }

  if (match.disagreements.length) {
    console.warn(
      `[monday-status] match signals disagree, using ${match.matchedBy}`,
      {
        customer: row.id,
        chosen: match.item.id,
        others: match.disagreements
          .map((d) => `${d.tier}=${d.itemId}`)
          .join(" "),
      }
    );
  }

  // Persist the link even if the status write then fails — the board read is the
  // expensive part, and the link does not depend on the write succeeding.
  await admin
    .from("customers")
    .update({
      monday_item_id: match.item.id,
      monday_board_id: enquiryBoardId(),
      monday_link_state: "linked",
      monday_link_matched_by: match.matchedBy,
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id);

  return { item: match.item };
}

/** Lower-case, collapse whitespace — enough to match "Olly  Pearce". */
function normaliseName(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  return trimmed || null;
}
