/**
 * What a customer keeps when they stop paying — stated once.
 *
 * Pausing and cancelling both stop lead DELIVERY and nothing else. The database
 * side is free: the customer keeps logging in, keeps every lead already
 * delivered to them with its notes, files and stages, and keeps adding and
 * importing leads of their own. That is a genuine off-ramp, and it is worth
 * nothing if they only discover it after they have gone.
 *
 * So it is said in four places — the pause form, two steps of the cancel flow,
 * and both confirmation emails. Four surfaces stating one promise is four
 * chances for them to drift apart, and a retention promise that differs between
 * the screen and the email is worse than no promise at all. Hence one export,
 * the same discipline `cancelOptions.ts` uses for its reason list and
 * `announcements.ts` for its audience rule.
 *
 * ⚠️ These are shown to somebody who is LEAVING. Keep them factual. A bullet
 * that oversells is read as a reason to distrust the rest of the page.
 */

/**
 * The promise, as bullet points. Ordered so the last one is the limitation:
 * leading with what stops would bury the offer, and omitting it would make this
 * a sales pitch rather than an explanation.
 */
export const KEEP_CRM_POINTS: readonly string[] = [
  "You keep your login and everything already in your database.",
  "Every lead we have sent you stays, with its notes, files, stages and exports.",
  "You can carry on adding and importing your own leads, free and unlimited.",
  "The only thing that stops is new leads being allocated to you.",
] as const;

/** One-line version, for places with no room for a list. */
export const KEEP_CRM_SUMMARY =
  "You keep your database and your existing leads either way — only new lead allocation stops.";

/**
 * The same points as email HTML.
 *
 * Takes its own escaper rather than importing one, because `esc` in `emails.ts`
 * is private to that module and exporting it to serve one caller would widen a
 * surface that deliberately has no public escaping API. The points are
 * hard-coded strings in this file, so the escaping is belt-and-braces — but the
 * next person to edit them should not have to know that.
 */
export function keepCrmBulletsHtml(esc: (v: string) => string): string {
  return KEEP_CRM_POINTS.map(
    (point) => `<li>${esc(point)}</li>`
  ).join("\n      ");
}
