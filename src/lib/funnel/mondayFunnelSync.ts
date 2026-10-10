import type { SupabaseClient } from "@supabase/supabase-js";
import { enquiryBoardId, fetchEnquiryItem, setEnquirySignupSource, setEnquiryStatusById } from "@/lib/monday";
import {
  FUNNEL_FINISHED_AFTER_MS,
  FUNNEL_FINISHED_STEPS,
  FUNNEL_MONDAY_BATCH,
  FUNNEL_MONDAY_RETRY_AFTER_MS,
  FUNNEL_MONDAY_SCAN,
  FUNNEL_MONDAY_TRANSITIONS,
  FUNNEL_MONDAY_WINDOW_MS,
  claimBlocks,
  funnelLabelAlreadySet,
  funnelStatusLabelId,
  funnelTransitionDue,
  mayWriteFunnelLabel,
  signupRoute,
  signupSourceColumnId,
  signupSourceLabel,
  type FunnelMondayCandidate,
  type FunnelMondayClaim,
  type FunnelMondayOutcome,
  type FunnelMondayTransition,
  type SignupRoute,
} from "@/lib/funnel/mondayFunnel";

/**
 * The funnel's Monday writes (batch 03 Part A, Phase 2; CLAUDE.md §76). The
 * rules are in mondayFunnel.ts; this file does the reads and writes.
 *
 * ⚠️ NOTHING HERE THROWS. The two status passes run inside the funnel-discounts
 * cron, ahead of the discount pass, and the Sign-up source push runs inside the
 * Stripe webhook, whose outer catch deletes its stripe_events claim on a throw
 * (§23.6). Every failure becomes a result and a log line.
 */

type Env = Record<string, string | undefined>;

const CLAIMS = "funnel_monday_writes";
const DETAIL_MAX = 500;

export type FunnelMondayResult =
  /** Claimed and settled. */
  | { outcome: FunnelMondayOutcome; reason?: string }
  /** No claim taken: nothing to write with, or somebody else holds it. */
  | { outcome: "not_attempted"; reason: "not_configured" | "no_item" | "held" | "claim_failed" };

/* ------------------------------------------------------------------ *
 * The claim (E3)
 * ------------------------------------------------------------------ */

/**
 * Claim one (session, transition) by INSERT, the credit_invoice discipline: two
 * overlapping runs cannot both write. A collision means a claim exists; it is
 * taken over only when it FAILED or was left unsettled, and is at least an hour
 * old (claimBlocks). The take-over is a conditional update, so of two runs
 * reaching for the same stale claim exactly one gets it.
 */
export async function claimFunnelMondayWrite(
  admin: SupabaseClient,
  sessionId: string,
  transition: FunnelMondayTransition,
  now: Date
): Promise<"claimed" | "held" | "error"> {
  const claimedAt = now.toISOString();
  const inserted = await admin
    .from(CLAIMS)
    .insert({ session_id: sessionId, transition, claimed_at: claimedAt });
  if (!inserted.error) return "claimed";
  if (inserted.error.code !== "23505") {
    console.error("[funnel-monday] claim failed", sessionId, transition, inserted.error.message);
    return "error";
  }

  const retryBefore = new Date(now.getTime() - FUNNEL_MONDAY_RETRY_AFTER_MS).toISOString();
  for (const outcome of ["failed", null] as const) {
    let take = admin
      .from(CLAIMS)
      .update({ claimed_at: claimedAt, outcome: null, completed_at: null, detail: null })
      .eq("session_id", sessionId)
      .eq("transition", transition)
      .lt("claimed_at", retryBefore);
    take = outcome === null ? take.is("outcome", null) : take.eq("outcome", outcome);
    const { data, error } = await take.select("session_id");
    if (error) {
      console.error("[funnel-monday] reclaim failed", sessionId, transition, error.message);
      return "error";
    }
    if (data && data.length > 0) return "claimed";
  }
  return "held";
}

