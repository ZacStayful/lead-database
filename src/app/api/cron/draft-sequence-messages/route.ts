/**
 * Draft the follow-up steps that are about to come due (§40.13).
 *
 * THIS IS THE HALF THE OPERATOR NEVER SEES WORKING, and the half that makes the
 * feature defensible. A step is drafted the EVENING BEFORE it is due, sits in
 * the review queue overnight where it can be read, edited or killed, and sends
 * itself in the morning if nobody touches it. Nothing goes out from a real
 * person's own WhatsApp number that they could not have seen first.
 *
 * ⚠️ A CRON OF ITS OWN, WHERE THE SENDING PHASE IS NOT. The sender lives inside
 * poll-whatsapp-status because it competes for the shared 30-req/s TimelinesAI
 * bucket. Drafting competes for nothing of the sort: it makes no TimelinesAI
 * call at all, and one model call is ~20 seconds against that route's 45-second
 * wall clock — squeezing this in there would starve the status phase it shares a
 * budget with, on every run, for the whole book.
 *
 * ⚠️ AND IT IS DAILY, NOT EVERY FIVE MINUTES. The review window is what makes
 * "drafted ahead" mean anything; a drafter that ran continuously would write a
 * step minutes before it sends and the operator would never get the overnight
 * look this whole design is built around.
 *
 * ⚠️ A FAILED DRAFT WRITES NOTHING AND IS RETRIED TOMORROW. It never substitutes
 * a template — a canned message pasted into WhatsApp is exactly the mass-outreach
 * pattern that gets the operator's own number restricted, which is the argument
 * validateDraft.ts already makes about its own fallback. The only bound on that
 * retry is time: a step still undrafted a week after it fell due stops the run,
 * so a persistent model outage surfaces as a stopped ladder rather than as a
 * silently frozen one.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminUser } from "@/lib/auth";
import { viewerScopedLead } from "@/lib/customerLeads";
import { assignmentSendable } from "@/lib/messaging/service";
import {
  buildDraftContext,
  type DraftStepContext,
} from "@/lib/messaging/draftContext";
import {
  draftWhatsappMessage,
  isDraftingConfigured,
} from "@/lib/messaging/draftMessage";
import {
  loadSteps,
  sequenceSettings,
  stopRun,
} from "@/lib/messaging/sequences";
import { nextStepNumber } from "@/lib/messaging/cadence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A model call is ~20s. Vercel Pro allows 300; this needs the room. */
export const maxDuration = 300;

/** Stop starting new work here, leaving room for the call already in flight. */
const WALL_CLOCK_BUDGET_MS = 240_000;

/** Runs to consider in one pass. Bounds the query, not the work. */
const SCAN_LIMIT = 400;

/**
 * How long a step may sit undrafted before the ladder is stopped.
 *
 * Without this a persistent model failure freezes a run for ever: it stays
 * `active`, keeps being selected, keeps failing, and the operator sees a
 * sequence that is neither running nor finished. Seven days is generous enough
 * that a bad afternoon costs nothing and short enough that a real outage is
 * visible as a stopped run with a reason on it.
 */
const ABANDON_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** Previous messages fed to the model. Context, not a transcript. */
const HISTORY_LIMIT = 4;
const HISTORY_CHARS = 400;

interface DueRun {
  id: string;
  customer_id: string;
  sequence_id: string;
  assignment_id: string;
  lead_id: string;
  current_step: number;
  next_due_at: string;
}

