import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { isAdminUser } from "@/lib/auth";
import { briefPlanFor } from "@/lib/leadBrief/gate";
import { nextGrantDate } from "@/lib/quality/replacementEntitlement";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type DueRow = { customer_id: string; brief_id: string; active_id: string | null; allocation: number };
type CustomerRow = {
  id: string;
  monthly_allocation: number;
  pending_monthly_allocation: number | null;
  billing_cycle_anchor: string | null;
  gr_billing_cycle_anchor: string | null;
  created_at: string | null;
};

/**
 * GET/POST /api/cron/activate-lead-briefs
 *
 * Daily at 00:20 UTC, after the 00:05 reset (Lead Brief Phase 5). A customer's
 * area change, saved in the "Your brief" editor, starts at their next renewal:
 * this makes each due one the active brief (`promote_lead_brief`, 0164), with
 * its first picks locked until the following renewal.
 *
 * "Due" is a renewal having happened since the change was saved
 * (`due_scheduled_lead_briefs`): the same date the editor told the customer,
 * and the date their monthly counters reset on.
 *
 *   - A change saved for a different plan than the customer is now on (they
 *     switched between 10 and 20 leads a month since) is NOT applied: its area
 *     was sized for the old plan. It is logged and left for the customer, whom
 *     the editor asks to review it.
 *   - One customer's failure never stops the others.
 *   - A failed read of the due list is a 500, never a quiet "nothing due".
 *   - Not tied to `lead_brief_enabled`: the customer saved this change, and it
 *     takes effect whether or not brief routing is switched on.
 *
 * Auth: Bearer $CRON_SECRET, or an admin session. ?dryRun=true lists what
 * would happen and writes nothing.
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

  const { data: dueData, error: dueError } = await admin.rpc("due_scheduled_lead_briefs");
  if (dueError) {
    console.error("[activate-lead-briefs] due list unreadable", dueError.code, dueError.message);
    return NextResponse.json({ ok: false, error: "due list unreadable" }, { status: 500 });
  }
  const due = (dueData ?? []) as DueRow[];

  const result = {
    ok: true,
    dryRun,
    due: due.length,
    promoted: 0,
    skipped_plan_changed: 0,
    skipped_no_active: 0,
    conflicts: 0,
    failed: 0,
  };

  for (const row of due) {
    try {
      if (!row.active_id) {
        result.skipped_no_active += 1;
        console.error("[activate-lead-briefs] scheduled brief with no active brief", row.customer_id);
        continue;
      }
      const { data: customer, error: customerError } = await admin
        .from("customers")
        .select(
          "id, monthly_allocation, pending_monthly_allocation, billing_cycle_anchor, gr_billing_cycle_anchor, created_at"
        )
        .eq("id", row.customer_id)
        .maybeSingle();
      if (customerError || !customer) {
        result.failed += 1;
        console.error("[activate-lead-briefs] customer unreadable", row.customer_id, customerError?.message);
        continue;
      }
      const c = customer as CustomerRow;
      if (briefPlanFor(c) !== row.allocation) {
        result.skipped_plan_changed += 1;
        console.warn("[activate-lead-briefs] plan changed since the change was saved; not applied", {
          customer_id: row.customer_id,
          saved_for: row.allocation,
          now_on: briefPlanFor(c),
        });
        continue;
      }
      const lockedUntil = nextGrantDate({
        billing_cycle_anchor: c.billing_cycle_anchor,
        gr_billing_cycle_anchor: c.gr_billing_cycle_anchor,
        created_at: c.created_at,
      });
      if (!lockedUntil) {
        result.failed += 1;
        console.error("[activate-lead-briefs] no renewal date", row.customer_id);
        continue;
      }
      if (dryRun) {
        result.promoted += 1;
        continue;
      }
      const { data, error } = await admin.rpc("promote_lead_brief", {
        p_customer_id: row.customer_id,
        p_expected_active_id: row.active_id,
        p_source_id: row.brief_id,
        p_priorities: null,
        p_scheduled_priorities: null,
        p_locked_until: lockedUntil,
      });
      const outcome = (data as { result?: string } | null)?.result;
      if (error || outcome !== "promoted") {
        if (outcome === "conflict") result.conflicts += 1;
        else result.failed += 1;
        console.error("[activate-lead-briefs] promote failed", row.customer_id, error?.message ?? outcome);
        continue;
      }
      result.promoted += 1;
    } catch (err) {
      result.failed += 1;
      console.error("[activate-lead-briefs] unexpected", row.customer_id, err);
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
