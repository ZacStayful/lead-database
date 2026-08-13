import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendInactivityNudgeEmail } from "@/lib/emails";
import { ENGAGEMENT_EVENT_TYPES, type Customer, type LeadType } from "@/lib/types";
import { fetchUkBankHolidays, isBankHoliday, ukDate } from "@/lib/businessTime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// A lead whose status last changed longer ago than this (and has no note) is
// "waiting for follow-up". Tunable via STALE_LEAD_THRESHOLD_DAYS (in days);
// defaults to 2 days (48h) — the historical value — when unset or invalid.
const DEFAULT_THRESHOLD_HOURS = 48;
// How many leads to name in the email before summarising the remainder.
const MAX_LEADS_LISTED = 8;

/**
 * Resolve the "waiting for follow-up" threshold in hours. STALE_LEAD_THRESHOLD_DAYS
 * lets ops tune how many days a lead may sit untouched before it triggers a
 * nudge; a missing / non-positive / non-numeric value keeps the 48h default.
 */
function thresholdHours(): number {
  const raw = process.env.STALE_LEAD_THRESHOLD_DAYS;
  const days = raw != null ? Number(raw) : NaN;
  return Number.isFinite(days) && days > 0 ? days * 24 : DEFAULT_THRESHOLD_HOURS;
}

type NudgeCustomer = Pick<
  Customer,
  | "id"
  | "email"
  | "contact_name"
  | "notification_preferences"
  | "last_nudge_sent_at"
  | "account_status"
  | "subscription_status"
  | "gr_subscription_status"
  | "paused_at"
>;

/** Missing / unset key defaults to true — opt-out is only an explicit false. */
function wantsInactivityNudge(customer: NudgeCustomer): boolean {
  return customer.notification_preferences?.inactivity_nudge !== false;
}

/**
 * Whether this customer is live on the product a given lead belongs to.
 *
 * Deliberately mirrors get_next_customers_for_lead's two branches rather than
 * inventing a rule: if they are eligible to RECEIVE a lead of this type they are
 * eligible to be nudged about one, and if they are not, they should hear
 * nothing. The management branch carries account_status and the pause check;
 * the GR branch carries neither, because both of those columns describe the
 * management subscription only.
 */
function eligibleFor(customer: NudgeCustomer, leadType: LeadType): boolean {
  if (leadType === "guaranteed_rent") {
    return customer.gr_subscription_status === "active";
  }
  return (
    customer.account_status === "active" &&
    customer.subscription_status === "active" &&
    customer.paused_at == null
  );
}

type RawLead = {
  lead_name: string | null;
  address: string | null;
  lead_type: LeadType | null;
};
type RawAssignment = {
  id: string;
  last_status_change_at: string;
  inactivity_escalation_stage: number | null;
  // supabase-js infers an embedded to-one as an array; PostgREST returns a
  // single object at runtime. Accept both and normalise with oneLead().
  leads: RawLead | RawLead[] | null;
};

function oneLead(leads: RawLead | RawLead[] | null): RawLead | null {
  if (!leads) return null;
  return Array.isArray(leads) ? leads[0] ?? null : leads;
}

