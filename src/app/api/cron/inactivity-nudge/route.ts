import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendInactivityNudgeEmail } from "@/lib/emails";
import type { Customer } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// gov.uk bank holidays API (division-specific endpoint, confirmed returning a
// { division, events: [{ title, date, notes, bunting }] } object). Docs:
// https://www.gov.uk/bank-holidays — the .json feeds are the documented API.
const BANK_HOLIDAY_URL =
  "https://www.gov.uk/bank-holidays/england-and-wales.json";
const BANK_HOLIDAY_TIMEOUT_MS = 8000;

// A lead whose status last changed this many hours ago (and has no note) is
// "waiting for follow-up".
const INACTIVITY_HOURS = 48;
// How many leads to name in the email before summarising the remainder.
const MAX_LEADS_LISTED = 8;

/** Today's date (YYYY-MM-DD) in UK local time — en-CA formats as ISO date. */
function ukDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
  }).format(d);
}

/**
 * True if today (UK date) is an England & Wales bank holiday.
 *
 * FAILS OPEN: any network error, timeout or non-200 returns false (treated as
 * "not a bank holiday"), so a gov.uk outage never suppresses the nudge. The
 * fall-open is logged.
 */
async function isUkBankHolidayToday(today: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BANK_HOLIDAY_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(BANK_HOLIDAY_URL, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      console.warn(
        `[inactivity-nudge] bank-holiday check HTTP ${res.status}; failing open`
      );
      return false;
    }
    const data = (await res.json()) as { events?: { date: string }[] };
    return (data.events ?? []).some((e) => e.date === today);
  } catch (err) {
    console.warn(
      "[inactivity-nudge] bank-holiday check errored; failing open",
      err
    );
    return false;
  }
}

type NudgeCustomer = Pick<
  Customer,
  "id" | "email" | "contact_name" | "notification_preferences" | "last_nudge_sent_at"
>;

/** Missing / unset key defaults to true — opt-out is only an explicit false. */
function wantsInactivityNudge(customer: NudgeCustomer): boolean {
  return customer.notification_preferences?.inactivity_nudge !== false;
}

type RawLead = { lead_name: string | null; address: string | null };
type RawAssignment = {
  id: string;
  last_status_change_at: string;
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

  const now = new Date();
  const today = ukDate(now);

  // Skip UK bank holidays (fail open on any error/timeout — see helper).
  if (await isUkBankHolidayToday(today)) {
    console.log(`[inactivity-nudge] ${today} is a bank holiday; skipping.`);
    return NextResponse.json({
      status: "skipped",
      reason: "bank_holiday",
      date: today,
    });
  }

  const admin = createAdminClient();

  const { data: customerRows, error: custErr } = await admin
    .from("customers")
    .select(
      "id, email, contact_name, notification_preferences, last_nudge_sent_at"
    )
    .eq("is_active", true);

  if (custErr) {
    return NextResponse.json({ error: custErr.message }, { status: 500 });
  }

  const cutoffIso = new Date(
    now.getTime() - INACTIVITY_HOURS * 60 * 60 * 1000
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
      .select("id, last_status_change_at, leads(lead_name, address)")
      .eq("customer_id", customer.id)
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

    // Exclude any assignment that already carries a note — a note means the
    // customer has started working the lead, so it is not "waiting".
    const ids = candidates.map((a) => a.id);
    const { data: notedRows } = await admin
      .from("lead_notes")
      .select("lead_assignment_id")
      .in("lead_assignment_id", ids);
    const noted = new Set(
      (notedRows ?? []).map(
        (n) => (n as { lead_assignment_id: string }).lead_assignment_id
      )
    );

    const waiting = candidates.filter((a) => !noted.has(a.id));
    if (waiting.length === 0) {
      noLeads += 1;
      continue;
    }

    const count = waiting.length;
    const leadsForEmail = waiting.slice(0, MAX_LEADS_LISTED).map((a) => {
      const lead = oneLead(a.leads);
      return {
        name: lead?.lead_name ?? "Lead",
        address: lead?.address ?? null,
      };
    });

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
    });
    if (emailError) {
      console.error("[inactivity-nudge] email failed", {
        customer: customer.id,
        error: emailError,
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
    date: today,
    nudged,
    skipped: {
      no_leads: noLeads,
      already_today: alreadyToday,
      opted_out: optedOut,
    },
  });
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
