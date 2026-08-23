import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminUser } from "@/lib/auth";
import { leadPriceFor } from "@/lib/plans";
import { selectCombinedCandidates, completeAssignment } from "@/lib/ingest";
import type { Lead, LeadType } from "@/lib/types";
import { captureCustomerCommercial } from "@/lib/commercialCapture";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The two rungs. A lead untouched for ten days is offered to one more operator;
 * still untouched at twenty, to one more again; after that it is left alone.
 * Not three rungs and not a rolling re-offer — a lead nobody has worked in three
 * weeks is cold, and continuing to recycle it just spreads a dead lead thinner.
 */
const RUNGS = [
  { stage: 1, minAgeDays: 10, thresholdKey: "escalation_score_threshold_day_10" },
  { stage: 2, minAgeDays: 20, thresholdKey: "escalation_score_threshold_day_20" },
] as const;

/**
 * How far back each rung looks for signs of life.
 *
 * Ten days for both rungs, deliberately: the question at day 20 is not "has
 * anything happened since this lead arrived" but "has anything happened in the
 * last ten days", the same question the first rung asked. Any activity resets
 * the clock, so an operator who opens a lead on day 15 keeps it past the second
 * rung and only loses it if they then go quiet for another ten days.
 */
const SCORE_WINDOW_DAYS = 10;

/** Candidate recipients to pull per lead before filtering. */
const CANDIDATE_POOL = 10;

/**
 * Escalations in a single run above which the admin overview raises a loud flag.
 * A soft ceiling: the run still completes in full. It exists to catch a
 * misconfiguration (a threshold typo, a gate switched off) before it has
 * redistributed half the book, not to cap legitimate volume.
 */
const RUN_VOLUME_CEILING = 15;

type Candidate = {
  assignment_id: string;
  lead_id: string;
  customer_id: string;
  lead_type: LeadType;
  assigned_at: string;
  max_assignments: number;
  lead_age_days: number | null;
};

type Scored = {
  assignment_id: string;
  score: number;
  /** Nothing but looking happened — an open, a read notification, or a login. */
  passive_only: boolean;
  signals: Record<string, boolean>;
};

async function settings(admin: ReturnType<typeof createAdminClient>) {
  const { data } = await admin.from("system_settings").select("key, value");
  const map = new Map(
    ((data ?? []) as { key: string; value: string }[]).map((r) => [r.key, r.value])
  );
  return map;
}