/**
 * Monday inactivity-nudge cron. Auth: CRON_SECRET bearer only (a pure scheduled
 * job — no admin-session path, unlike /api/monday/sync).
 *
 * For each active, opted-in customer, find lead assignments still awaiting a
 * first follow-up and, if any, send ONE grouped in-portal notification + ONE
 * grouped email, then stamp last_nudge_sent_at for same-day dedup.
 *
 * "Awaiting follow-up" definition: an assignment still in an early-funnel state
 * (status 'new' or 'contacted') whose status last changed >= 48h ago
 * (last_status_change_at, 0035) and which carries no note. This catches both a
 * lead untouched since assignment AND a lead that was contacted and then went
 * quiet. Covers Management and GR both (shared status vocabulary).
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
    cold_count: number;
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
  // assignment is then matched against its own product's eligibility in
  // eligibleFor() before it can appear in a digest.
  const { data: customerRows, error: custErr } = await admin
    .from("customers")
    .select(
      "id, email, contact_name, notification_preferences, last_nudge_sent_at, account_status, subscription_status, gr_subscription_status, paused_at"
    )
    .eq("is_active", true)
    .or("subscription_status.eq.active,gr_subscription_status.eq.active");

  if (custErr) {
    return NextResponse.json({ error: custErr.message }, { status: 500 });
  }

  const cutoffIso = new Date(
    now.getTime() - thresholdHours() * 60 * 60 * 1000
  ).toISOString();

  let nudged = 0;
  let noLeads = 0;
  let alreadyToday = 0;
  let optedOut = 0;

  for (const customer of (customerRows ?? []) as NudgeCustomer[]) {
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

    const { data: assignmentRows, error: aErr } = await admin
      .from("lead_assignments")
      .select(
        "id, last_status_change_at, inactivity_escalation_stage, leads(lead_name, address, lead_type)"
      )
      .eq("customer_id", customer.id)
      // Rejected leads are excluded by this status filter alone: reject sets
      // status = 'rejected' (0019), so no separate rejection check is needed.
      .in("status", ["new", "contacted"])
      .lte("last_status_change_at", cutoffIso);

    if (aErr) {
      console.error("[inactivity-nudge] assignment query failed", {
        customer: customer.id,
        error: aErr.message,
      });
      continue;
    }

    const candidates = (assignmentRows ?? []) as unknown as RawAssignment[];

    if (candidates.length === 0) {
      noLeads += 1;
      continue;
    }

    // Drop anything on a product this customer is not live on. Without this a
    // customer who cancelled Management but kept GR would still be chased about
    // their old management leads.
    const onLiveProduct = candidates.filter((a) =>
      eligibleFor(customer, oneLead(a.leads)?.lead_type ?? "management")
    );
    if (onLiveProduct.length === 0) {
      noLeads += 1;
      continue;
    }

    // Exclude any assignment that already carries a note — a note means the
    // customer has started working the lead, so it is not "waiting".
    const ids = onLiveProduct.map((a) => a.id);
    const { data: notedRows } = await admin
      .from("lead_notes")
      .select("lead_assignment_id")
      .in("lead_assignment_id", ids);
    const noted = new Set(
      (notedRows ?? []).map(
        (n) => (n as { lead_assignment_id: string }).lead_assignment_id
      )
    );

    // Exclude anything the operator has demonstrably engaged with, and anything
    // already nudged.
    //
    // The telemetry check is what makes this honest. status and
    // last_status_change_at only know what the operator DECLARED; a lead that
    // was opened and read, or whose landlord was rung, may still sit at 'new'.
    // Worse, since the auto-contact trigger a phone click moves the status to
    // 'contacted' — which keeps it inside the status filter above — so without
    // this the digest would chase leads the operator had already actioned.
    //
    // nudge_sent makes the nudge once-per-assignment-ever. Previously a lead the
    // operator had decided to leave alone reappeared in the digest every week,
    // which teaches people to ignore the digest rather than the lead.
    const { data: eventRows } = await admin
      .from("lead_events")
      .select("assignment_id, event_type")
      .in("assignment_id", ids)
      .in("event_type", [...ENGAGEMENT_EVENT_TYPES, "nudge_sent"]);

    const excludedByEvent = new Set(
      (eventRows ?? []).map(
        (e) => (e as { assignment_id: string }).assignment_id
      )
    );

    const stillWaiting = onLiveProduct.filter(
      (a) => !noted.has(a.id) && !excludedByEvent.has(a.id)
    );

    // Split off the leads that have already been escalated.
    //
    // Chasing somebody about a lead we have already offered to another operator
    // reads as the system not knowing what it is doing — they still hold it, but
    // it is no longer theirs alone and a first contact now is a race they are
    // ten days late to. They are counted and mentioned as a group instead, so
    // the digest names only the leads still genuinely worth a call today.
    const waiting = stillWaiting.filter(
      (a) => (a.inactivity_escalation_stage ?? 0) === 0
    );
    const coldCount = stillWaiting.length - waiting.length;

    if (waiting.length === 0) {
      noLeads += 1;
      continue;
    }

    const count = waiting.length;
    // Only the leads actually NAMED in the email are marked as nudged.
    //
    // The digest lists at most MAX_LEADS_LISTED and summarises the rest as
    // "…and N more". Marking all of them would, combined with the
    // once-per-assignment rule, mean a customer sitting on 30 stale leads gets
    // one email naming 8 and never hears about the other 22 again. Marking only
    // the named ones lets the digest work through the backlog a slice at a
    // time, and every lead gets named exactly once.
    const listed = waiting.slice(0, MAX_LEADS_LISTED);
    const leadsForEmail = listed.map((a) => {
      const lead = oneLead(a.leads);
      return {
        name: lead?.lead_name ?? "Lead",
        address: lead?.address ?? null,
      };
    });

    // Dry run: report exactly who would be emailed and about what, then stop
    // before any side effect. Nothing is sent, nothing is stamped, no event is
    // written — so a dry run leaves the next real run's behaviour identical.
    if (dryRun) {
      wouldNudge.push({
        customer_id: customer.id,
        email: customer.email,
        lead_count: count,
        management_leads: waiting.filter(
          (a) => oneLead(a.leads)?.lead_type !== "guaranteed_rent"
        ).length,
        gr_leads: waiting.filter(
          (a) => oneLead(a.leads)?.lead_type === "guaranteed_rent"
        ).length,
        cold_count: coldCount,
        leads: leadsForEmail.map((l) => l.name),
      });
      nudged += 1;
      continue;
    }

    // One grouped in-portal notification (not tied to a single assignment).
    await admin.from("notifications").insert({
      customer_id: customer.id,
      lead_assignment_id: null,
      notification_type: "inactivity_nudge",
      message: `You have ${count} lead${count === 1 ? "" : "s"} waiting for follow-up`,
    });

    // One grouped email.
    const { error: emailError } = await sendInactivityNudgeEmail({
      to: customer.email,
      contactName: customer.contact_name,
      count,
      leads: leadsForEmail,
      coldCount,
    });
    if (emailError) {
      console.error("[inactivity-nudge] email failed", {
        customer: customer.id,
        error: emailError,
      });
    }

    // Record the nudge against each assignment the email actually NAMED, so no
    // lead is ever chased twice and none is silently written off. Written even
    // if the email failed: a failed send is retried by nothing, and re-listing
    // the same lead next week is the behaviour this is here to stop. The
    // grouped notification above already landed in-portal.
    const { error: eventErr } = await admin.from("lead_events").insert(
      listed.map((a) => ({
        assignment_id: a.id,
        event_type: "nudge_sent" as const,
      }))
    );
    if (eventErr) {
      console.error("[inactivity-nudge] nudge_sent insert failed", {
        customer: customer.id,
        error: eventErr.message,
      });
    }

    // Stamp the send so a same-day re-run skips this customer next time.
    await admin
      .from("customers")
      .update({ last_nudge_sent_at: now.toISOString() })
      .eq("id", customer.id);

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
