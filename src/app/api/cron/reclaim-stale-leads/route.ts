import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminUser } from "@/lib/auth";
import { sendNewLeadEmail } from "@/lib/emails";
import { extractCity } from "@/lib/utils";
import {
  businessDaysElapsed,
  fetchUkBankHolidays,
  ukDate,
} from "@/lib/businessTime";
import type { Customer, Lead, LeadType } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * How long an operator gets before an untouched lead is offered to someone
 * else, counted in UK WORKING days. Three business days means a lead delivered
 * at 18:00 on Friday is not reclaimable until Wednesday — it never burns its
 * clock over a weekend the operator was never working.
 */
const RECLAIM_AFTER_BUSINESS_DAYS = 3;

/**
 * Price charged for a reclaimed lead, in POUNDS.
 *
 * Note the unit. The brief specified RECLAIM_PRICE_PENCE, but price_paid on
 * lead_assignments is a numeric in pounds throughout this schema (15.00 for
 * management, 10.00 for GR) — writing 1000 for "£10" would inflate every
 * revenue figure that sums the column by a factor of a hundred. Pounds it is.
 *
 * The discount reflects what is actually being sold: a lead somebody else has
 * had for three days and may still be working, not a fresh exclusive enquiry.
 */
const RECLAIM_PRICE: Record<LeadType, number> = {
  management: 10.0,
  guaranteed_rent: 7.0,
};

/** How many routing candidates to pull before filtering to eligible recipients. */
const CANDIDATE_POOL = 10;

type Candidate = {
  assignment_id: string;
  lead_id: string;
  customer_id: string;
  lead_type: LeadType;
  assigned_at: string;
};