/**
 * GET/POST /api/cron/escalate-leads
 *
 * Daily. Offers leads their assignee has ignored to one further operator, at
 * ten days and again at twenty, at the standard price through standard routing.
 * The original assignment is untouched — same status, same price, no refund,
 * nothing withdrawn — and the new operator's experience is identical to any
 * other new lead.
 *
 * Auth mirrors /api/monday/sync: Bearer $CRON_SECRET, or an admin session.
 * ?dryRun=true reports exactly what would happen and writes nothing.
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
  const config = await settings(admin);

  // ---------------------------------------------------------------------
  // Kill switch, checked before anything else.
  //
  // Logged rather than silently skipped: "the job did nothing" and "the job is
  // switched off" look identical in the output otherwise, and the whole point of
  // the switch is being able to tell later why a week produced no escalations.
  // ---------------------------------------------------------------------
  if (config.get("escalation_enabled") !== "true") {
    console.warn("[escalate] run skipped — escalation_enabled is not 'true'");
    return NextResponse.json({
      status: "skipped",
      reason: "escalation_disabled",
      message: "escalation_enabled is not set to true in system_settings.",
    });
  }

  const cutoff = config.get("escalation_enabled_from");
  if (!cutoff) {
    // Absent setting means migration 0062 has not been applied. Refuse rather
    // than guess: defaulting to epoch would make every historical assignment
    // eligible at once and redistribute the entire book in one run.
    return NextResponse.json(
      { error: "escalation_enabled_from not set; migration 0062 not applied" },
      { status: 500 }
    );
  }

  // Freshness gate. An empty value means Zac has not chosen a number yet, which
  // is a decision still outstanding rather than a default of zero — so the run
  // proceeds ungated and says so, loudly enough for the admin panel to surface.
  const rawMaxAge = (config.get("escalation_max_lead_age_days") ?? "").trim();
  const maxLeadAgeDays = rawMaxAge === "" ? null : Number(rawMaxAge);
  const gateActive = maxLeadAgeDays != null && Number.isFinite(maxLeadAgeDays);

  const escalated: unknown[] = [];
  const wouldEscalate: unknown[] = [];
  const skipped: { assignment_id: string; reason: string }[] = [];

  for (const rung of RUNGS) {
    const threshold = Number(config.get(rung.thresholdKey) ?? "");
    if (!Number.isFinite(threshold)) {
      return NextResponse.json(
        { error: `${rung.thresholdKey} missing or not a number` },
        { status: 500 }
      );
    }

    const { data: candidateRows, error: candErr } = await admin.rpc(
      "get_escalation_candidates",
      { p_cutoff: cutoff, p_stage: rung.stage, p_min_age_days: rung.minAgeDays }
    );

    if (candErr) {
      console.error("[escalate] candidate query failed", candErr);
      return NextResponse.json({ error: candErr.message }, { status: 500 });
    }

    const candidates = (candidateRows ?? []) as Candidate[];
    if (candidates.length === 0) continue;

    // Score the whole rung in one call rather than per assignment.
    const since = new Date(
      Date.now() - SCORE_WINDOW_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();

    const { data: scoreRows, error: scoreErr } = await admin.rpc(
      "get_assignment_engagement_scores",
      { p_assignment_ids: candidates.map((c) => c.assignment_id), p_since: since }
    );

    if (scoreErr) {
      console.error("[escalate] scoring failed", scoreErr);
      return NextResponse.json({ error: scoreErr.message }, { status: 500 });
    }

    const scores = new Map(
      ((scoreRows ?? []) as Scored[]).map((r) => [r.assignment_id, r])
    );

    for (const c of candidates) {
      const scored = scores.get(c.assignment_id);
      const score = Number(scored?.score ?? 0);
      // Opening a lead is looking at it, not working it. Somebody can click in
      // to see what a lead is, decide against it, and never come back — and
      // without this that single click would buy them another ten days. The
      // weights are set so passive signals cannot reach the threshold on their
      // own, and this flag makes the rule survive any future weight edit from
      // admin rather than depending on the arithmetic still adding up.
      const lookedOnly = scored?.passive_only ?? true;

      // Engaged enough to keep it. The clock keeps running: if they go quiet for
      // another ten days this same rung picks the lead up again, because the
      // stage has not advanced.
      if (score >= threshold && !lookedOnly) {
        continue;
      }

      // Freshness gate, if configured. A lead whose enquiry date could not be
      // parsed has a null age and is NOT blocked — an unreadable date is missing
      // information, not evidence that the lead is stale.
      if (gateActive && c.lead_age_days != null && c.lead_age_days > maxLeadAgeDays!) {
        skipped.push({ assignment_id: c.assignment_id, reason: "older_than_age_gate" });
        continue;
      }

      // -----------------------------------------------------------------
      // Confirm a recipient EXISTS before touching anything.
      //
      // Same two-pool selection ingest uses, so a filtered customer whose
      // criteria match is eligible for an escalated lead exactly as they are for
      // a fresh one, and a paused customer is excluded by the same rule. Asking
      // for one candidate would be wrong: the pool is ranked, and the top entry
      // may be the assignee we are escalating away from.
      // -----------------------------------------------------------------
      const [filteredRes, unfilteredRes] = await Promise.all([
        admin.rpc("get_filtered_candidates_for_lead", {
          p_lead_id: c.lead_id,
          p_max: CANDIDATE_POOL,
          p_lead_type: c.lead_type,
        }),
        admin.rpc("get_unfiltered_candidates_for_lead", {
          p_lead_id: c.lead_id,
          p_max: CANDIDATE_POOL,
          p_lead_type: c.lead_type,
        }),
      ]);

      if (filteredRes.error || unfilteredRes.error) {
        skipped.push({ assignment_id: c.assignment_id, reason: "routing_failed" });
        continue;
      }

      const recipients = selectCombinedCandidates(
        (filteredRes.data ?? []) as { customer_id: string; priority_score: number }[],
        (unfilteredRes.data ?? []) as { customer_id: string; deficit: number }[],
        1
      );

      if (recipients.length === 0) {
        // Nobody has credit today. Do nothing at all — no cap raise, no stage
        // advance — so the same condition is re-evaluated tomorrow as if this
        // rung had never come due. A lead must not burn a rung on a day when
        // there was nobody to give it to.
        skipped.push({ assignment_id: c.assignment_id, reason: "no_eligible_recipient" });
        continue;
      }

      const recipientId = recipients[0];
      const price = leadPriceFor(c.lead_type);

      if (dryRun) {
        wouldEscalate.push({
          assignment_id: c.assignment_id,
          lead_id: c.lead_id,
          stage: rung.stage,
          score,
          passive_only: lookedOnly,
          signals: scored?.signals ?? null,
          from_customer: c.customer_id,
          to_customer: recipientId,
          max_assignments: c.max_assignments,
          lead_age_days: c.lead_age_days,
        });
        continue;
      }

      const { data: newAssignmentId, error: escErr } = await admin.rpc(
        "escalate_lead_assignment",
        {
          p_assignment_id: c.assignment_id,
          p_new_customer_id: recipientId,
          p_price: price,
          p_lead_type: c.lead_type,
          p_stage: rung.stage,
        }
      );

      if (escErr || !newAssignmentId) {
        // Expected and harmless: the recipient's last credit was spent between
        // the check above and the call, or the assignee settled the lead. The
        // whole escalation rolled back, including the cap raise, so there is no
        // partial state to repair — it simply retries tomorrow.
        skipped.push({
          assignment_id: c.assignment_id,
          reason: escErr?.message ?? "escalation_failed",
        });
        continue;
      }

      // Identical follow-through to any other new lead: in-portal notification,
      // Resend email, SMS alert, delivery flags. Nothing marks this assignment
      // as second-hand, because from the recipient's side it is not.
      const { data: leadRow } = await admin
        .from("leads")
        .select("*")
        .eq("id", c.lead_id)
        .single();

      if (leadRow) {
        await completeAssignment(
          admin,
          leadRow as Lead,
          recipientId,
          newAssignmentId as string
        );
      }

      escalated.push({
        assignment_id: c.assignment_id,
        new_assignment_id: newAssignmentId,
        lead_id: c.lead_id,
        stage: rung.stage,
        score,
        from_customer: c.customer_id,
        to_customer: recipientId,
      });
    }
  }

  const count = dryRun ? wouldEscalate.length : escalated.length;
  const overCeiling = count > RUN_VOLUME_CEILING;

  if (overCeiling) {
    console.warn(
      `[escalate] ${count} escalations in one run, above the ceiling of ${RUN_VOLUME_CEILING}`
    );
  }
  if (!gateActive && count > 0) {
    console.warn("[escalate] ran with escalation_max_lead_age_days unset — no age gate applied");
  }

  // ---------------------------------------------------------------------
  // Daily engagement snapshot.
  //
  // Runs in the same job rather than its own: it reads the same tables, the
  // series wants one reading a day at a predictable time, and Vercel cron slots
  // are worth conserving. Deliberately AFTER escalation and outside its
  // success path — a failed escalation must not cost the day's measurement, and
  // a failed measurement must not fail the run.
  // ---------------------------------------------------------------------
  let snapshotRows: number | null = null;
  let snapshotError: string | null = null;
  if (!dryRun) {
    const { data, error } = await admin.rpc("capture_engagement_snapshots", {
      p_window_days: 30,
    });
    if (error) {
      snapshotError = error.message;
      console.error("[escalate] snapshot capture failed", error);
    } else {
      snapshotRows = data as number;
    }
  }

  // ---------------------------------------------------------------------
  // Daily capacity snapshot (0072).
  //
  // Same reasoning as above, and separately fallible for the same reason: the
  // two series are independent, so one failing must not cost the other its
  // reading for the day.
  //
  // Taken AFTER escalation deliberately. Escalation is what converts an ignored
  // lead into a sold slot, so measuring first would record the position the run
  // has just changed — and the whole value of the series is watching that gap
  // close as customers engage.
  //
  // Cannot be backfilled: get_service_capacity reads live state, so a missed day
  // is gone. Hence best-effort here rather than gated on the run succeeding.
  // ---------------------------------------------------------------------
  let capacityRows: number | null = null;
  let capacityError: string | null = null;
  if (!dryRun) {
    const { data, error } = await admin.rpc("capture_service_capacity");
    if (error) {
      capacityError = error.message;
      console.error("[escalate] capacity snapshot failed", error);
    } else {
      capacityRows = data as number;
    }
  }

  // ---------------------------------------------------------------------
  // Monthly commercial capture (0099).
  //
  // The third capture riding this cron, and separately fallible for the same
  // reason as the other two: the series are independent, so one failing must
  // not cost another its reading.
  //
  // Upserts the CURRENT month's row, so the month closes with the last
  // successful capture. Written in TypeScript rather than as a SQL capture
  // function because MRR has no SQL definition — see src/lib/commercialCapture.ts.
  // ---------------------------------------------------------------------
  let commercialRows: number | null = null;
  let commercialError: string | null = null;
  if (!dryRun) {
    try {
      const result = await captureCustomerCommercial(admin);
      commercialRows = result.rows;
    } catch (err) {
      commercialError = err instanceof Error ? err.message : String(err);
      console.error("[escalate] commercial capture failed", err);
    }
  }

  return NextResponse.json({
    status: "ok",
    dry_run: dryRun,
    escalated_count: count,
    over_volume_ceiling: overCeiling,
    volume_ceiling: RUN_VOLUME_CEILING,
    age_gate_active: gateActive,
    age_gate_days: gateActive ? maxLeadAgeDays : null,
    escalated: dryRun ? wouldEscalate : escalated,
    skipped,
    snapshot_rows: snapshotRows,
    snapshot_error: snapshotError,
    capacity_snapshot_rows: capacityRows,
    capacity_snapshot_error: capacityError,
    commercial_snapshot_rows: commercialRows,
    commercial_snapshot_error: commercialError,
  });
}

export async function POST(request: NextRequest) {
  return handle(request);
}

// GET supports Vercel Cron, which issues a GET with the CRON_SECRET bearer.
export async function GET(request: NextRequest) {
  return handle(request);
}
