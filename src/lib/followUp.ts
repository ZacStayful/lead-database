import type { SupabaseClient } from "@supabase/supabase-js";
import { sendFollowUpReminderEmail, sendInactivityNudgeEmail } from "@/lib/emails";
import { ENGAGEMENT_EVENT_TYPES, type Customer, type LeadType } from "@/lib/types";

/**
 * Shared definition of "this lead is waiting for follow-up", used by both the
 * Monday inactivity-nudge cron and the admin-triggered reminder action on the
 * customers table. Both must agree on the rule — otherwise an admin chases a
 * lead the automated digest considers actioned, or vice versa.
 */

// A lead whose status last changed longer ago than this (and has no note) is
// "waiting for follow-up". Tunable via STALE_LEAD_THRESHOLD_DAYS (in days);
// defaults to 2 days (48h) — the historical value — when unset or invalid.
const DEFAULT_THRESHOLD_HOURS = 48;

/** How many leads to name in a reminder email before summarising the remainder. */
export const MAX_LEADS_LISTED = 8;

/**
 * Resolve the "waiting for follow-up" threshold in hours. STALE_LEAD_THRESHOLD_DAYS
 * lets ops tune how many days a lead may sit untouched before it triggers a
 * nudge; a missing / non-positive / non-numeric value keeps the 48h default.
 */
export function thresholdHours(): number {
  const raw = process.env.STALE_LEAD_THRESHOLD_DAYS;
  const days = raw != null ? Number(raw) : NaN;
  return Number.isFinite(days) && days > 0 ? days * 24 : DEFAULT_THRESHOLD_HOURS;
}

/** Timestamp before which an untouched lead counts as waiting for follow-up. */
export function staleCutoffIso(now: Date): string {
  return new Date(now.getTime() - thresholdHours() * 60 * 60 * 1000).toISOString();
}

export type NudgeCustomer = Pick<
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
  | "is_active"
>;

/** Columns a NudgeCustomer needs — keep in step with the type above. */
export const NUDGE_CUSTOMER_COLUMNS =
  "id, email, contact_name, notification_preferences, last_nudge_sent_at, account_status, subscription_status, gr_subscription_status, paused_at, is_active";