/**
 * GET/POST /api/cron/reclaim-stale-leads
 *
 * Offers untouched leads to one further operator at a reduced price. Auth
 * mirrors /api/monday/sync: Bearer $CRON_SECRET (Vercel Cron) or an admin
 * session. Supports ?dryRun=true, which reports exactly what would happen and
 * performs no writes.
 *
 * The original assignment keeps everything — its status, its price, its credit,
 * its data. Nothing is refunded and nothing is withdrawn. The only change is
 * that a second operator may now also work the lead.
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

  // Retroactivity guard. Stamped into system_settings when 0044 was applied, so
  // leads delivered before soft reclaim existed are never eligible — an operator
  // cannot lose exclusivity under a rule that did not exist when they bought.
  const { data: settingRow } = await admin
    .from("system_settings")
    .select("value")
    .eq("key", "reclaim_enabled_from")
    .maybeSingle();

  const cutoff = (settingRow as { value?: string } | null)?.value;
  if (!cutoff) {
    // Absent setting means 0044 has not been applied. Refuse rather than guess:
    // defaulting to epoch would make every historical lead reclaimable at once.
    return NextResponse.json(
      { error: "reclaim_enabled_from not set; migration 0044 not applied" },
      { status: 500 }
    );
  }

  const { data: candidateRows, error: candErr } = await admin.rpc(
    "get_reclaim_candidates",
    { p_cutoff: cutoff, p_min_age_days: RECLAIM_AFTER_BUSINESS_DAYS }
  );

  if (candErr) {
    console.error("[reclaim] candidate query failed", candErr);
    return NextResponse.json({ error: candErr.message }, { status: 500 });
  }

  const candidates = (candidateRows ?? []) as Candidate[];
  const holidays = await fetchUkBankHolidays();

  // Apply the true business-day clock. The SQL prefilter used calendar days,
  // which is always the looser test, so this only ever removes rows.
  const due = candidates.filter((c) =>
    businessDaysElapsed(
      new Date(c.assigned_at),
      RECLAIM_AFTER_BUSINESS_DAYS,
      now,
      holidays
    )
  );

  const reclaimed: unknown[] = [];
  const wouldReclaim: unknown[] = [];
  const skipped: { assignment_id: string; reason: string }[] = [];

  for (const c of due) {
    // Deficit-first selection, unchanged: this phase does not alter routing
    // order. Engagement weighting arrives in the next phase and wires in here.
    // The holder of the lead is already excluded by the function itself.
    const { data: nextRows, error: nextErr } = await admin.rpc(
      "get_next_customers_for_lead",
      {
        p_lead_id: c.lead_id,
        p_max: CANDIDATE_POOL,
        p_exclude_customer_ids: [c.customer_id],
        p_lead_type: c.lead_type,
      }
    );

    if (nextErr) {
      skipped.push({ assignment_id: c.assignment_id, reason: "routing_failed" });
      continue;
    }

    const candidateIds = ((nextRows ?? []) as { customer_id: string }[]).map(
      (r) => r.customer_id
    );
    if (candidateIds.length === 0) {
      skipped.push({ assignment_id: c.assignment_id, reason: "no_eligible_recipient" });
      continue;
    }

    // Exclude anyone who has never received a lead. A reclaimed lead is a
    // second-hand lead at a discount; it must not be somebody's first
    // impression of what the product delivers.
    const { data: priorRows } = await admin
      .from("lead_assignments")
      .select("customer_id")
      .in("customer_id", candidateIds);

    const hasHistory = new Set(
      ((priorRows ?? []) as { customer_id: string }[]).map((r) => r.customer_id)
    );
    const eligible = candidateIds.filter((id: string) => hasHistory.has(id));

    // Engagement decides who gets a reclaimed lead, within the deficit-first
    // pool above. This is the ONLY place engagement influences allocation:
    // ordinary leads are still routed purely deficit-first, untouched.
    //
    // The justification is specific to reclaim. This lead was already ignored
    // once, and giving it to whoever is merely next in line risks it being
    // ignored again — which serves neither the landlord nor us. Handing it to
    // the operator most likely to actually ring is the point of the feature.
    //
    // Best-effort: if scoring fails, fall back to the deficit-first order
    // rather than skipping the reclaim. A lead placed in a slightly worse
    // order beats a lead not placed at all.
    let recipientId = eligible[0];
    if (eligible.length > 1) {
      const { data: scoreRows, error: scoreErr } = await admin.rpc(
        "get_customer_engagement_scores",
        { p_lead_type: c.lead_type, p_customer_ids: eligible }
      );
      if (scoreErr) {
        console.error("[reclaim] engagement scoring failed; using deficit order", scoreErr);
      } else {
        const score = new Map(
          ((scoreRows ?? []) as { customer_id: string; score: number }[]).map(
            (r) => [r.customer_id, Number(r.score)]
          )
        );
        // Stable: ties keep the deficit-first ordering they arrived in.
        recipientId = [...eligible].sort(
          (a, b) => (score.get(b) ?? 0) - (score.get(a) ?? 0)
        )[0];
      }
    }

    if (!recipientId) {
      skipped.push({
        assignment_id: c.assignment_id,
        reason: "all_candidates_are_new_customers",
      });
      continue;
    }

    const price = RECLAIM_PRICE[c.lead_type];

    if (dryRun) {
      wouldReclaim.push({
        assignment_id: c.assignment_id,
        lead_id: c.lead_id,
        lead_type: c.lead_type,
        assigned_at: c.assigned_at,
        current_holder: c.customer_id,
        would_go_to: recipientId,
        price,
      });
      continue;
    }

    // Atomic: re-verifies every rule under a row lock, grants the slot, assigns
    // through the ordinary path, and flags the new row.
    const { data: newAssignmentId, error: reclaimErr } = await admin.rpc(
      "reclaim_lead_assignment",
      {
        p_assignment_id: c.assignment_id,
        p_new_customer_id: recipientId,
        p_price: price,
        p_lead_type: c.lead_type,
      }
    );

    if (reclaimErr || !newAssignmentId) {
      console.error("[reclaim] reclaim failed", c.assignment_id, reclaimErr);
      skipped.push({
        assignment_id: c.assignment_id,
        reason: reclaimErr?.message ?? "reclaim_failed",
      });
      continue;
    }

    // Notify the new recipient exactly as an ordinary new lead would.
    const { data: leadRow } = await admin
      .from("leads")
      .select("*")
      .eq("id", c.lead_id)
      .single();
    const lead = leadRow as Lead | null;

    const { data: customerRow } = await admin
      .from("customers")
      .select("*")
      .eq("id", recipientId)
      .maybeSingle();
    const customer = customerRow as Customer | null;

    let emailError: unknown = null;
    if (lead && customer) {
      const city = extractCity(lead.address);
      await admin.from("notifications").insert({
        customer_id: recipientId,
        lead_assignment_id: newAssignmentId,
        notification_type: "new_lead",
        message: `New lead: ${lead.lead_name}${city ? ` in ${city}` : ""}`,
      });

      // Honours the same new_lead preference as any other lead alert.
      if (customer.notification_preferences?.new_lead !== false) {
        const res = await sendNewLeadEmail({ to: customer.email, lead });
        emailError = res.error;
      }

      await admin
        .from("lead_assignments")
        .update({ notification_sent: true, email_sent: !emailError })
        .eq("id", newAssignmentId);
    }

    reclaimed.push({
      assignment_id: c.assignment_id,
      new_assignment_id: newAssignmentId,
      lead_id: c.lead_id,
      lead_type: c.lead_type,
      to: recipientId,
      price,
    });
  }

  return NextResponse.json({
    status: "ok",
    dry_run: dryRun,
    date: ukDate(now),
    bank_holidays_loaded: holidays.size,
    candidates: candidates.length,
    due_after_business_days: due.length,
    reclaimed: dryRun ? 0 : reclaimed.length,
    skipped,
    ...(dryRun ? { would_reclaim: wouldReclaim } : { details: reclaimed }),
  });
}

export async function POST(request: NextRequest) {
  return handle(request);
}

// GET supports Vercel Cron, which issues a GET with the CRON_SECRET bearer.
export async function GET(request: NextRequest) {
  return handle(request);
}
