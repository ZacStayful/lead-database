import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminUser } from "@/lib/auth";
import {
  ENQUIRY_STATUS,
  enquiryBoardId,
  fetchEnquiryBoardIndex,
  type EnquiryStatusLabel,
} from "@/lib/monday";
import {
  matchItemForCustomer,
  mondayStatusLabelFor,
  type MondayStatusCandidate,
  type MondayMatchTier,
} from "@/lib/mondayStatus";
import type { Customer } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Reconcile customers against the Monday sales board — WITHOUT writing to Monday.
 *
 * Two jobs, and it is important that neither is "fix the board":
 *
 *  1. LINK. Resolve every active customer to their board item and store the link,
 *     so the lifecycle hooks never need a whole-board read. Also fills
 *     monday_status_label where the board's label ALREADY matches what the rule
 *     would write, which is what makes the ~21 existing customers cost zero
 *     Monday calls at their next renewal.
 *
 *  2. REPORT. Say what disagrees: customers whose label the rule would change,
 *     customers that could not be resolved or resolved ambiguously, and board
 *     items labelled as a customer that no live customer claims.
 *
 * It writes only to `customers` (the link columns and the label cache), never to
 * Monday. Backfilling the board was explicitly out of scope and does not need
 * doing — measured on live data, the hand-maintained labels already agree with the
 * rule for all 21 customers, so there is nothing to correct.
 *
 * There is deliberately NO cron entry for this. Nothing outside the lifecycle
 * hooks recomputes a label, which is what keeps the cancel-at-click behaviour
 * consistent: cancel_at_period_end is stored nowhere (§21), so a scheduled
 * write-mode reconciliation would recompute a just-cancelled customer as
 * "Management Customer" and flip them back. A scheduled version needs either a
 * stored flag or a live Stripe read first.
 */

type CheckRow = MondayStatusCandidate &
  Pick<
    Customer,
    | "id"
    | "email"
    | "contact_name"
    | "business_name"
    | "phone"
    | "monday_item_id"
    | "monday_status_label"
  >;

const SELECT =
  "id, email, contact_name, business_name, phone, is_active, paused_at, " +
  "account_status, subscription_status, gr_subscription_status, " +
  "monday_item_id, monday_status_label";

/** The labels this system owns — anything else on an item is the sales team's. */
const OWNED_LABELS: string[] = Object.values(ENQUIRY_STATUS);

async function isAdminRequest(req: NextRequest): Promise<boolean> {
  const key = req.headers.get("x-admin-key");
  if (key && process.env.ADMIN_SECRET_KEY && key === process.env.ADMIN_SECRET_KEY) {
    return true;
  }
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return isAdminUser(user);
}

