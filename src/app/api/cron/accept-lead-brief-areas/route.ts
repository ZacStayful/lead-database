import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { isAdminUser } from "@/lib/auth";
import {
  AREA_CONFIRM_CUSTOMER_COLUMNS,
  confirmPendingArea,
  sendAutoAcceptEmail,
  type AreaConfirmCustomer,
} from "@/lib/briefAreaConfirm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SOURCE = "accept-lead-brief-areas";
/** Locked decision 4: auto-accepted 72 hours after the return or effective date. */
const AUTO_ACCEPT_AFTER_HOURS = 72;
/** One run's share. The rest are picked up tomorrow, oldest first. */
const BATCH = 50;

type DueRow = { id: string; customer_id: string; effective_at: string };

/**
 * GET/POST /api/cron/accept-lead-brief-areas
 *
 * Daily at 08:35 UTC, after the 08:00 resume cron (batch 04 Phase 3, locked
 * decision 4). A recalculated area the customer never confirmed becomes
 * active 72 hours after its return or effective date, and an email says so.
 * For a return, the leads restart (they were held, paused, until now).
 *
 * The 72 hours are checked twice: in the query here, and inside
 * confirm_pending_lead_brief under the brief's lock (0169 refuses an early
 * auto-accept as 'not_due'), so a wrong clock or a hand-run cannot confirm an
 * area early.
 *
 *   - One customer's failure never stops the others.
 *   - A failed read of the due list is a 500, never a quiet "nothing due".
 *   - Not tied to `lead_brief_enabled`: the area was recalculated for a
 *     customer who is waiting on it, whether or not brief routing is on.
 *
 * Auth: Bearer $CRON_SECRET, or an admin session. ?dryRun=true lists what is
 * due and writes nothing.
 */
async function handle(request: NextRequest) {
  const auth = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  const viaCron = Boolean(cronSecret) && auth === `Bearer ${cronSecret}`;

  if (!viaCron) {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!isAdminUser(user)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const dryRun = request.nextUrl.searchParams.get("dryRun") === "true";
  const admin = createAdminClient();
  const now = new Date();
  const dueBefore = new Date(now.getTime() - AUTO_ACCEPT_AFTER_HOURS * 3_600_000).toISOString();

  const { data: dueData, error: dueError } = await admin
    .from("customer_lead_briefs")
    .select("id, customer_id, effective_at")
    .eq("status", "pending_confirmation")
    .lte("effective_at", dueBefore)
    .order("effective_at", { ascending: true })
    .limit(BATCH);
  if (dueError) {
    console.error(`[${SOURCE}] due list unreadable`, dueError.code, dueError.message);
    return NextResponse.json({ ok: false, error: "due list unreadable" }, { status: 500 });
  }
  const due = (dueData ?? []) as DueRow[];

  const result = {
    ok: true,
    dryRun,
    due: due.length,
    accepted: 0,
    restarted: 0,
    emailed: 0,
    skipped_not_brief: 0,
    conflicts: 0,
    failed: 0,
  };
  if (dryRun) return NextResponse.json({ ...result, ids: due.map((d) => d.id) });

  for (const row of due) {
    try {
      const { data: customer, error: customerError } = await admin
        .from("customers")
        .select(AREA_CONFIRM_CUSTOMER_COLUMNS)
        .eq("id", row.customer_id)
        .maybeSingle();
      if (customerError || !customer) {
        result.failed += 1;
        console.error(`[${SOURCE}] customer unreadable`, row.customer_id, customerError?.message);
        continue;
      }
      const c = customer as unknown as AreaConfirmCustomer;
      const confirmed = await confirmPendingArea(admin, c, {
        expectedPendingId: row.id,
        auto: true,
        now,
        source: SOURCE,
      });
      if (confirmed.kind !== "confirmed") {
        if (confirmed.kind === "not_brief_customer") result.skipped_not_brief += 1;
        else if (confirmed.kind === "conflict" || confirmed.kind === "not_pending") result.conflicts += 1;
        else result.failed += 1;
        if (confirmed.kind !== "not_brief_customer") {
          console.error(`[${SOURCE}] not accepted`, { customer: row.customer_id, brief: row.id, result: confirmed });
        }
        continue;
      }
      result.accepted += 1;
      if (confirmed.resume === "resumed") result.restarted += 1;
      if (await sendAutoAcceptEmail(c, confirmed, SOURCE)) result.emailed += 1;
    } catch (err) {
      result.failed += 1;
      console.error(`[${SOURCE}] unexpected`, row.customer_id, err);
    }
  }

  return NextResponse.json(result);
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
