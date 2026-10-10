import { ENQUIRY_FUNNEL_STATUS, ENQUIRY_SIGNUP_SOURCE, mayWriteChaseLabel } from "@/lib/monday";

/**
 * The funnel's Monday rules (batch 03 Part A, Phase 2; CLAUDE.md §76). Pure:
 * no reads and no writes, so every rule here is a unit under vitest.config.mts.
 * The I/O is in mondayFunnelSync.ts.
 *
 * Three writes, all to board 18420649520:
 *
 *   started   Status → "Funnel started" once the first answer is saved
 *   finished  Status → "Funnel finished, not paid" once a previewed session
 *             has been quiet for an hour without paying
 *   sign-up   Sign-up source → "Call" / "Funnel" on a first paid invoice
 *
 * The two status writes are claimed once each in funnel_monday_writes (0166,
 * E3), so each lands at most once per session.
 */

/** Mirrors 0166's funnel_monday_writes_transition CHECK; a test holds them equal. */
export const FUNNEL_MONDAY_TRANSITIONS = ["started", "finished"] as const;
export type FunnelMondayTransition = (typeof FUNNEL_MONDAY_TRANSITIONS)[number];

/** Mirrors 0166's funnel_monday_writes_outcome CHECK. */
export const FUNNEL_MONDAY_OUTCOMES = ["written", "skipped", "failed"] as const;
export type FunnelMondayOutcome = (typeof FUNNEL_MONDAY_OUTCOMES)[number];

/** The env vars Part B step 1's ids go in (batch doc, Phase 1 locked items 1–2). */
export const FUNNEL_STATUS_ENV = {
  started: "MONDAY_STATUS_FUNNEL_STARTED",
  finished: "MONDAY_STATUS_FUNNEL_FINISHED",
} as const satisfies Record<FunnelMondayTransition, string>;
export const SIGNUP_SOURCE_COLUMN_ENV = "MONDAY_SIGNUP_SOURCE_COLUMN_ID";

type Env = Record<string, string | undefined>;

/**
 * A transition's label id, from env (E10). Null when the variable is missing,
 * empty or not a whole number, which the caller reports as `not_configured`.
 * ⚠️ NEVER A FALLBACK TO TEXT: a label written by a guessed name is the trap
 * §23.1 records, and the locked decision is ids from env.
 */
export function funnelStatusLabelId(transition: FunnelMondayTransition, env: Env): number | null {
  const raw = (env[FUNNEL_STATUS_ENV[transition]] ?? "").trim();
  return /^[0-9]{1,9}$/.test(raw) ? Number(raw) : null;
}

/**
 * The Sign-up source column's id, from env. A Monday column id is lower-case
 * letters, digits and underscores; anything else is not configured rather than
 * interpolated into a query.
 */
export function signupSourceColumnId(env: Env): string | null {
  const raw = (env[SIGNUP_SOURCE_COLUMN_ENV] ?? "").trim();
  return /^[a-z][a-z0-9_]{0,63}$/.test(raw) ? raw : null;
}

/** The label a transition writes, as the cell reads it back. */
export function funnelLabelText(transition: FunnelMondayTransition): string {
  return ENQUIRY_FUNNEL_STATUS[transition];
}

/** The cell already says what this transition would write. */
export function funnelLabelAlreadySet(transition: FunnelMondayTransition, current: string | null | undefined): boolean {
  return (current ?? "").trim() === funnelLabelText(transition);
}

/**
 * ⚠️ MAY THE FUNNEL WRITE OVER WHAT IS IN THE STATUS CELL NOW?
 *
 * An allow-list, built on mayWriteChaseLabel: an empty cell, "New Enquiries",
 * "Chasing to book" or "Chased no booking" (batch doc Phase 2). Everything
 * else means a person, the chase or a customer state has said something about
 * this enquirer, and the funnel stays quiet. Because it is an allow-list it
 * refuses every label the doc names as protected ("Web meeting booked", "Web
 * meeting sat", any customer, paused, cancelling or cancelled status) without
 * naming them, and any label added to the board later too.
 *
 * E2: "finished" also allows "Funnel started", or it could never follow the
 * first write. "started" does not allow "finished": a later backstop must not
 * walk a session back.
 */