async function handle(req: NextRequest) {
  if (!(await isAdminRequest(req))) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  // `link=1` stores the resolved links and label cache. Without it this is a pure
  // read of both systems — the default, so a first look changes nothing at all.
  const persist = req.nextUrl.searchParams.get("link") === "1";

  const admin = createAdminClient();

  const index = await fetchEnquiryBoardIndex();
  if (!index.ok) {
    return NextResponse.json(
      { error: `Could not read the Monday board: ${index.error}` },
      { status: 502 }
    );
  }

  // Archived rows are excluded here as well as inside the label rule (§18D): a
  // superseded duplicate must be out of every list, not just this one.
  const { data: customers, error } = await admin
    .from("customers")
    .select(SELECT)
    .eq("is_active", true)
    .order("email");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (customers ?? []) as unknown as CheckRow[];

  const linked: {
    email: string;
    item: string;
    matchedBy: MondayMatchTier;
    label: EnquiryStatusLabel | null;
  }[] = [];
  const wouldChange: {
    email: string;
    item: string;
    boardLabel: string;
    wouldWrite: EnquiryStatusLabel;
  }[] = [];
  const unresolved: { email: string; name: string | null; counts: unknown }[] = [];
  const ambiguous: { email: string; name: string | null; counts: unknown }[] = [];
  const noLabel: string[] = [];
  const claimedBy = new Map<string, string[]>();

  let cacheFilled = 0;
  let linksStored = 0;

  for (const row of rows) {
    const label = mondayStatusLabelFor(row);
    if (!label) noLabel.push(row.email);

    const match = matchItemForCustomer(index.items, row);

    if (!match.item || !match.matchedBy) {
      const entry = {
        email: row.email,
        name: row.contact_name,
        counts: match.counts,
      };
      (match.ambiguous ? ambiguous : unresolved).push(entry);
      if (persist) {
        await admin
          .from("customers")
          .update({
            monday_link_state: match.ambiguous ? "ambiguous" : "not_found",
            updated_at: new Date().toISOString(),
          })
          .eq("id", row.id);
      }
      continue;
    }

    const item = match.item;
    if (!claimedBy.has(item.id)) claimedBy.set(item.id, []);
    claimedBy.get(item.id)!.push(row.email);

    linked.push({
      email: row.email,
      item: `${item.id} (${item.name})`,
      matchedBy: match.matchedBy,
      label,
    });

    if (label && label !== item.statusLabel) {
      wouldChange.push({
        email: row.email,
        item: `${item.id} (${item.name})`,
        boardLabel: item.statusLabel,
        wouldWrite: label,
      });
    }

    if (!persist) continue;

    const update: Record<string, unknown> = {
      monday_item_id: item.id,
      monday_board_id: enquiryBoardId(),
      monday_link_state: "linked",
      monday_link_matched_by: match.matchedBy,
      updated_at: new Date().toISOString(),
    };
    linksStored += 1;

    // The board already says what the rule would write, so record it as ours and
    // the next renewal short-circuits before touching Monday. Only when they
    // agree — filling the cache with a label the board does not carry would
    // suppress a write that genuinely needs to happen.
    if (label && label === item.statusLabel && row.monday_status_label !== label) {
      update.monday_status_label = label;
      update.monday_status_synced_at = new Date().toISOString();
      update.monday_status_error = null;
      cacheFilled += 1;
    }

    await admin.from("customers").update(update).eq("id", row.id);
  }

  // Board items labelled as a customer that no live customer resolved to. This is
  // the admin's to-do list: it catches a customer whose board item carries an old
  // address AND an old name, and GR customers whose only item is on the
  // status-less GR enquiries board.
  const claimedIds = new Set(claimedBy.keys());
  const orphanItems = index.items
    .filter((i) => OWNED_LABELS.includes(i.statusLabel) && !claimedIds.has(i.id))
    .map((i) => ({
      item: `${i.id} (${i.name})`,
      label: i.statusLabel,
      emails: i.emails,
    }));

  // Array.from rather than spreading the iterator — the project targets a
  // pre-ES2015 lib for downlevel iteration.
  const contested = Array.from(claimedBy.entries())
    .filter(([, who]) => who.length > 1)
    .map(([id, who]) => ({ item: id, customers: who }));

  return NextResponse.json({
    status: "ok",
    mode: persist ? "linked-and-cached" : "read-only",
    board_items: index.items.length,
    active_customers: rows.length,
    resolved: linked.length,
    resolved_by: {
      email: linked.filter((l) => l.matchedBy === "email").length,
      phone: linked.filter((l) => l.matchedBy === "phone").length,
      name: linked.filter((l) => l.matchedBy === "name").length,
    },
    links_stored: linksStored,
    label_cache_filled: cacheFilled,
    // Non-empty means the board and the rule disagree. Expected to be empty on a
    // board that is already maintained by hand.
    would_change: wouldChange,
    // Two customers resolving to one item — nothing enforces uniqueness in the
    // schema, on purpose, so this is where a collision shows up.
    contested_items: contested,
    unresolved,
    ambiguous,
    orphan_items: orphanItems,
    // Customers the sync will never write a label for, because they hold nothing.
    // Their hand-set sales label is left alone.
    customers_without_a_label: noLabel,
  });
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
