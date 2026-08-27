import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminUser } from "@/lib/auth";
import { assessLeadQuality, type LeadQualityCode } from "@/lib/leadQuality";
import type { Lead } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Judge the contact details of leads that have not been judged yet, and store
 * the verdict (0111).
 *
 * THE BACKFILL, AND WHY IT IS A ROUTE RATHER THAN SQL IN THE MIGRATION.
 *
 * The rules live in `src/lib/leadQuality.ts` and this runs THAT function. A SQL
 * reimplementation inside 0111 would be a second copy of the UK-mobile
 * normaliser that has to change in step with the first and silently would not —
 * the exact failure §20 records for `capture_operator_proof` and §26.7 for
 * `presentationSeed`. It also could not be trusted: 89 of the live management
 * leads are stored as `+44` followed by a full national number, and getting
 * that wrong in a hand-written SQL copy would blank 46% of the book.
 *
 * ⚠️ A LEAD THAT HAS ALREADY BEEN SOLD IS MARKED BUT NOT BLOCKED. It is stamped
 * `failed` so admin can see it, and given an override at the same instant so it
 * keeps routing. Invariant 4 says a delivered lead is chargeable; retiring one
 * an operator is working would withdraw something they have paid for and may
 * already have rung. On today's book that is 16 leads, 15 of them the `+44`
 * shape — so if the normaliser were ever wrong, the blast radius is the 24
 * unsold rows rather than the live book.
 *
 * Customer-owned leads (§30) are skipped entirely. We did not source them, we
 * do not sell them, and failing one would take a customer's own lead off their
 * own dashboard.
 *
 * Re-runnable and self-draining: it only ever looks at `pending` rows, so a
 * second run finds nothing. `?dryRun=true` reports what it would do and writes
 * nothing, matching `parse-income-reports` and `inactivity-nudge`.
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

  const { data, error } = await admin
    .from("leads")
    .select(
      "id, lead_name, phone, email, assignment_count, lead_quality_status, lead_quality_codes"
    )
    .eq("lead_quality_status", "pending")
    .is("owner_customer_id", null)
    .order("created_at", { ascending: false })
    .limit(2000);

  if (error) {
    console.error("quality-check: could not read leads", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const leads = (data ?? []) as Pick<
    Lead,
    "id" | "lead_name" | "phone" | "email" | "assignment_count"
  >[];

  const now = new Date().toISOString();
  let passed = 0;
  let failedBlocked = 0;
  let failedAlreadySold = 0;
  let writeErrors = 0;
  const codeTally: Record<string, number> = {};

  for (const lead of leads) {
    const verdict = assessLeadQuality(lead);
    for (const code of verdict.codes) {
      codeTally[code] = (codeTally[code] ?? 0) + 1;
    }

    const alreadySold = (lead.assignment_count ?? 0) > 0;
    if (verdict.ok) passed += 1;
    else if (alreadySold) failedAlreadySold += 1;
    else failedBlocked += 1;

    if (dryRun) continue;

    const patch: Record<string, unknown> = {
      lead_quality_status: verdict.ok ? "passed" : "failed",
      lead_quality_codes: verdict.codes as LeadQualityCode[],
      lead_quality_checked_at: now,
    };

    // Marked, not blocked. Stamped in the SAME write as the verdict so there is
    // never an instant where the lead is failed and unprotected.
    if (!verdict.ok && alreadySold) {
      patch.lead_quality_override_at = now;
      patch.lead_quality_override_by = "backfill";
      patch.lead_quality_override_note =
        "Already delivered when the quality gate was introduced. Marked for " +
        "visibility only — a delivered lead stays chargeable (invariant 4).";
    }

    const { error: writeError } = await admin
      .from("leads")
      .update(patch)
      .eq("id", lead.id)
      // Claim-by-write: only judge a row still pending, so two concurrent runs
      // cannot both stamp it and an admin override placed mid-run is not undone.
      .eq("lead_quality_status", "pending");

    if (writeError) {
      writeErrors += 1;
      console.error("quality-check: write failed", lead.id, writeError);
    }
  }

  return NextResponse.json({
    status: "ok",
    dryRun,
    examined: leads.length,
    passed,
    failed_blocked: failedBlocked,
    failed_already_sold_marked_only: failedAlreadySold,
    write_errors: writeErrors,
    reasons: codeTally,
  });
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
