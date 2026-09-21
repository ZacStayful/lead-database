import type { NextRequest } from "next/server";
import { adContext, preflight } from "@/lib/ads/context";
import { AD_COPY } from "@/lib/ads/copy";
import { answersToProfile, mappingSentences } from "@/lib/ads/profile";
import { answersComplete, collectAnswers } from "@/lib/ads/schemas";
import {
  adJson,
  adWriteSession,
  claimForGeneration,
  loadDraft,
  mergeAdProfile,
  replaceQuestions,
} from "@/lib/ads/session";
import { DEFAULT_TEMPLATE_ID, templateById } from "@/lib/ads/templates";
import { writeAd } from "@/lib/ads/writeAd";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** The copy path spends 60 + 45 seconds and must still be alive to store it. */
export const maxDuration = 300;

/**
 * Send the answers and get the ad (§65).
 *
 * ⚠️ THE ORDER IS THE POINT, AND IT IS NOT THE ORDER THIS ROUTE SHIPPED WITH.
 * It used to claim the draft, merge the profile, and only then let `writeAd`
 * discover the gap, refuse, and release the claim it had just taken — so an
 * operator burned a generation slot to be told what was missing. The check is
 * pure and free; the thing it guards is neither.
 *
 *   collect → complete? → coerce → merge → file the answers → PREFLIGHT →
 *   claim → write
 *
 * ⚠️ THE MERGE STAYS ABOVE THE PREFLIGHT. The answers being submitted are
 * usually exactly what fills the gap, so checking first would refuse a run for
 * a value arriving in the same request.
 *
 * ⚠️ AND THE ANSWERS ARE FILED ABOVE IT TOO. A refusal must never cost the
 * operator their typing; that is the whole complaint this feature was reported
 * with.
 *
 * ⚠️ THE CLAIM IS STILL A CONDITIONAL UPDATE RATHER THAN A CAP. A double-tapped
 * Send puts two requests in flight; both pass a TypeScript `if`, and only the
 * WHERE clause stops both paying for a generation and racing to store a
 * different ad into the same row.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const gate = await adWriteSession();
  if (!gate.ok) return gate.response;
  const { admin, customer } = gate.session;

  const existing = await loadDraft(admin, customer.id, params.id);
  if (!existing) return adJson({ error: "Not found" }, 404);

  let body: { answers?: unknown };
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const questions = existing.questions ?? [];
  const answers = collectAnswers(questions, body.answers);
  // ⚠️ NO SKIP CONTROL, which is fair only because the ladder terminates in a
  // plain text box. A hole here is a hole in the ad.
  if (!answersComplete(questions, answers)) {
    return adJson({ error: AD_COPY.chat.incomplete(answers.length, questions.length) }, 400);
  }

  const template = templateById(existing.template_id ?? DEFAULT_TEMPLATE_ID)!;
  const mapping = answersToProfile(questions, answers, template);
  // ⚠️ THE REFUSALS TRAVEL WITH THE RESPONSE. Three of the five answers on the
  // first real run wrote nothing and said nothing, and the operator was then
  // refused for a value they believed they had given. Whatever we could not
  // read is now said out loud, whether the write goes on to succeed or not.
  const said = mappingSentences(mapping);

  // ⚠️ MERGED IN SQL, NEVER READ-MODIFY-WRITE. Two writers exist — this and the
  // profile form — so a read-modify-write loses whichever landed first, and the
  // edit most likely to be lost is the fee.
  const merged = await mergeAdProfile(admin, customer.id, mapping.patch);
  if (!merged.ok) return adJson({ error: AD_COPY.errors.generic }, 500);

  // ⚠️ FILED BEFORE ANYTHING CAN REFUSE, so neither a missing slot nor a failed
  // generation costs the operator five minutes of typing — and so Regenerate
  // has something to rewrite from. Best effort: losing the copy of an answer is
  // a worse Regenerate, where refusing the ad over it is a worse afternoon.
  const filed = questions.map((q) => ({
    ...q,
    answer: answers.find((a) => a.id === q.id)?.answer ?? q.answer,
  }));
  await replaceQuestions(admin, existing.id, existing.questions_version, filed);

  // ⚠️ AGAINST THE POST-MERGE PROFILE, WHICH THE RPC HANDED BACK. Re-reading the
  // customer to learn what we just wrote is a wasted round trip and a second
  // source of truth; a null profile means there was nothing to merge, so the
  // row in hand is already current. `ad_profile` is the only column touched.
  const after = merged.profile ? { ...customer, ad_profile: merged.profile } : customer;
  const check = preflight(adContext(after, template));
  if (!check.ok) {
    return adJson(
      {
        // The refusal comes FIRST: "I couldn't read that as a web address"
        // explains the missing field, where naming the field alone reads as us
        // asking for something that was already provided.
        error: [...said, AD_COPY.errors.unresolved(check.labels)].join(" "),
        code: "unresolved",
        missing: check.missing,
        refused: mapping.refusals,
        warnings: check.warnings,
      },
      400
    );
  }

  const claim = await claimForGeneration(admin, customer.id, existing.id);
  if (!claim.ok) {
    return claim.reason === "gone"
      ? adJson({ error: "Not found" }, 404)
      : adJson({ error: AD_COPY.errors.busy, code: "busy" }, 409);
  }

  const result = await writeAd({
    admin,
    customerId: customer.id,
    draft: claim.draft,
    answers,
  });

  if (!result.ok) {
    // ⚠️ `writeAd` KEEPS ITS OWN COPY OF THE CHECK and can still land here — it
    // re-reads the customer, so a concurrent profile edit between the preflight
    // and the claim is caught there. It is also the only stop for Regenerate,
    // which never passes through this route.
    return result.reason === "unresolved"
      ? adJson(
          {
            error: [...said, AD_COPY.errors.unresolved(result.labels)].join(" "),
            code: "unresolved",
            missing: result.missing,
            refused: mapping.refusals,
          },
          400
        )
      : adJson({ error: AD_COPY.errors.generic }, 500);
  }

  return adJson({
    status: "ready",
    copy: result.copy,
    degraded: result.degraded,
    refused: mapping.refusals,
    notes: mapping.notes,
  });
}