export function mayWriteFunnelLabel(transition: FunnelMondayTransition, current: string | null | undefined): boolean {
  if (mayWriteChaseLabel(current)) return true;
  if (transition === "finished") return (current ?? "").trim() === ENQUIRY_FUNNEL_STATUS.started;
  return false;
}

/* ------------------------------------------------------------------ *
 * Who is due
 * ------------------------------------------------------------------ */

/**
 * The "finished" selector is the funnel discount's (E3): a session at
 * `previewed` or `checkout_started`, unpaid, quiet for at least an hour and no
 * more than a week. A test holds these equal to discount.ts's constants. Unlike
 * the discount it does not care whether a code is linked: a session holding a
 * code has still finished without paying.
 */
export const FUNNEL_FINISHED_STEPS = ["previewed", "checkout_started"] as const;
export const FUNNEL_FINISHED_AFTER_MS = 60 * 60 * 1000;
export const FUNNEL_MONDAY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** A failed or abandoned claim is tried again once it is this old. */
export const FUNNEL_MONDAY_RETRY_AFTER_MS = 60 * 60 * 1000;

/** Writes per transition per run, and how many candidates one run reads. */
export const FUNNEL_MONDAY_BATCH = 25;
export const FUNNEL_MONDAY_SCAN = 500;

export interface FunnelMondayCandidate {
  id: string;
  monday_item_id: string | null;
  step: string;
  updated_at: string;
  paid_at: string | null;
  first_answered_at: string | null;
}

function within(ms: number): boolean {
  return ms >= 0 && ms <= FUNNEL_MONDAY_WINDOW_MS;
}

/** Answered, unpaid, on a board item, and answered within the last week. */
export function funnelStartedDue(s: FunnelMondayCandidate, now: Date): boolean {
  if (s.paid_at || s.step === "paid" || !s.monday_item_id || !s.first_answered_at) return false;
  return within(now.getTime() - new Date(s.first_answered_at).getTime());
}

/** Previewed, unpaid, on a board item, and quiet for between an hour and a week. */
export function funnelFinishedDue(s: FunnelMondayCandidate, now: Date): boolean {
  if (s.paid_at || !s.monday_item_id) return false;
  if (!(FUNNEL_FINISHED_STEPS as readonly string[]).includes(s.step)) return false;
  const idle = now.getTime() - new Date(s.updated_at).getTime();
  return idle >= FUNNEL_FINISHED_AFTER_MS && within(idle);
}

export function funnelTransitionDue(transition: FunnelMondayTransition, s: FunnelMondayCandidate, now: Date): boolean {
  return transition === "started" ? funnelStartedDue(s, now) : funnelFinishedDue(s, now);
}

export interface FunnelMondayClaim {
  session_id: string;
  transition: string;
  claimed_at: string;
  outcome: string | null;
}

/**
 * Whether an existing claim stops another attempt. A settled `written` or
 * `skipped` always does: that is "writes once". A `failed` claim, or one left
 * unsettled by a run that died, stops it only until it is an hour old, then
 * the write is tried again (the failure was Monday's or ours, never a decision
 * about the item).
 */
export function claimBlocks(claim: FunnelMondayClaim | undefined, now: Date): boolean {
  if (!claim) return false;
  if (claim.outcome === "written" || claim.outcome === "skipped") return true;
  return now.getTime() - new Date(claim.claimed_at).getTime() < FUNNEL_MONDAY_RETRY_AFTER_MS;
}

/* ------------------------------------------------------------------ *
 * Sign-up source (E4)
 * ------------------------------------------------------------------ */

export type SignupRoute = "call" | "funnel";

/**
 * Which route a paying customer came by, for the Monday cell and the Phase 4
 * report (E4). `customers.signup_source` stays as batch 02 defined it (§75.8);
 * this reads it together with the paid session:
 *
 *   call    signup_source = 'call', OR the paid session's entry_point is
 *           'post_call' (they sat a call and paid on the recap page)
 *   funnel  otherwise
 */
export function signupRoute(signupSource: string | null | undefined, paidEntryPoint: string | null | undefined): SignupRoute {
  if (signupSource === "call" || paidEntryPoint === "post_call") return "call";
  return "funnel";
}

export function signupSourceLabel(route: SignupRoute) {
  return ENQUIRY_SIGNUP_SOURCE[route];
}
