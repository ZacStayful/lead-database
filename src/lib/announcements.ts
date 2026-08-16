import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  Announcement,
  AnnouncementAudience,
  NotificationPreferences,
} from "@/lib/types";

/**
 * Announcements — the audience rule, the opt-out, and the body split.
 *
 * ONE DEFINITION, TWO CONSUMERS. The send route and the dashboard banner both
 * import announcementTargetsCustomer from here. If they each had their own
 * reading of "management customer" they would eventually disagree, and the
 * failure mode is silent: an announcement emailed to somebody whose banner
 * hides it, or a banner shown to somebody who was never told. This is the same
 * discipline as customer_can_see_pool_lead being one definition shared by the
 * pool listing and the pool claim (§19.4).
 */

export const ANNOUNCEMENT_AUDIENCES = [
  "all",
  "management",
  "guaranteed_rent",
] as const;

/** How long an undismissed banner keeps showing. */
export const BANNER_MAX_AGE_DAYS = 30;

/** Human label for an audience, used in admin copy and confirmations. */
export function audienceLabel(audience: AnnouncementAudience): string {
  if (audience === "management") return "Management subscribers";
  if (audience === "guaranteed_rent") return "Guaranteed Rent subscribers";
  return "All subscribers";
}

/**
 * The subset of a customer row the audience rule needs. Deliberately narrow so
 * a caller cannot accidentally pass a whole row and have some other column
 * start mattering later.
 */
export type AnnouncementCandidate = {
  account_status: string | null;
  subscription_status: string | null;
  gr_subscription_status: string | null;
  notification_preferences?: Partial<NotificationPreferences> | null;
};

/**
 * Does this announcement address this customer?
 *
 * The two product branches mirror eligibleFor() in the progress-report cron,
 * which is the established reading of "holds this product right now":
 *
 *   - management requires BOTH account_status and subscription_status active;
 *   - guaranteed rent reads gr_subscription_status and NOTHING else. It must
 *     never consult account_status — that column is management-only, is left
 *     untouched by the Stripe webhook on a GR cancellation, and a GR-only
 *     subscriber sits at account_status = 'waitlisted' forever (§18A). Reading
 *     it here would address a live GR customer as a prospect and skip them.
 *     Invariant 6.
 *
 * PAUSED MANAGEMENT CUSTOMERS ARE NOT EXCLUDED. §18B's asymmetry is the
 * precedent: the nudge cron skips paused customers because a nudge asks for
 * work, and the progress report does not because it describes work already
 * done. An announcement is a notice, so it follows the report. Somebody who
 * paused for three months still needs to hear about a price change.
 *
 * Archiving is handled by the caller's `is_active` filter, not here — an
 * archived row is a superseded duplicate signup (§18D) and must be out of every
 * list, not just this one.
 */
export function announcementTargetsCustomer(
  audience: AnnouncementAudience,
  customer: AnnouncementCandidate
): boolean {
  const holdsManagement =
    customer.account_status === "active" &&
    customer.subscription_status === "active";
  const holdsGuaranteedRent = customer.gr_subscription_status === "active";

  if (audience === "management") return holdsManagement;
  if (audience === "guaranteed_rent") return holdsGuaranteedRent;
  return holdsManagement || holdsGuaranteedRent;
}

/**
 * Does this customer want announcement EMAILS?
 *
 * Opt-out only, and a missing key reads as true — the same defensive shape as
 * wantsInsights, because the column has carried a different set of keys at
 * different times and no reader should depend on a backfill having run.
 *
 * Only the email consults this. The banner does not: see the module header.
 */
export function wantsAnnouncements(customer: AnnouncementCandidate): boolean {
  return customer.notification_preferences?.announcements !== false;
}

/**
 * Split an announcement body into paragraphs.
 *
 * Plain text, split on blank lines — the same treatment the training article
 * page gives body_markdown, and for the same reason: no markdown renderer is
 * installed, so nothing can turn stored content into markup. Extracted here so
 * the email and the banner cannot render the same body differently.
 */
