/**
 * The confirm-on-login screen (batch 04 Phase 3), word for word from the
 * batch where it gives words. IMPORT-FREE, because the client component reads
 * it. Held to the A9 list by briefCopy.test.ts.
 *
 * Two kinds of screen, one copy module:
 *   - a RETURN from a long pause, recalculated 7 days before the return date
 *     (locked decision 3). The customer is held, paused, until they confirm
 *     (C4).
 *   - a monthly WIDENING (additions A10, Lead Brief Phase 6, not built yet).
 *     Leads keep coming on the current area meanwhile (C4), so the button
 *     never promises to start them.
 */

/**
 * The confirm-on-login screen's path, outside /dashboard like /onboarding/brief
 * (the dashboard layout is what sends a customer there). Here rather than in
 * gate.ts so the pause card, a client component, can link to it.
 */
export const AREA_CONFIRM_PATH = "/onboarding/area";

export const AREA_CONFIRM_COPY = {
  wideningTitle: "Your coverage area has been updated",
  intro:
    "We've recalibrated your coverage area from live supply, so your leads match your brief as closely as possible.",
  areaLabel: "Your area:",
  sameLabel: "What stays the same:",
  same: "your brief, your priorities and must-haves, and every credit you're owed.",
  labelsLabel: "What your labels mean now:",
  labels:
    "“Top match” and “First pick” are measured against this area. A Top match is still a lead that meets everything in your brief, inside your coverage area.",
  tighterLabel: "Want a tighter area?",

  // The three buttons. "Confirm and start my leads" only when confirming does
  // start them: a return whose date has come. Before the date the leads start
  // on the date the customer chose (the area-updated email says so), and a
  // widening never stopped them.
  confirmStart: "Confirm and start my leads",
  confirmArea: "Confirm my area",
  switchTo10: "Switch to 10 leads",
  extend: "Extend my pause",

  working: "Saving",
  switching: "Changing your plan",

  mapLabel: "Map of your coverage area",
  mapKeyNew: "Your new area",
  mapKeyOld: "Your previous area",

  // After confirming.
  confirmedStarted: "Your area is confirmed and your leads have restarted.",
  confirmedWidening: "Your area is confirmed. Your next leads come from it.",
  continue: "Go to my leads",

  // Restarting failed at the payment provider after the area was confirmed.
  // The resume cron finishes it on its next run (the area is settled), so
  // there is nothing for the customer to do.
  restartPending:
    "Your area is confirmed. We couldn't restart billing with our payment provider just now, so your leads will restart automatically within a day.",
  restartBlocked:
    "Your area is confirmed. Your subscription is scheduled to cancel, so your leads won't restart. Choose “Keep my subscription” in Settings if you'd like them to.",

  // Switch to 10 leads (C5): the plan route refuses a paused customer, so the
  // screen confirms first, which restarts the leads, then switches.
  switchRestartsToday: "Switching restarts your leads today, so your plan can be changed.",
  switchFailed:
    "Your area is confirmed. We couldn't change your plan just now: you can switch to 10 leads from Settings.",

  // Extend my pause.
  extendTitle: "Extend your pause",
  extendLabel: "When would you like your leads to restart?",
  extendSave: "Extend my pause",
  extendBack: "Back",
  extendRecalculated:
    "Your coverage area is recalculated from live supply again before you return.",

  errorConflict: "Your area changed while this page was open. Please reload it.",
  reload: "Reload",
  errorGeneric: "We couldn't save that just now. Nothing has changed. Please try again in a moment.",

  // An admin viewing the customer (§62).
  readOnlyTitle: "Their coverage area is waiting to be confirmed",
  readOnlyBody:
    "The customer sees this screen when they sign in. Every change is refused while you are viewing their account.",
} as const;

/** "Welcome back, Lin" — the first line for a return. */
export function welcomeBack(firstName: string): string {
  return `Welcome back, ${firstName}`;
}

/** "within 30 miles of YO10 5DD (previously 20 miles)" */
export function areaChangeLine(args: {
  radiusMiles: number;
  basePostcode: string;
  otherAreas: number;
  previousRadiusMiles: number;
}): string {
  const where =
    args.otherAreas > 0 ? `${args.basePostcode} and your other areas` : args.basePostcode;
  return `within ${args.radiusMiles} miles of ${where} (previously ${args.previousRadiusMiles} miles)`;
}

/** "Switching to 10 leads a month brings it to 18 miles." */
export function tighterLine(miles: number): string {
  return `Switching to 10 leads a month brings it to ${miles} miles.`;
}

/** Before the return date: when confirming will see the leads restart. */
export function restartsOnLine(dateLabel: string): string {
  return `Your leads restart on ${dateLabel}, as you planned.`;
}

/** After extending. */
export function extendedLine(dateLabel: string): string {
  return `Your pause now ends on ${dateLabel}.`;
}

/** After "Switch to 10 leads": the plan and the tighter area start together. */
export function switchedLine(dateLabel: string | null, miles: number | null): string {
  const when = dateLabel ? `on ${dateLabel}` : "at your next renewal";
  return miles !== null
    ? `Done. You'll move to 10 leads a month ${when}, and your area moves to within ${miles} miles then.`
    : `Done. You'll move to 10 leads a month ${when}.`;
}

/** The extend refusals, worded for the customer. */
export const EXTEND_MESSAGES = {
  invalid: "Please choose the date you'd like your leads to restart.",
  not_later: "Please choose a date after your current return date.",
  too_soon: "Please choose a date from tomorrow onwards.",
  too_late: "A pause can last up to 3 months. Please choose an earlier date.",
  not_extendable: "Your pause can't be extended from here. Please contact support.",
} as const;
