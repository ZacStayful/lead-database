import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminUser } from "@/lib/auth";
import { sendCycleSurveyEmail } from "@/lib/emails";
import { currentCycle, isSurveyDue } from "@/lib/quality/cycle";
import type { Customer } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET/POST /api/cron/quality-survey
 *
 * Invites active customers to rate the cycle's leads, once per cycle, when
 * their allocation has been delivered or the cycle is nearly over. A customer
 * who already answered for that cycle is skipped, so this is safe to run daily.
 *
 * Auth mirrors the other cron routes: Bearer $CRON_SECRET, or an admin session.
 * On a Vercel Hobby plan drive it from the existing n8n Schedule trigger.
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
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const admin = createAdminClient();

  const { data: rows, error } = await admin
    .from("customers")
    .select("*")
    .eq("is_active", true)
    .eq("account_status", "active");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const customers = (rows ?? []) as Customer[];
  let invited = 0;
  let skipped = 0;

  for (const customer of customers) {
    if (!isSurveyDue(customer)) {
      skipped += 1;
      continue;
    }

    const cycle = currentCycle(customer);

    // Claim the cycle before sending. The unique (customer_id, cycle_start)
    // constraint makes this the idempotency guard: a second run of the cron
    // conflicts here and sends nothing, so nobody is emailed twice.
    const { error: claimError } = await admin
      .from("cycle_quality_surveys")
      .insert({
        customer_id: customer.id,
        cycle_start: cycle.startDate,
        cycle_end: cycle.endDate,
        leads_in_cycle: customer.leads_received_this_month ?? 0,
      });

    if (claimError) {
      skipped += 1;
      continue;
    }

    await sendCycleSurveyEmail({
      to: customer.email,
      contactName: customer.contact_name,
      leadsInCycle: customer.leads_received_this_month ?? 0,
      cycleStart: cycle.startDate,
    });
    invited += 1;
  }

  return NextResponse.json({
    ok: true,
    considered: customers.length,
    invited,
    skipped,
  });
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