async function settleClaim(
  admin: SupabaseClient,
  sessionId: string,
  transition: FunnelMondayTransition,
  outcome: FunnelMondayOutcome,
  detail: string | null,
  now: Date
): Promise<void> {
  const { error } = await admin
    .from(CLAIMS)
    .update({ outcome, completed_at: now.toISOString(), detail: detail ? detail.slice(0, DETAIL_MAX) : null })
    .eq("session_id", sessionId)
    .eq("transition", transition)
    .is("outcome", null);
  if (error) console.error("[funnel-monday] could not settle the claim", sessionId, transition, error.message);
}

/* ------------------------------------------------------------------ *
 * One status write
 * ------------------------------------------------------------------ */

/**
 * Write one transition's status onto one session's board item, once.
 *
 * In order, and the order is the rule:
 *   1. configured? (the label id from env and a Monday token) — no claim if not;
 *   2. an item to write to? — no claim if not, so a session whose item arrives
 *      later is still picked up;
 *   3. CLAIM;
 *   4. read the cell, refuse another board, and apply the guard
 *      (mayWriteFunnelLabel): a protected status is settled `skipped`, never
 *      retried;
 *   5. write by label id, and settle.
 * A failed read or write settles `failed`, retried an hour later.
 */
export async function syncFunnelMondayStatus(
  admin: SupabaseClient,
  session: { id: string; monday_item_id: string | null },
  transition: FunnelMondayTransition,
  opts: { now?: Date; env?: Env } = {}
): Promise<FunnelMondayResult> {
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;

  const labelId = funnelStatusLabelId(transition, env);
  if (labelId === null || !env.MONDAY_API_TOKEN) return { outcome: "not_attempted", reason: "not_configured" };
  const itemId = session.monday_item_id;
  if (!itemId) return { outcome: "not_attempted", reason: "no_item" };

  const claim = await claimFunnelMondayWrite(admin, session.id, transition, now);
  if (claim === "held") return { outcome: "not_attempted", reason: "held" };
  if (claim === "error") return { outcome: "not_attempted", reason: "claim_failed" };

  const settle = async (outcome: FunnelMondayOutcome, detail: string | null): Promise<FunnelMondayResult> => {
    await settleClaim(admin, session.id, transition, outcome, detail, new Date());
    return detail ? { outcome, reason: detail } : { outcome };
  };

  try {
    const read = await fetchEnquiryItem(itemId);
    if (!read.ok) return await settle("failed", `read: ${read.error}`);
    if (!read.item) return await settle("skipped", "item_not_found");
    if (read.item.boardId !== enquiryBoardId()) return await settle("skipped", "not_status_board");

    const current = read.item.statusLabel;
    if (funnelLabelAlreadySet(transition, current)) return await settle("skipped", "unchanged");
    if (!mayWriteFunnelLabel(transition, current)) return await settle("skipped", `protected: ${current}`);

    const write = await setEnquiryStatusById({ itemId, labelId });
    if (write.written) return await settle("written", null);
    return await settle("failed", `write: ${write.error ?? write.skipped ?? "unknown"}`);
  } catch (err) {
    return await settle("failed", `threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/* ------------------------------------------------------------------ *
 * The cron passes (E3)
 * ------------------------------------------------------------------ */

export interface FunnelMondayPass {
  transition: FunnelMondayTransition;
  configured: boolean;
  due: number;
  attempted: number;
  written: number;
  skipped: number;
  failed: number;
  notAttempted: number;
  truncated: boolean;
  wouldWrite?: string[];
  error?: string;
}

export interface FunnelMondayRun {
  ok: boolean;
  dryRun: boolean;
  passes: FunnelMondayPass[];
}

const CANDIDATE_COLUMNS = "id, monday_item_id, step, updated_at, paid_at, first_answered_at";
const CLAIM_READ_SLICE = 100;

/** Monday writes stop starting after this, so the discount pass still has time. */
export const FUNNEL_MONDAY_BUDGET_MS = 25_000;

/**
 * The "started" and "finished" passes, run by /api/cron/funnel-discounts every
 * 15 minutes, BEFORE its discount pass (E3).
 *
 * ⚠️ WHY "started" IS WRITTEN HERE AND NOT IN THE ANSWERS ROUTE. The funnel
 * page waits on every answer save (FunnelFlow's `saveThen`), and a status write
 * is two Monday round trips with an 8-second timeout each, so writing it in
 * the save would hold a visitor's first answer up for as long as Monday takes.
 * Here the label lands within 15 minutes of the answer, well inside the
 * 3-hour chase (Part B step 3), and a failed write is retried an hour later.
 *
 * ⚠️ BEFORE THE DISCOUNT PASS, AND IT MUST STAY THERE. Both select on
 * funnel_sessions.updated_at, and linking a discount touches it (0165's touch
 * trigger), which would push "finished" back an hour. The claims are in their
 * own table, so a claim moves nothing (0166).
 */
export async function runFunnelMondayPasses(
  admin: SupabaseClient,
  opts: { now?: Date; dryRun?: boolean; env?: Env; budgetMs?: number } = {}
): Promise<FunnelMondayRun> {
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  const started = Date.now();
  const budget = opts.budgetMs ?? FUNNEL_MONDAY_BUDGET_MS;
  const run: FunnelMondayRun = { ok: true, dryRun: Boolean(opts.dryRun), passes: [] };

  for (const transition of FUNNEL_MONDAY_TRANSITIONS) {
    const pass: FunnelMondayPass = {
      transition,
      configured: funnelStatusLabelId(transition, env) !== null && Boolean(env.MONDAY_API_TOKEN),
      due: 0,
      attempted: 0,
      written: 0,
      skipped: 0,
      failed: 0,
      notAttempted: 0,
      truncated: false,
    };
    run.passes.push(pass);
    // Not configured: nothing to write with, so nothing is read or claimed. A
    // dry run still lists who is due, which is how Part B step 1 is checked.
    if (!pass.configured && !opts.dryRun) continue;

    const due = await dueSessions(admin, transition, now);
    if (!due.ok) {
      pass.error = due.error;
      run.ok = false;
      continue;
    }
    pass.due = due.sessions.length;
    if (opts.dryRun) {
      pass.wouldWrite = due.sessions.map((s) => s.id);
      continue;
    }

    for (const session of due.sessions) {
      if (Date.now() - started > budget) {
        pass.truncated = true;
        break;
      }
      const result = await syncFunnelMondayStatus(admin, session, transition, { now, env });
      if (result.outcome === "not_attempted") {
        pass.notAttempted += 1;
        continue;
      }
      pass.attempted += 1;
      pass[result.outcome] += 1;
      if (result.outcome === "failed") console.error("[funnel-monday] write failed", session.id, transition, result.reason);
    }
  }
  return run;
}

/**
 * The sessions a transition is due for, newest first, minus any whose claim
 * blocks another attempt, at most FUNNEL_MONDAY_BATCH of them.
 *
 * Newest first because the scan is capped: sessions already settled stay in the
 * one-week window, and oldest-first would let them fill the scan and hide new
 * ones. At the volumes the funnel sees (§55 measured about 15 enquiries a
 * month) the cap is never near.
 *
 * The claim filter is done here rather than in the query because PostgREST
 * cannot say "with no matching row in another table". The scan is bounded by
 * the one-week window and FUNNEL_MONDAY_SCAN, and the claims are read in one
 * `in` over the ids the scan returned.
 */
async function dueSessions(
  admin: SupabaseClient,
  transition: FunnelMondayTransition,
  now: Date
): Promise<{ ok: true; sessions: FunnelMondayCandidate[] } | { ok: false; error: string }> {
  const notBefore = new Date(now.getTime() - FUNNEL_MONDAY_WINDOW_MS).toISOString();
  let query = admin.from("funnel_sessions").select(CANDIDATE_COLUMNS).is("paid_at", null);
  if (transition === "started") {
    query = query.gt("first_answered_at", notBefore).order("first_answered_at", { ascending: false });
  } else {
    const quietSince = new Date(now.getTime() - FUNNEL_FINISHED_AFTER_MS).toISOString();
    query = query
      .in("step", [...FUNNEL_FINISHED_STEPS])
      .lt("updated_at", quietSince)
      .gt("updated_at", notBefore)
      .order("updated_at", { ascending: false });
  }
  const { data, error } = await query.limit(FUNNEL_MONDAY_SCAN);
  if (error) {
    console.error("[funnel-monday] session read failed", transition, error.message);
    return { ok: false, error: "sessions_unreadable" };
  }
  const due = ((data ?? []) as FunnelMondayCandidate[]).filter((s) => funnelTransitionDue(transition, s, now));
  if (due.length === 0) return { ok: true, sessions: [] };

  // In slices: every id rides in the request URL, and a few hundred uuids in
  // one `in` would pass PostgREST's URL limit.
  const bySession = new Map<string, FunnelMondayClaim>();
  for (let i = 0; i < due.length; i += CLAIM_READ_SLICE) {
    const claims = await admin
      .from(CLAIMS)
      .select("session_id, transition, claimed_at, outcome")
      .eq("transition", transition)
      .in("session_id", due.slice(i, i + CLAIM_READ_SLICE).map((s) => s.id));
    if (claims.error) {
      console.error("[funnel-monday] claim read failed", transition, claims.error.message);
      return { ok: false, error: "claims_unreadable" };
    }
    for (const c of (claims.data ?? []) as FunnelMondayClaim[]) bySession.set(c.session_id, c);
  }
  const open = due.filter((s) => !claimBlocks(bySession.get(s.id), now));
  return { ok: true, sessions: open.slice(0, FUNNEL_MONDAY_BATCH) };
}

/* ------------------------------------------------------------------ *
 * Sign-up source (E4)
 * ------------------------------------------------------------------ */

export interface SignupSourcePush {
  written: boolean;
  route?: SignupRoute;
  skipped?: "not_configured" | "no_item" | "not_status_board" | "unchanged";
  error?: string;
}

/**
 * Write "Call" or "Funnel" into the customer's Sign-up source cell. Called by
 * the Stripe webhook on a Management first paid invoice, after pushMondayStatus
 * has resolved and stored the customer's board item (§23.5).
 *
 * The route is signupRoute(): the customer's signup_source, with the paid
 * funnel session's entry_point turning a recap-page payer into `call` (E4). A
 * failed read of either refuses to write rather than guessing, so a blip never
 * labels somebody with the wrong route.
 *
 * NEVER THROWS.
 */
export async function pushSignupSource(
  admin: SupabaseClient,
  customerId: string,
  opts: { env?: Env } = {}
): Promise<SignupSourcePush> {
  try {
    const columnId = signupSourceColumnId(opts.env ?? process.env);
    if (!columnId) return { written: false, skipped: "not_configured" };

    const { data: customer, error } = await admin
      .from("customers")
      .select("signup_source, monday_item_id")
      .eq("id", customerId)
      .maybeSingle();
    if (error) return { written: false, error: `customer read: ${error.message}` };
    const row = customer as { signup_source: string | null; monday_item_id: string | null } | null;
    if (!row?.monday_item_id) return { written: false, skipped: "no_item" };

    let entryPoint: string | null = null;
    if (row.signup_source !== "call") {
      const paid = await admin
        .from("funnel_sessions")
        .select("entry_point")
        .eq("customer_id", customerId)
        .eq("step", "paid")
        .order("paid_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (paid.error) return { written: false, error: `session read: ${paid.error.message}` };
      entryPoint = (paid.data as { entry_point: string | null } | null)?.entry_point ?? null;
    }

    const route = signupRoute(row.signup_source, entryPoint);
    const write = await setEnquirySignupSource({ itemId: row.monday_item_id, columnId, label: signupSourceLabel(route) });
    if (write.written) return { written: true, route };
    if (write.skipped === "unchanged" || write.skipped === "not_status_board" || write.skipped === "not_configured") {
      return { written: false, route, skipped: write.skipped };
    }
    return { written: false, route, error: write.error ?? "unknown" };
  } catch (err) {
    return { written: false, error: `threw: ${err instanceof Error ? err.message : String(err)}` };
  }
}