/** Missing / unset key defaults to true — opt-out is only an explicit false. */
export function wantsInactivityNudge(customer: NudgeCustomer): boolean {
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
export function eligibleFor(
  customer: NudgeCustomer,
  leadType: LeadType
): boolean {
  if (leadType === "guaranteed_rent") {
    return customer.gr_subscription_status === "active";
  }
  return (
    customer.account_status === "active" &&
    customer.subscription_status === "active" &&
    customer.paused_at == null
  );
}

/** Whether the customer is live on either product at all. */
export function isLiveOnAnyProduct(customer: NudgeCustomer): boolean {
  return (
    eligibleFor(customer, "management") ||
    eligibleFor(customer, "guaranteed_rent")
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
  // supabase-js infers an embedded to-one as an array; PostgREST returns a
  // single object at runtime. Accept both and normalise with oneLead().
  leads: RawLead | RawLead[] | null;
};

function oneLead(leads: RawLead | RawLead[] | null): RawLead | null {
  if (!leads) return null;
  return Array.isArray(leads) ? leads[0] ?? null : leads;
}

export interface WaitingLead {
  assignmentId: string;
  name: string;
  address: string | null;
  leadType: LeadType;
}

/**
 * Lead assignments still awaiting a first follow-up, oldest first.
 *
 * "Awaiting follow-up" definition: an assignment still in an early-funnel state
 * (status 'new' or 'contacted') whose status last changed >= the stale threshold
 * ago (last_status_change_at, 0035), which carries no note, and which has no
 * engagement telemetry against it. Covers Management and GR both (shared status
 * vocabulary), with each assignment matched against its own product's
 * eligibility so a customer is never chased about a product they have left.
 *
 * `includeAlreadyNudged` controls the once-per-assignment rule. The automated
 * digest leaves it off, so a lead the operator has decided to leave alone does
 * not reappear every week. An admin pressing "Send reminder" turns it on: they
 * are deliberately chasing the backlog as it stands, previous nudges included.
 */
export async function findLeadsAwaitingFollowUp(
  admin: SupabaseClient,
  customer: NudgeCustomer,
  opts: { cutoffIso: string; includeAlreadyNudged?: boolean }
): Promise<{ waiting: WaitingLead[]; error: string | null }> {
  const { data: assignmentRows, error: aErr } = await admin
    .from("lead_assignments")
    .select("id, last_status_change_at, leads(lead_name, address, lead_type)")
    .eq("customer_id", customer.id)
    // Rejected leads are excluded by this status filter alone: reject sets
    // status = 'rejected' (0019), so no separate rejection check is needed.
    .in("status", ["new", "contacted"])
    .lte("last_status_change_at", opts.cutoffIso)
    // Oldest-waiting first, so the leads named in the email are the ones that
    // have been sitting the longest rather than an arbitrary slice.
    .order("last_status_change_at", { ascending: true });

  if (aErr) return { waiting: [], error: aErr.message };

  const candidates = (assignmentRows ?? []) as unknown as RawAssignment[];
  if (candidates.length === 0) return { waiting: [], error: null };

  // Drop anything on a product this customer is not live on. Without this a
  // customer who cancelled Management but kept GR would still be chased about
  // their old management leads.
  const onLiveProduct = candidates.filter((a) =>
    eligibleFor(customer, oneLead(a.leads)?.lead_type ?? "management")
  );
  if (onLiveProduct.length === 0) return { waiting: [], error: null };

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

  // Exclude anything the operator has demonstrably engaged with, and (for the
  // automated digest) anything already nudged.
  //
  // The telemetry check is what makes this honest. status and
  // last_status_change_at only know what the operator DECLARED; a lead that
  // was opened and read, or whose landlord was rung, may still sit at 'new'.
  // Worse, since the auto-contact trigger a phone click moves the status to
  // 'contacted' — which keeps it inside the status filter above — so without
  // this the digest would chase leads the operator had already actioned.
  const eventTypes: string[] = [...ENGAGEMENT_EVENT_TYPES];
  if (!opts.includeAlreadyNudged) eventTypes.push("nudge_sent");

  const { data: eventRows } = await admin
    .from("lead_events")
    .select("assignment_id, event_type")
    .in("assignment_id", ids)
    .in("event_type", eventTypes);

  const excludedByEvent = new Set(
    (eventRows ?? []).map((e) => (e as { assignment_id: string }).assignment_id)
  );

  const waiting = onLiveProduct
    .filter((a) => !noted.has(a.id) && !excludedByEvent.has(a.id))
    .map((a) => {
      const lead = oneLead(a.leads);
      return {
        assignmentId: a.id,
        name: lead?.lead_name ?? "Lead",
        address: lead?.address ?? null,
        leadType: (lead?.lead_type ?? "management") as LeadType,
      };
    });

  return { waiting, error: null };
}

/**
 * Record a nudge against each assignment the email named, and stamp the send on
 * the customer. Written even if the email failed: a failed send is retried by
 * nothing, and re-listing the same lead next week is the behaviour the
 * per-assignment record exists to stop. Shared so the cron and the admin action
 * leave identical audit trails.
 */
export async function recordNudge(
  admin: SupabaseClient,
  customerId: string,
  namedAssignmentIds: string[],
  now: Date
): Promise<void> {
  if (namedAssignmentIds.length > 0) {
    const { error } = await admin.from("lead_events").insert(
      namedAssignmentIds.map((assignment_id) => ({
        assignment_id,
        event_type: "nudge_sent" as const,
      }))
    );
    if (error) {
      console.error("[follow-up] nudge_sent insert failed", {
        customer: customerId,
        error: error.message,
      });
    }
  }

  await admin
    .from("customers")
    .update({ last_nudge_sent_at: now.toISOString() })
    .eq("id", customerId);
}

/** Send the automated digest for one customer (used by the Monday cron). */
export async function sendInactivityDigest(
  admin: SupabaseClient,
  customer: NudgeCustomer,
  waiting: WaitingLead[],
  now: Date
): Promise<void> {
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

  // One grouped in-portal notification (not tied to a single assignment).
  await admin.from("notifications").insert({
    customer_id: customer.id,
    lead_assignment_id: null,
    notification_type: "inactivity_nudge",
    message: `You have ${count} lead${count === 1 ? "" : "s"} waiting for follow-up`,
  });

  const { error: emailError } = await sendInactivityNudgeEmail({
    to: customer.email,
    contactName: customer.contact_name,
    count,
    leads: listed.map((l) => ({ name: l.name, address: l.address })),
  });
  if (emailError) {
    console.error("[inactivity-nudge] email failed", {
      customer: customer.id,
      error: emailError,
    });
  }

  await recordNudge(
    admin,
    customer.id,
    listed.map((l) => l.assignmentId),
    now
  );
}

export type ReminderSkipReason =
  | "no_login"
  | "opted_out"
  | "not_live"
  | "switched_off"
  | "lookup_failed";

export interface ReminderResult {
  customerId: string;
  email: string;
  businessName?: string;
  sent: boolean;
  /** Leads named in the email (0 when it is a pure "log in" reminder). */
  leadCount: number;
  skipped?: ReminderSkipReason;
  error?: string;
}

const SKIP_MESSAGES: Record<ReminderSkipReason, string> = {
  no_login: "has no portal login yet — invite them instead",
  opted_out: "has turned off reminder emails in their notification settings",
  not_live: "is not live on either product, so has nothing to follow up",
  switched_off: "is switched off for lead routing — reactivate them first",
  lookup_failed: "could not be checked for waiting leads",
};

/** Human-readable explanation for a skipped reminder. */
export function skipMessage(reason: ReminderSkipReason): string {
  return SKIP_MESSAGES[reason];
}

/**
 * Admin-triggered "log in and follow up your leads" reminder for one customer.
 *
 * Unlike the Monday digest this is always deliberate, so it ignores both the
 * same-day dedup and the once-per-assignment rule — an admin pressing the
 * button wants the reminder to go out now, covering the backlog as it stands.
 * It still respects the customer's own opt-out and still refuses to chase a
 * product they have left. When nothing is waiting it sends the shorter "your
 * dashboard is there when you need it" variant rather than nothing at all,
 * because the point of the action is also to get a dormant operator back in.
 */
export async function sendFollowUpReminder(
  admin: SupabaseClient,
  customer: NudgeCustomer & { user_id: string | null; business_name?: string },
  now: Date
): Promise<ReminderResult> {
  const base = {
    customerId: customer.id,
    email: customer.email,
    businessName: customer.business_name,
  };

  if (!customer.user_id) {
    return { ...base, sent: false, leadCount: 0, skipped: "no_login" };
  }
  if (!wantsInactivityNudge(customer)) {
    return { ...base, sent: false, leadCount: 0, skipped: "opted_out" };
  }
  if (!isLiveOnAnyProduct(customer)) {
    return { ...base, sent: false, leadCount: 0, skipped: "not_live" };
  }
  // is_active is the admin kill-switch that also removes a customer from the
  // digest's population; honour it here so the two paths chase the same people.
  if (!customer.is_active) {
    return { ...base, sent: false, leadCount: 0, skipped: "switched_off" };
  }

  const { waiting, error } = await findLeadsAwaitingFollowUp(admin, customer, {
    cutoffIso: staleCutoffIso(now),
    includeAlreadyNudged: true,
  });
  if (error) {
    return {
      ...base,
      sent: false,
      leadCount: 0,
      skipped: "lookup_failed",
      error,
    };
  }

  const listed = waiting.slice(0, MAX_LEADS_LISTED);
  const count = waiting.length;

  const { error: emailError } = await sendFollowUpReminderEmail({
    to: customer.email,
    contactName: customer.contact_name,
    count,
    leads: listed.map((l) => ({ name: l.name, address: l.address })),
  });

  // A failed send leaves no trace on purpose. The cron writes its nudge record
  // regardless because nothing retries it, but this action is retried by the
  // admin pressing the button again — so recording a nudge that never arrived
  // would only hide those leads from the next digest.
  if (emailError) {
    return {
      ...base,
      sent: false,
      leadCount: count,
      error: errorMessage(emailError),
    };
  }

  // In-portal notification, so the reminder is also waiting when they sign in.
  await admin.from("notifications").insert({
    customer_id: customer.id,
    lead_assignment_id: null,
    notification_type: "follow_up_reminder",
    message:
      count > 0
        ? `You have ${count} lead${count === 1 ? "" : "s"} waiting for follow-up`
        : "Sign in to review your leads",
  });

  await recordNudge(
    admin,
    customer.id,
    listed.map((l) => l.assignmentId),
    now
  );

  return { ...base, sent: true, leadCount: count };
}

/** Best-effort message from a Resend error object, an Error, or a string. */
function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return "Email provider rejected the send";
}