async function handle(request: NextRequest) {
  // The §2 cron auth pattern, copied exactly. Boolean(cronSecret) matters: it
  // fails closed when the var is unset.
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
  const startedAt = Date.now();

  const settings = await sequenceSettings(admin);
  if (!settings.enabled) {
    return NextResponse.json({ ok: true, skipped: "sequences_disabled" });
  }
  if (!isDraftingConfigured()) {
    // Logged rather than silent: a missing key here means every ladder in the
    // business quietly stops advancing, which nothing else would report.
    console.error("[draft-sequence-messages] ANTHROPIC_API_KEY is not set");
    return NextResponse.json({ ok: true, skipped: "drafting_not_configured" });
  }

  const now = new Date();
  const horizon = new Date(now.getTime() + settings.reviewHours * 60 * 60 * 1000);

  const { data: runRows, error } = await admin
    .from("message_sequence_runs")
    .select("id, customer_id, sequence_id, assignment_id, lead_id, current_step, next_due_at")
    .eq("status", "active")
    .not("next_due_at", "is", null)
    .lte("next_due_at", horizon.toISOString())
    .order("next_due_at", { ascending: true })
    .limit(SCAN_LIMIT);

  if (error) {
    console.error("[draft-sequence-messages] scan failed", error);
    return NextResponse.json({ ok: false, error: "scan_failed" }, { status: 500 });
  }

  const due = (runRows ?? []) as DueRun[];

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      due: due.length,
      customers: new Set(due.map((r) => r.customer_id)).size,
      horizon_hours: settings.reviewHours,
      sample: due.slice(0, 20).map((r) => ({
        run: r.id,
        next_step: r.current_step + 1,
        due_at: r.next_due_at,
      })),
    });
  }

  const stats = {
    due: due.length,
    drafted: 0,
    alreadyDrafted: 0,
    stopped: 0,
    rejected: 0,
    capped: 0,
  };

  // ⚠️ THE DAILY CEILING IS PER CUSTOMER AND COUNTS origin = 'sequence' ONLY
  // (0121 §5). The interactive route's 50-a-day bounds a person clicking a
  // button; this bounds a batch of two hundred, and the two must not share a
  // counter or one silently starves the other.
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const drawnToday = new Map<string, number>();
  const withinCap = async (customerId: string): Promise<boolean> => {
    let used = drawnToday.get(customerId);
    if (used === undefined) {
      const { count } = await admin
        .from("message_draft_requests")
        .select("id", { count: "exact", head: true })
        .eq("customer_id", customerId)
        .eq("origin", "sequence")
        .gte("created_at", dayAgo);
      used = count ?? 0;
      drawnToday.set(customerId, used);
    }
    return used < settings.dailyDraftCap;
  };

  // One ladder read per sequence, not per run. A bulk enrolment is two hundred
  // runs against one sequence.
  const ladders = new Map<string, Awaited<ReturnType<typeof loadSteps>>>();
  const ladderFor = async (sequenceId: string) => {
    const cached = ladders.get(sequenceId);
    if (cached) return cached;
    const steps = await loadSteps(admin, sequenceId);
    ladders.set(sequenceId, steps);
    return steps;
  };

  for (const run of due) {
    if (Date.now() - startedAt > WALL_CLOCK_BUDGET_MS) break;

    // A step nobody could draft for a week stops the ladder, with a reason.
    if (now.getTime() - new Date(run.next_due_at).getTime() > ABANDON_AFTER_MS) {
      await stopRun(admin, run.id, "drafting_failed");
      stats.stopped += 1;
      continue;
    }

    const steps = await ladderFor(run.sequence_id);
    const stepNumber = nextStepNumber(steps, run.current_step);
    if (stepNumber === null) {
      // The ladder was shortened underneath a live run. Finishing is the honest
      // outcome — there is no step left to send.
      await admin
        .from("message_sequence_runs")
        .update({ status: "completed", next_due_at: null, updated_at: now.toISOString() })
        .eq("id", run.id);
      stats.stopped += 1;
      continue;
    }
    const step = steps.find((s) => s.step_number === stepNumber);

    // Claim-check by read rather than by write: the unique index on
    // (run_id, step_number) is the real guard, and it is what makes a second
    // run of this cron write one row rather than two.
    const { data: existing } = await admin
      .from("message_sequence_drafts")
      .select("id")
      .eq("run_id", run.id)
      .eq("step_number", stepNumber)
      .maybeSingle();
    if (existing) {
      stats.alreadyDrafted += 1;
      continue;
    }

    if (!(await withinCap(run.customer_id))) {
      stats.capped += 1;
      continue;
    }

    const { data: assignmentRow } = await admin
      .from("lead_assignments")
      .select(
        "id, status, closed_at, closed_reason, lead_id, " +
          "lead:leads(id, lead_name, address, bedrooms, lead_profile, phone, owner_customer_id, " +
          "gross_annual_income, avg_nightly_rate, occupancy_rate)"
      )
      .eq("id", run.assignment_id)
      .eq("customer_id", run.customer_id)
      .maybeSingle();

    if (!assignmentRow) {
      await stopRun(admin, run.id, "not_sendable");
      stats.stopped += 1;
      continue;
    }

    const assignment = assignmentRow as unknown as {
      id: string;
      status: string | null;
      closed_at: string | null;
      closed_reason: string | null;
      lead: Record<string, unknown>;
    };

    // Rejecting or closing a lead stops the ladder within the day. Drafting a
    // chase to a landlord who has said no is the outcome closing exists to
    // prevent, one step earlier — the draft route's own argument.
    if (!assignmentSendable(assignment).sendable) {
      await stopRun(admin, run.id, "not_sendable");
      stats.stopped += 1;
      continue;
    }

    const { data: customerRow } = await admin
      .from("customers")
      .select("business_name, contact_name")
      .eq("id", run.customer_id)
      .maybeSingle();

    // What has already gone to this landlord, so the model does not repeat
    // itself or start over. Outbound only: an inbound reply STOPS the run, so
    // by construction there is never one to show.
    let stepContext: DraftStepContext | null = null;
    if (stepNumber > 1) {
      const { data: priorRows } = await admin
        .from("lead_messages")
        .select("body_text, sent_at, created_at")
        .eq("assignment_id", run.assignment_id)
        .eq("channel", "whatsapp")
        .eq("direction", "outbound")
        .neq("status", "failed")
        .order("created_at", { ascending: false })
        .limit(HISTORY_LIMIT);

      const previous = ((priorRows ?? []) as {
        body_text: string | null;
        sent_at: string | null;
        created_at: string;
      }[])
        .filter((m) => Boolean(m.body_text))
        .reverse()
        .map((m) => ({
          text: (m.body_text ?? "").slice(0, HISTORY_CHARS),
          daysAgo: Math.max(
            0,
            Math.round(
              (now.getTime() - new Date(m.sent_at ?? m.created_at).getTime()) / 86_400_000
            )
          ),
        }));

      stepContext = {
        number: stepNumber,
        brief: step?.brief ?? null,
        previous,
      };
    }

    // ⚠️ viewerScopedLead FIRST, and it matters more here than anywhere. On a
    // resold imported lead, lead_profile holds the UPLOADING operator's private
    // working notes — margins, "will take 12%, spoke to Dave". The interactive
    // route scopes one lead at a time because a person asked for it; this scopes
    // two hundred without anybody watching.
    const scoped = viewerScopedLead(
      assignment.lead as never,
      run.customer_id
    ) as unknown as Record<string, unknown>;

    const ctx = buildDraftContext({
      lead: scoped,
      customer: {
        business_name: (customerRow as { business_name?: string } | null)?.business_name ?? null,
        contact_name: (customerRow as { contact_name?: string } | null)?.contact_name ?? null,
      },
      step: stepContext,
    });

    const result = await draftWhatsappMessage(ctx);

    // The ledger, always — a refusal is the thing worth counting. Best-effort:
    // it must never fail the run it is recording.
    const { data: ledgerRow } = await admin
      .from("message_draft_requests")
      .insert({
        customer_id: run.customer_id,
        assignment_id: run.assignment_id,
        channel: "whatsapp",
        origin: "sequence",
        outcome: result.ok ? "drafted" : result.code === "model_error" ? "error" : "rejected",
        reject_reason: result.ok ? null : result.code,
        draft_text: result.ok ? result.text : null,
        model_id: result.ok ? result.modelId : null,
        prompt_version: result.ok ? result.promptVersion : null,
        had_figures: ctx.figures !== null,
      })
      .select("id")
      .maybeSingle();

    drawnToday.set(run.customer_id, (drawnToday.get(run.customer_id) ?? 0) + 1);

    if (!result.ok) {
      // Nothing is written to the queue and the run is left exactly where it
      // was, so tomorrow's pass tries again. Never a template.
      stats.rejected += 1;
      continue;
    }

    // send_after is the step's OWN due time, not now — that gap is the review
    // window, and it is the entire promise of "drafted ahead". A step already
    // overdue goes as soon as the sending phase next runs.
    const sendAfter = new Date(
      Math.max(new Date(run.next_due_at).getTime(), now.getTime())
    );

    const { error: insertErr } = await admin.from("message_sequence_drafts").insert({
      run_id: run.id,
      customer_id: run.customer_id,
      step_number: stepNumber,
      body: result.text,
      draft_id: (ledgerRow as { id: string } | null)?.id ?? null,
      state: "pending",
      send_after: sendAfter.toISOString(),
    });

    if (insertErr) {
      // 23505 means a concurrent pass drafted it. Everything else is ours, and
      // both are safe to leave: the run has not moved, so tomorrow retries.
      if ((insertErr as { code?: string }).code === "23505") {
        stats.alreadyDrafted += 1;
      } else {
        console.error("[draft-sequence-messages] queue insert failed", insertErr);
        stats.rejected += 1;
      }
      continue;
    }

    stats.drafted += 1;
  }

  return NextResponse.json({ ok: true, ...stats, ms: Date.now() - startedAt });
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