export function paragraphs(body: string): string[] {
  return body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** True once the announcement has gone out and is no longer editable. */
export function isSent(a: Pick<Announcement, "status">): boolean {
  return a.status === "sent";
}

export type AnnouncementRecipient = {
  id: string;
  email: string;
  contact_name: string | null;
  business_name: string | null;
  account_status: string | null;
  subscription_status: string | null;
  gr_subscription_status: string | null;
  notification_preferences: Partial<NotificationPreferences> | null;
};

const RECIPIENT_COLUMNS =
  "id, email, contact_name, business_name, account_status, subscription_status, gr_subscription_status, notification_preferences";

/**
 * Every customer who could receive an announcement, before any audience filter.
 *
 * The query is the crons' verbatim (progress-report:107, inactivity-nudge:153):
 * active on EITHER product, and `is_active = true` to drop archived rows. That
 * last filter is the one that stops the same person being emailed twice — an
 * archived row is a superseded duplicate signup kept for its history (§18D),
 * usually carrying the same address as the live account.
 *
 * The per-product decision is then made in memory by announcementTargetsCustomer
 * rather than in the query. Same two-step as §18B: the union decides who is
 * worth looking at, the per-audience check decides who is actually addressed.
 */
export async function fetchAnnouncementCandidates(
  admin: SupabaseClient
): Promise<{ rows: AnnouncementRecipient[]; error: string | null }> {
  const { data, error } = await admin
    .from("customers")
    .select(RECIPIENT_COLUMNS)
    .eq("is_active", true)
    .or("subscription_status.eq.active,gr_subscription_status.eq.active");

  if (error) return { rows: [], error: error.message };

  // An account with no address on file cannot be emailed. It would otherwise
  // reach Resend as an empty `to` and come back as a per-recipient failure that
  // looks like an outage.
  const rows = ((data ?? []) as AnnouncementRecipient[]).filter((c) =>
    Boolean(c.email?.trim())
  );
  return { rows, error: null };
}

/**
 * Who this announcement actually goes to, in send order.
 *
 * `emailable` is the list to send; `optedOut` is reported separately rather than
 * dropped silently, so the admin sees "14 of 16" and knows the missing two chose
 * it rather than wondering whether the run half-failed. Both still see the
 * banner — the opt-out governs the inbox only.
 *
 * One entry per CUSTOMER, never per product: somebody holding both management
 * and GR receives a single email under audience 'all'. This is the opposite of
 * the MRR figures in §18A, which deliberately count per product.
 */
export function splitRecipients(
  audience: AnnouncementAudience,
  candidates: AnnouncementRecipient[]
): { emailable: AnnouncementRecipient[]; optedOut: AnnouncementRecipient[] } {
  const addressed = candidates.filter((c) =>
    announcementTargetsCustomer(audience, c)
  );
  return {
    emailable: addressed.filter((c) => wantsAnnouncements(c)),
    optedOut: addressed.filter((c) => !wantsAnnouncements(c)),
  };
}

/**
 * The one announcement to show this customer on their dashboard, if any.
 *
 * Governed by AUDIENCE, not by delivery: a customer who turned the emails off
 * still sees the banner, and so does one whose email bounced. Delivery records
 * what reached an inbox; this answers "was this addressed to them", which is a
 * different question and the right one for an in-app notice.
 *
 * ONE banner, never a stack. Two notices competing for the top of the dashboard
 * is how both get ignored, so the newest wins and the older one stays in the
 * inbox where it was already sent.
 *
 * The 30-day cut-off is what stops an undismissed banner living on the
 * dashboard forever. Somebody who never clicks the X should not still be
 * reading about a September price change the following spring.
 */
export async function fetchBannerAnnouncement(
  admin: SupabaseClient,
  customer: AnnouncementCandidate & { id: string }
): Promise<Announcement | null> {
  const since = new Date(
    Date.now() - BANNER_MAX_AGE_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  // A small window of recent candidates rather than one row: the newest
  // announcement may be addressed to the other product, or already dismissed,
  // and either way the next one down is still worth showing.
  const { data, error } = await admin
    .from("announcements")
    .select("*")
    .eq("status", "sent")
    .eq("show_banner", true)
    .gte("sent_at", since)
    .order("sent_at", { ascending: false })
    .limit(10);

  if (error || !data?.length) return null;

  const addressed = (data as Announcement[]).filter((a) =>
    announcementTargetsCustomer(a.audience, customer)
  );
  if (!addressed.length) return null;

  const { data: dismissedRows } = await admin
    .from("announcement_dismissals")
    .select("announcement_id")
    .eq("customer_id", customer.id)
    .in(
      "announcement_id",
      addressed.map((a) => a.id)
    );

  const dismissed = new Set(
    ((dismissedRows ?? []) as { announcement_id: string }[]).map(
      (d) => d.announcement_id
    )
  );

  return addressed.find((a) => !dismissed.has(a.id)) ?? null;
}

/**
 * Recipient counts for all three audiences at once.
 *
 * Computed server-side from one query and handed to the compose form, so the
 * count beside each audience button is a real number rather than an estimate,
 * and no extra endpoint exists for a browser to poll.
 */
export function audienceCounts(
  candidates: AnnouncementRecipient[]
): Record<AnnouncementAudience, number> {
  return {
    all: splitRecipients("all", candidates).emailable.length,
    management: splitRecipients("management", candidates).emailable.length,
    guaranteed_rent: splitRecipients("guaranteed_rent", candidates).emailable
      .length,
  };
}

export type AnnouncementWrite = {
  subject: string;
  title: string;
  body_text: string;
  audience: AnnouncementAudience;
  link_url: string | null;
  link_label: string | null;
  show_banner: boolean;
};

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const MAX_SUBJECT = 200;
const MAX_TITLE = 200;
const MAX_BODY = 20000;

/**
 * Validate an admin-submitted announcement.
 *
 * Same shape as validateTrainingWrite: everything is enforced server-side
 * regardless of what the form did, because a form is a suggestion and a route
 * is a boundary.
 *
 * `link_url` is required to be https and to parse. It becomes an anchor in an
 * email going to the whole customer book; a javascript: or data: URL there is
 * worth refusing at the boundary even though the only author is an admin.
 */
export function validateAnnouncementWrite(
  body: Record<string, unknown>
): { ok: true; value: AnnouncementWrite } | { ok: false; error: string } {
  const subject = asTrimmedString(body.subject);
  const title = asTrimmedString(body.title);
  const bodyText = asTrimmedString(body.body_text);

  if (!subject) return { ok: false, error: "Subject is required." };
  if (subject.length > MAX_SUBJECT) {
    return { ok: false, error: `Subject must be ${MAX_SUBJECT} characters or fewer.` };
  }
  if (!title) return { ok: false, error: "Title is required." };
  if (title.length > MAX_TITLE) {
    return { ok: false, error: `Title must be ${MAX_TITLE} characters or fewer.` };
  }
  if (!bodyText) return { ok: false, error: "Message is required." };
  if (bodyText.length > MAX_BODY) {
    return { ok: false, error: "Message is too long." };
  }

  const audience = asTrimmedString(body.audience) as AnnouncementAudience;
  if (!(ANNOUNCEMENT_AUDIENCES as readonly string[]).includes(audience)) {
    return {
      ok: false,
      error: "Audience must be all, management or guaranteed_rent.",
    };
  }

  let linkUrl: string | null = null;
  let linkLabel: string | null = null;
  const rawUrl = asTrimmedString(body.link_url);
  if (rawUrl) {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return { ok: false, error: "Link URL is not a valid URL." };
    }
    if (parsed.protocol !== "https:") {
      return { ok: false, error: "Link URL must start with https://" };
    }
    linkUrl = parsed.toString();
    linkLabel = asTrimmedString(body.link_label);
    if (!linkLabel) {
      return { ok: false, error: "A link needs a button label." };
    }
  }

  return {
    ok: true,
    value: {
      subject,
      title,
      body_text: bodyText,
      audience,
      link_url: linkUrl,
      link_label: linkLabel,
      show_banner: body.show_banner !== false,
    },
  };
}
