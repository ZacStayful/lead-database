import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  MAX_LEADS_LISTED,
  NUDGE_CUSTOMER_COLUMNS,
  findLeadsAwaitingFollowUp,
  sendInactivityDigest,
  staleCutoffIso,
  wantsInactivityNudge,
  type NudgeCustomer,
} from "@/lib/followUp";
import { fetchUkBankHolidays, isBankHoliday, ukDate } from "@/lib/businessTime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Monday inactivity-nudge cron. Auth: CRON_SECRET bearer only (a pure scheduled
 * job — no admin-session path, unlike /api/monday/sync).
 *
 * For each active, opted-in customer, find lead assignments still awaiting a
 * first follow-up and, if any, send ONE grouped in-portal notification + ONE
 * grouped email, then stamp last_nudge_sent_at for same-day dedup.
 *
 * The "awaiting follow-up" rule itself lives in @/lib/followUp, shared with the
 * admin-triggered reminder on the customers table so the two cannot drift apart.
 * The digest leaves includeAlreadyNudged off, making the nudge
 * once-per-assignment-ever: a lead the operator has decided to leave alone must
 * not reappear every week, which teaches people to ignore the digest rather than
 * the lead.
 */
async function handle(request: NextRequest) {
  const auth = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ?dryRun=true reports who WOULD be emailed and stops short of every side
  // effect, so the selection rules can be inspected against live data without
  // mailing anyone.
  const dryRun = request.nextUrl.searchParams.get("dryRun") === "true";
  const wouldNudge: {
    customer_id: string;
    email: string;
    lead_count: number;
    management_leads: number;
    gr_leads: number;
    leads: string[];
  }[] = [];

  const now = new Date();
  const today = ukDate(now);

  // Skip UK bank holidays (fail open on any error/timeout — see helper).
  const holidays = await fetchUkBankHolidays();
  if (isBankHoliday(now, holidays)) {
    console.log(`[inactivity-nudge] ${today} is a bank holiday; skipping.`);
    return NextResponse.json({
      status: "skipped",
      reason: "bank_holiday",
      date: today,
    });
  }

  const admin = createAdminClient();

  // Target only customers who are actually live on the platform — the same
  // population that receives leads. A churned/cancelled customer should never be
  // nudged about old leads.
  //
  // Eligibility is decided PER PRODUCT, mirroring get_next_customers_for_lead.
  // Previously this query required subscription_status = 'active', which is the
  // MANAGEMENT column, so a customer holding only Guaranteed Rent was excluded
  // outright and never nudged about any GR lead. account_status and paused_at
  // are management-only for the same reason (the Stripe webhook deliberately
  // leaves both untouched on a GR cancellation), so neither may gate GR.
  //
  // The filter below is the union — anyone live on EITHER product — and each
  // assignment is then matched against its own product's eligibility inside
  // findLeadsAwaitingFollowUp before it can appear in a digest.
  const { data: customerRows, error: custErr } = await admin
    .from("customers")
    .select(NUDGE_CUSTOMER_COLUMNS)
    .eq("is_active", true)
    .or("subscription_status.eq.active,gr_subscription_status.eq.active");

  if (custErr) {
    return NextResponse.json({ error: custErr.message }, { status: 500 });
  }

  const cutoffIso = staleCutoffIso(now);

  let nudged = 0;
  let noLeads = 0;
  let alreadyToday = 0;
  let optedOut = 0;

  for (const customer of (customerRows ?? []) as unknown as NudgeCustomer[]) {
    if (!wantsInactivityNudge(customer)) {
      optedOut += 1;
      continue;
    }

    // Same-day dedup: never nudge a customer twice on the same UK date, so a
    // manual re-run of the cron is a no-op for anyone already nudged today.
    if (
      customer.last_nudge_sent_at &&
      ukDate(new Date(customer.last_nudge_sent_at)) === today
    ) {
      alreadyToday += 1;
      continue;
    }

    const { waiting, error } = await findLeadsAwaitingFollowUp(admin, customer, {
      cutoffIso,
    });
    if (error) {
      console.error("[inactivity-nudge] assignment query failed", {
        customer: customer.id,
        error,
      });
      continue;
    }

    if (waiting.length === 0) {
      noLeads += 1;
      continue;
    }

    // Dry run: report exactly who would be emailed and about what, then stop
    // before any side effect. Nothing is sent, nothing is stamped, no event is
    // written — so a dry run leaves the next real run's behaviour identical.
    if (dryRun) {
      wouldNudge.push({
        customer_id: customer.id,
        email: customer.email,
        lead_count: waiting.length,
        management_leads: waiting.filter((l) => l.leadType !== "guaranteed_rent")
          .length,
        gr_leads: waiting.filter((l) => l.leadType === "guaranteed_rent").length,
        leads: waiting.slice(0, MAX_LEADS_LISTED).map((l) => l.name),
      });
      nudged += 1;
      continue;
    }

    await sendInactivityDigest(admin, customer, waiting, now);
    nudged += 1;
  }

  return NextResponse.json({
    status: "ok",
    dry_run: dryRun,
    date: today,
    nudged,
    skipped: {
      no_leads: noLeads,
      already_today: alreadyToday,
      opted_out: optedOut,
    },
    ...(dryRun ? { would_nudge: wouldNudge } : {}),
  });
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
