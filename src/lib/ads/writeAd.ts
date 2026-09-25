import type { SupabaseClient } from "@supabase/supabase-js";
import type { Customer } from "@/lib/types";
import { adContext, preflight } from "./context";
import { generateCopy, type CopyFailure } from "./generate";
import { PROMPT_VERSIONS } from "./prompts";
import { recordGenerations } from "./ledger";
import { failDraft, finishDraft, releaseClaim, type AdDraftRow } from "./session";
import { templateById, DEFAULT_TEMPLATE_ID } from "./templates";
import type { Answer } from "./schemas";

/**
 * Writing the ad, shared verbatim by the answers route and Regenerate
 * (§65) — the extraction `releaseLeads.ts` and `dueAttempts.ts` already make.
 *
 * Six things happen here and every one of them can go wrong on its own, which
 * is why they are in one place rather than in two routes that drift:
 * re-resolve, refuse an unrenderable template, generate, validate (inside
 * `generateCopy`), store, and record what it cost.
 */

export type WriteOutcome =
  | { ok: true; copy: AdDraftRow["copy"] }
  | { ok: false; reason: "unresolved"; missing: string[]; labels: string[] }
  /** The model was not reachable, refused twice, or is not configured here. */
  | { ok: false; reason: "not_written"; failure: CopyFailure }
  | { ok: false; reason: "not_stored" };

/**
 * ⚠️ THE CUSTOMER IS RE-READ BEFORE THE CONTEXT IS BUILT. The answers route
 * has just merged a patch into `ad_profile` with SQL `||`, so the row it was
 * handed at the top of the request is already stale — and the stale copy is
 * missing exactly the answers the operator gave for this ad. An ad
 * written from it would ignore everything they just typed.
 */
export async function writeAd(params: {
  admin: SupabaseClient;
  customerId: string;
  draft: AdDraftRow;
  answers: Answer[];
  previousMessage?: string | null;
}): Promise<WriteOutcome> {
  const { admin, customerId, draft } = params;

  const { data: fresh } = await admin
    .from("customers")
    .select("*")
    .eq("id", customerId)
    .maybeSingle();
  const customer = (fresh ?? null) as Customer | null;
  if (!customer) {
    await failDraft(admin, draft.id, "customer_missing");
    return { ok: false, reason: "not_stored" };
  }

  const template = templateById(draft.template_id ?? DEFAULT_TEMPLATE_ID)!;
  const context = adContext(customer, template);

  // ⚠️ THE SECOND STOP, AND THE ONLY STOP FOR REGENERATE. The answers route
  // pre-flights before it claims, so an operator never burns a generation slot
  // to be told what is missing — but it re-reads the customer here, so a
  // profile edited between that check and this one is caught, and
  // `regenerate/route.ts` never passes through the first check at all.
  //
  // A template whose headline cannot be filled cannot render: returning the
  // half-filled string would put "Landlords in : 8 years" on an ad, so the
  // draft goes back to collecting and the chat asks for what is missing rather
  // than paying for copy that has nowhere to sit.
  const check = preflight(context);
  if (!check.ok) {
    await releaseClaim(admin, draft.id, "collecting");
    return { ok: false, reason: "unresolved", missing: check.missing, labels: check.labels };
  }

  const result = await generateCopy({
    ctx: context.ctx,
    account: context.brief,
    answers: params.answers,
    cta: context.cta,
    figures: context.figures,
    previousMessage: params.previousMessage ?? null,
  });

  // ⚠️ THE LEDGER IS WRITTEN WHETHER OR NOT THERE IS AN AD, AND BEFORE THE
  // BRANCH. A generation that cost two model calls and produced nothing is
  // exactly the run somebody will come looking for, and it used to be recorded
  // only on the path that stored copy.
  await recordGenerations(admin, {
    customerId,
    draftId: draft.id,
    entries: result.entries,
  });

  if (!result.ok) {
    // ⚠️ RELEASED TO `collecting`, NOT FAILED, AND NOT STORED. §65: if the
    // model did not write it, it is not an ad. The draft keeps its questions
    // and its answers, so Retry costs the operator nothing but the wait — and
    // `finishDraft` is never reached, so no row can carry a `model_id` beside
    // words a model never produced.
    await releaseClaim(admin, draft.id, "collecting");
    return { ok: false, reason: "not_written", failure: result.reason };
  }

  const stored = await finishDraft(admin, draft.id, {
    copy: result.copy,
    slots: context.resolution.slots,
    // ⚠️ ONLY EVER A MODEL THAT ACTUALLY ANSWERED. `result.ok` now guarantees
    // at least one variant the model wrote, so this can no longer stamp a model
    // id onto the template's own text — which is what the record did on the run
    // the owner judged.
    modelId: result.entries.find((e) => e.modelId)?.modelId ?? null,
    promptVersion: PROMPT_VERSIONS.copy,
  });

  if (!stored) {
    // ⚠️ NEVER LEAVE IT IN `generating`. A draft stuck there is only
    // reclaimable after the stale window, so the operator watches a spinner
    // for six minutes before they can try again.
    await failDraft(admin, draft.id, "not_stored");
    return { ok: false, reason: "not_stored" };
  }

  return { ok: true, copy: result.copy };
}
