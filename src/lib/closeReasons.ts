/**
 * The outcomes an operator can report when closing a lead they have worked.
 *
 * Kept in lib rather than beside the route because a Next.js route file may
 * only export route handlers and config — exporting the constants from there
 * fails the build's route-type check. The UI and the route both read them from
 * here, so the list and its copy cannot drift apart.
 *
 * Both reasons describe the LANDLORD, not the operator: they are the two ways a
 * landlord is finished, which is why closing withdraws the lead from everyone
 * rather than just passing it on. "Not for me" is not on this list — that is
 * what reject is for.
 *
 * Wrong or unusable contact details are deliberately absent: those go to the
 * support desk because they can earn a credit, and keeping every refundable
 * case off this list is what stops closing being worth misreporting.
 */
export const CLOSE_REASONS = {
  not_interested: "Not actually interested",
  sorted_elsewhere: "Already sorted with someone else",
} as const;

export type CloseReason = keyof typeof CLOSE_REASONS;

/** Narrow untrusted input to a valid close reason. */
export function isCloseReason(value: unknown): value is CloseReason {
  return typeof value === "string" && value in CLOSE_REASONS;
}
