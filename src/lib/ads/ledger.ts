import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * `ad_generation_requests` — one row per model call (§65).
 *
 * It does two jobs that look unrelated and are not:
 *
 *   1. ⚠️ IT IS THE DRAFT CAP. Counted here rather than on `ad_drafts`,
 *      because a customer may delete a draft and a cap counted on a deletable
 *      table is a cap that resets itself. `draft_id` therefore carries no
 *      foreign key at all.
 *   2. It is the only thing that can answer what this demo exists to answer:
 *      which guardrail refuses what, how often the single retry rescues it,
 *      how often we publish the template's own words, and whether the prompt
 *      cache is hit in practice.
 *
 * ⚠️ NOTHING HERE STORES A PROMPT OR A COMPLETION. `reject_reason` is one of
 * our own bounded codes; the model's own sentence never reaches this table and
 * the operator's business never reaches this table.
 */

export type GenerationKind = "questions" | "simplify" | "template" | "copy";
export type GenerationOutcome = "ok" | "rejected" | "error";

export type LedgerEntry = {
  kind: GenerationKind;
  outcome: GenerationOutcome;
  attempt: number;
  modelId: string | null;
  promptVersion: string | null;
  /** A bounded code — one of `AdRejection`, or `not_configured`/`call_failed`/`unparseable`. */
  rejectReason: string | null;
  /**
   * ⚠️ ZERO IS A READING, NOT AN ABSENCE. A cache MISS reports zero, which is
   * exactly the number that would tell us the five-minute window is not being
   * hit; null is the provider saying nothing. Collapsing them loses the
   * finding.
   */
  cacheReadTokens: number | null;
};

/** How many drafts a customer may start in a rolling day. */
export const DRAFT_CAP_PER_DAY = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

/** `attempt` is CHECKed `between 1 and 5`; a 23514 here would lose the row. */
const MAX_ATTEMPT = 5;
const MAX_REASON = 200;

/**
 * Write what a generation cost.
 *
 * ⚠️ IT NEVER THROWS AND NEVER FAILS THE REQUEST. A lost ledger row is a
 * reporting gap; a failed advert is the operator's afternoon. Same discipline
 * `subscription_plan_changes` states for its own audit trail (§24) — live
 * state is elsewhere, and the history is best-effort beside it.
 *
 * ⚠️ THE ONE THING IT CANNOT SKIP IS THE `questions` ROW, because the draft
 * cap counts these. A silent failure there hands somebody an unbounded number
 * of drafts — which is the argument for logging loudly rather than for making
 * this throw, since throwing would hand them a failed advert instead.
 */
export async function recordGenerations(
  admin: SupabaseClient,
  params: { customerId: string; draftId: string | null; entries: LedgerEntry[] }
): Promise<void> {
  if (!params.entries.length) return;
  const rows = params.entries.map((e) => ({
    customer_id: params.customerId,
    draft_id: params.draftId,
    kind: e.kind,
    outcome: e.outcome,
    attempt: Math.min(Math.max(Math.round(e.attempt) || 1, 1), MAX_ATTEMPT),
    model_id: e.modelId,
    prompt_version: e.promptVersion,
    reject_reason: e.rejectReason ? e.rejectReason.slice(0, MAX_REASON) : null,
    cache_read_tokens:
      typeof e.cacheReadTokens === "number" && Number.isFinite(e.cacheReadTokens)
        ? Math.max(0, Math.round(e.cacheReadTokens))
        : null,
  }));
  const { error } = await admin.from("ad_generation_requests").insert(rows);
  if (error) {
    // Never the rows themselves — they carry no business content, but the
    // habit of logging a payload is how one eventually does.
    console.error("ads/ledger: could not record generations", error.message);
  }
}

/**
 * How many drafts this customer has started in the last 24 hours.
 *
 * ⚠️ COUNTS `kind = 'questions'` ONLY. A draft is started by exactly one
 * questions call, so that is the count of drafts. Counting every row would
 * charge a customer for their own simplifications and for our automatic
 * retry — so somebody who could not understand a question and asked twice
 * would get fewer adverts than somebody who understood them first time, which
 * is precisely backwards.
 *
 * ⚠️ AND IT FAILS CLOSED. An unreadable ledger is not permission: the whole
 * point of counting an append-only table is that it cannot be reset, and
 * reading an error as zero hands out an unbounded number of adverts at the one
 * moment we cannot see how many have been handed out already.
 */
export async function draftsStartedToday(
  admin: SupabaseClient,
  customerId: string
): Promise<{ ok: true; count: number } | { ok: false }> {
  const since = new Date(Date.now() - DAY_MS).toISOString();
  const { count, error } = await admin
    .from("ad_generation_requests")
    .select("id", { count: "exact", head: true })
    .eq("customer_id", customerId)
    .eq("kind", "questions")
    .gte("created_at", since);
  if (error) {
    console.error("ads/ledger: draft cap read failed, refusing", error.message);
    return { ok: false };
  }
  return { ok: true, count: count ?? 0 };
}

export function draftCapReached(count: number): boolean {
  return count >= DRAFT_CAP_PER_DAY;
}
