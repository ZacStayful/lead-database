import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { isAdminUser } from "@/lib/auth";
import { syncCustomerMondayStatus } from "@/lib/mondayStatus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Fallback if past_due_lapse_days is missing or unparseable. */
const DEFAULT_LAPSE_DAYS = 3;

type LapseCandidate = {
  id: string;
  email: string;
  contact_name: string | null;
  past_due_since: string | null;
  gr_past_due_since: string | null;
};

async function settings(admin: ReturnType<typeof createAdminClient>) {
  const { data } = await admin.from("system_settings").select("key, value");
  return new Map(
    ((data ?? []) as { key: string; value: string }[]).map((r) => [r.key, r.value])
  );
}

/**
 * GET/POST /api/cron/lapse-past-due
 *
 * Daily. A customer whose collection has been failing for longer than
 * `past_due_lapse_days` (3) is written off: removed from the active-customer
 * population and shown on the Monday sales board as Cancelled rather than
 * "Wants to pay card declined".
 *
 * WHY THIS EXISTS. Stripe reports the clean end of dunning as `unpaid`, which the
 * webhook now maps to a cancellation. But a subscription Stripe simply leaves at
 * past_due never produces that event, and nothing else demoted the customer — so
 * somebody who had cancelled the card authority behind their subscription sat as
 * an active, capacity-consuming, green-badged customer indefinitely. This is the
 * backstop for that case, and in practice it is the common one.
 *
 * IT NEVER CALLS STRIPE. The subscription is left alone to keep retrying, so
 * nothing irreversible happens on a timer and a late success still recovers the
 * customer with no manual step: invoice.paid promotes account_status back out of
 * 'cancelled' (§23.9) and clears both 0094 columns.
 *
 * It also never writes subscription_status. Leaving it 'past_due' keeps the row
 * honest about what Stripe actually reports, and means the customer.subscription
 * events that keep arriving with past_due are a no-op here rather than two
 * writers fighting over one column. lapsed_at is what the Monday label rule reads.
 *
 * Auth mirrors escalate-leads: Bearer $CRON_SECRET, or an admin session.
 * ?dryRun=true reports exactly who would lapse and writes nothing.
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

  // Kill switch, checked before anything else and LOGGED rather than silently
  // skipped — "the job did nothing" and "the job is switched off" look identical
  // in the output otherwise. Same shape as escalation_enabled and pool_enabled.
  if (config.get("past_due_lapse_enabled") !== "true") {
    console.warn("[lapse-past-due] run skipped — past_due_lapse_enabled is not 'true'");
    return NextResponse.json({
      status: "skipped",
      reason: "lapse_disabled",
      message: "past_due_lapse_enabled is not set to true in system_settings.",
    });
  }

  const rawDays = Number((config.get("past_due_lapse_days") ?? "").trim());
  const lapseDays =
    Number.isFinite(rawDays) && rawDays > 0 ? rawDays : DEFAULT_LAPSE_DAYS;

  // Unlike escalation's freshness gate, an unusable value here falls back to the
  // documented default rather than running ungated: "ungated" would mean lapsing
  // every declined customer the moment they decline.
  const cutoff = new Date(Date.now() - lapseDays * 24 * 60 * 60 * 1000);
  const cutoffIso = cutoff.toISOString();

  const nowIso = new Date().toISOString();

  const lapsed: { id: string; email: string; product: string; since: string }[] = [];
  const errors: string[] = [];

  // -----------------------------------------------------------------------
  // Management. account_status = 'cancelled' is the column that does the work:
  // it is what capacity.ts counts, what the admin badge and product tabs read,
  // and what the pause route and top-up gate refuse on. Every other management
  // surface already excluded them the moment they went past_due.
  // -----------------------------------------------------------------------
  const { data: mgmtRows, error: mgmtError } = await admin
    .from("customers")
    .select("id, email, contact_name, past_due_since, gr_past_due_since")
    .eq("is_active", true)
    .eq("subscription_status", "past_due")
    .is("lapsed_at", null)
    .not("past_due_since", "is", null)
    .lte("past_due_since", cutoffIso);

  if (mgmtError) {
    return NextResponse.json({ error: mgmtError.message }, { status: 500 });
  }

  for (const customer of (mgmtRows ?? []) as LapseCandidate[]) {
    if (dryRun) {
      lapsed.push({
        id: customer.id,
        email: customer.email,
        product: "management",
        since: customer.past_due_since ?? "",
      });
      continue;
    }

    // Guarded on lapsed_at still being null so a concurrent run — or a hand-run
    // from the admin session while the cron is firing — cannot double-write and
    // push the board twice. Same discipline as the resume cron's guarded clear.
    //
    // cancelled_at is coalesced in the guard rather than read first: first
    // cancellation wins (§18), so a customer who left before and came back keeps
    // the original date.
    const { data: written, error: writeError } = await admin
      .from("customers")
      .update({
        lapsed_at: nowIso,
        account_status: "cancelled",
        updated_at: nowIso,
      })
      .eq("id", customer.id)
      .is("lapsed_at", null)
      .select("id, cancelled_at")
      .maybeSingle<{ id: string; cancelled_at: string | null }>();

    if (writeError) {
      errors.push(`${customer.id}: ${writeError.message}`);
      console.error("[lapse-past-due] management lapse failed", {
        customer: customer.id,
        error: writeError.message,
      });
      continue;
    }
    if (!written) continue;

    if (!written.cancelled_at) {
      const { error: stampError } = await admin
        .from("customers")
        .update({ cancelled_at: nowIso })
        .eq("id", customer.id)
        .is("cancelled_at", null);
      if (stampError) {
        // Reporting only — the lapse itself has landed, and cancelled_at feeds
        // the churn history rather than any gate. Logged, never retried.
        console.error("[lapse-past-due] cancelled_at stamp failed", {
          customer: customer.id,
          error: stampError.message,
        });
      }
    }

    await pushBoard(admin, customer.id);

    lapsed.push({
      id: customer.id,
      email: customer.email,
      product: "management",
      since: customer.past_due_since ?? "",
    });
  }

  // -----------------------------------------------------------------------
  // Guaranteed Rent. NEVER account_status (invariant 6) — and it needs less:
  // gr_subscription_status = 'past_due' already excludes them from GR routing,
  // GR capacity and every GR email. What the lapse adds here is the board label
  // and the cancellation date.
  // -----------------------------------------------------------------------
  const { data: grRows, error: grError } = await admin
    .from("customers")
    .select("id, email, contact_name, past_due_since, gr_past_due_since")
    .eq("is_active", true)
    .eq("gr_subscription_status", "past_due")
    .is("gr_lapsed_at", null)
    .not("gr_past_due_since", "is", null)
    .lte("gr_past_due_since", cutoffIso);

  if (grError) {
    return NextResponse.json({ error: grError.message }, { status: 500 });
  }

  for (const customer of (grRows ?? []) as LapseCandidate[]) {
    if (dryRun) {
      lapsed.push({
        id: customer.id,
        email: customer.email,
        product: "guaranteed_rent",
        since: customer.gr_past_due_since ?? "",
      });
      continue;
    }

    const { data: written, error: writeError } = await admin
      .from("customers")
      .update({ gr_lapsed_at: nowIso, updated_at: nowIso })
      .eq("id", customer.id)
      .is("gr_lapsed_at", null)
      .select("id, gr_cancelled_at")
      .maybeSingle<{ id: string; gr_cancelled_at: string | null }>();

    if (writeError) {
      errors.push(`${customer.id}: ${writeError.message}`);
      console.error("[lapse-past-due] GR lapse failed", {
        customer: customer.id,
        error: writeError.message,
      });
      continue;
    }
    if (!written) continue;

    if (!written.gr_cancelled_at) {
      const { error: stampError } = await admin
        .from("customers")
        .update({ gr_cancelled_at: nowIso })
        .eq("id", customer.id)
        .is("gr_cancelled_at", null);
      if (stampError) {
        console.error("[lapse-past-due] gr_cancelled_at stamp failed", {
          customer: customer.id,
          error: stampError.message,
        });
      }
    }

    await pushBoard(admin, customer.id);

    lapsed.push({
      id: customer.id,
      email: customer.email,
      product: "guaranteed_rent",
      since: customer.gr_past_due_since ?? "",
    });
  }

  return NextResponse.json({
    status: dryRun ? "dry_run" : "ok",
    lapse_days: lapseDays,
    cutoff: cutoffIso,
    lapsed_count: lapsed.length,
    lapsed,
    errors,
  });
}

/**
 * Move the customer to Cancelled on the sales board.
 *
 * The Customer end date cell looks after itself: board automation 7920935830
 * stamps it on entry into `Cancelled`, and for a lapse "now" is the honest
 * answer anyway — we stopped treating them as a customer today, and there is no
 * future period end to wait for.
 *
 * A customer who holds the OTHER product and is still paying for it will not
 * actually read as Cancelled: the label rule keeps a live GR subscription ahead
 * of a management cancellation. That is deliberate and this function does not
 * second-guess it — one definition of the label, in one place (§23.2).
 *
 * Wrapped, and its skip codes logged, for the same reason the pause and resume
 * hooks are: a Monday failure must never cost the lapse itself.
 */
async function pushBoard(
  admin: ReturnType<typeof createAdminClient>,
  customerId: string
): Promise<void> {
  try {
    const push = await syncCustomerMondayStatus(admin, customerId, {
      reason: "lapse-past-due",
    });
    if (
      push.error ||
      push.skipped === "board_unreadable" ||
      push.skipped === "unlinked"
    ) {
      console.error("[lapse-past-due] Monday push did not land", {
        customer: customerId,
        skipped: push.skipped,
        error: push.error,
      });
    }
  } catch (err) {
    console.error("[lapse-past-due] Monday push threw", err);
  }
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
