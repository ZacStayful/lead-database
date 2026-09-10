/**
 * The feature-request ask that rides along with every announcement.
 *
 * ONE DEFINITION, TWO CONSUMERS — the announcement email (`sendAnnouncementEmail`
 * in `src/lib/emails.ts`) and the dashboard banner (`AnnouncementBanner`). Same
 * discipline as `announcementTargetsCustomer` and `paragraphs` in
 * `src/lib/announcements.ts`: two readings of "where does this button go" would
 * eventually disagree, and a customer following a stale link from an inbox is
 * exactly the failure nobody reports.
 *
 * THIS MODULE MUST STAY IMPORT-FREE. The banner is a "use client" component, so
 * these constants cannot live in `announcements.ts` — that file pulls in
 * supabase-js for `fetchAnnouncementCandidates`, which would then be dragged
 * into the client bundle.
 *
 * The destination is the EXISTING feedback form (`src/app/feedback/page.tsx`),
 * which prefills from the signed-in customer and emails FEEDBACK_EMAIL via
 * `sendFeedbackEmail`. Since §46 that route also LOGS the request to
 * `support_tickets` before sending, so a request made through this button is
 * durable and shows up on /admin/support — the module itself still persists
 * nothing, which is what keeps it import-free. (This comment used to say
 * "nothing here persists a request; see CLAUDE.md §22.8": the claim is now
 * false, and the section was 21.8 — the subsections under §22 are numbered
 * 21.x, a pre-existing off-by-one in that file.)
 */

/**
 * Where the button goes, and where it says it came from.
 *
 * `type=feature` is passed EXPLICITLY even though the feedback page already
 * defaults to `feature` for any non-`bug` value — the link must not depend on
 * that default staying put.
 *
 * `page=<source>` is the attribution: it prefills the form's "Which page or
 * screen?" field, so a request says where it was made from in the email and on
 * the ticket. WITHOUT IT EVERY REQUEST LOOKS ALIKE AND THERE IS NO WAY TO TELL
 * WHETHER A BUTTON DOES ANYTHING — which is the entire reason to have more than
 * one entry point.
 *
 * ⚠️ It became a FUNCTION in §47, when the header gained a second copy of this
 * button. A single constant would have made both entry points report
 * themselves as "Announcement" and the comparison would have been quietly
 * meaningless. The old constant survives as the announcement caller's argument,
 * so nothing about that link changed.
 *
 * NOTE for any HTML caller: the `&` between the two params must be escaped to
 * `&amp;` before it goes into an `href` attribute. See `sendAnnouncementEmail`.
 */
export function featureRequestPath(source: string): string {
  return `/feedback?type=feature&page=${encodeURIComponent(source)}`;
}

/** The announcement email and dashboard banner. Unchanged from before §47. */
export const FEATURE_REQUEST_PATH = featureRequestPath("Announcement");

/** The dashboard header nav entry (§47). */
export const FEATURE_REQUEST_HEADER_PATH = featureRequestPath("Header");

/** The line above the button. Kept short: it sits under an admin's own copy. */
export const FEATURE_REQUEST_PROMPT = "Something you want the platform to do?";

/** The button label. Matches the dashboard footer link, deliberately. */
export const FEATURE_REQUEST_LABEL = "Request a feature";
