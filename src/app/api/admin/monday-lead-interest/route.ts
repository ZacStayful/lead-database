import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminUser } from "@/lib/auth";
import { enquiryBoardId, type LeadInterestLabel } from "@/lib/monday";
import {
  mondayLeadInterestFor,
  syncCustomerMondayStatus,
  type MondayStatusCandidate,
} from "@/lib/mondayStatus";
import type { Customer } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Fill in "What kind of leads" (text_mm6c5qba) for customers who already hold a
 * product.
 *
 * THE BACKFILL IS THE SYNC, NOT A SECOND IMPLEMENTATION. Every row here goes
 * through syncCustomerMondayStatus, so the value written is decided by exactly
 * the rule that will maintain it from here on. A bespoke loop would be a second
 * reading of "which products does this customer hold" — the failure §23.2 spent
 * a section on, and the reason mondayLeadInterestFor() is a pure function of the
 * row in the first place. mondayLeadInterestFor is called here only to REPORT
 * what the sync is going to decide.
 *
 * ⚠️ IT ONLY EVER ADDS. A customer holding neither product gets a null verdict,
 * which the sync reads as "leave the cell alone" — so a prospect's stated
 * interest from the enquiry form survives, and somebody who has cancelled keeps
 * the record of what they held. That is what "backfill what is certain" means:
 * anybody we cannot answer for is skipped rather than guessed at.
 *
 * Nothing else moves. `endDate: undefined` leaves both date cells alone, the
 * start date is still first-write-wins, and the label cache makes the Status
 * write a no-op for everybody already correct — so on a board that is already
 * maintained by hand this run changes one cell per customer and nothing else.
 *
 * DRY RUN BY DEFAULT (`?apply=1` to write), following inactivity-nudge and the
 * announcement send route. The whole point of the report is that somebody reads
 * the list before 40-odd items are touched.
 */

type BackfillRow = MondayStatusCandidate &
  Pick<
    Customer,
    | "id"
    | "email"
    | "contact_name"
    | "monday_item_id"
    | "monday_board_id"
    | "monday_lead_interest"
  >;

const SELECT =
  "id, email, contact_name, is_active, paused_at, " +
  "account_status, subscription_status, gr_subscription_status, " +
  "cancel_at_period_end, gr_cancel_at_period_end, " +
  "monday_item_id, monday_board_id, monday_lead_interest";

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
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // GET is the dry run and nothing else, so no amount of link-following or
  // prefetching can start a write. The announcement send route draws the same
  // line for the same reason.
  const apply = req.method === "POST" && req.nextUrl.searchParams.get("apply") === "1";

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("customers")
    .select(SELECT)
    .order("created_at", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as unknown as BackfillRow[];

  const wouldWrite: {
    email: string;
    value: LeadInterestLabel;
    cached: string | null;
  }[] = [];
  const skipped: { email: string; reason: string }[] = [];
  const written: { email: string; value: LeadInterestLabel }[] = [];
  const failed: { email: string; reason: string }[] = [];

  for (const row of rows) {
    const interest = mondayLeadInterestFor(row);

    if (!interest) {
      // Not an error, and the largest group: waitlisted prospects, invited
      // accounts and customers who have left. Their cell keeps whatever it says.
      skipped.push({
        email: row.email,
        reason: row.is_active ? "holds_no_product" : "archived",
      });
      continue;
    }

    // No item to write to. The sync would report this itself, but resolving it
    // costs a whole-board read per customer, so it is worth saying here.
    if (!row.monday_item_id || row.monday_board_id !== enquiryBoardId()) {
      skipped.push({ email: row.email, reason: "no_status_board_item" });
      continue;
    }

    if (row.monday_lead_interest === interest) {
      skipped.push({ email: row.email, reason: "already_cached" });
      continue;
    }

    if (!apply) {
      wouldWrite.push({
        email: row.email,
        value: interest,
        cached: row.monday_lead_interest,
      });
      continue;
    }

    const outcome = await syncCustomerMondayStatus(admin, row.id, {
      reason: "lead-interest-backfill",
    });

    if (outcome.written) {
      written.push({ email: row.email, value: interest });
    } else {
      failed.push({
        email: row.email,
        reason: outcome.error ?? outcome.skipped ?? "unknown",
      });
    }
  }

  return NextResponse.json({
    mode: apply ? "applied" : "dry-run",
    customers: rows.length,
    would_write: wouldWrite,
    written,
    // Non-empty after an apply means Monday refused or could not be reached.
    // Nothing is cached for these, so a re-run picks them up.
    failed,
    skipped,
  });
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
