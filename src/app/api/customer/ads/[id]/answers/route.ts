import type { NextRequest } from "next/server";
import { AD_COPY } from "@/lib/ads/copy";
import { answersToProfile } from "@/lib/ads/profile";
import { answersComplete, collectAnswers } from "@/lib/ads/schemas";
import {
  adJson,
  adWriteSession,
  claimForGeneration,
  loadDraft,
  mergeAdProfile,
  releaseClaim,
  replaceQuestions,
} from "@/lib/ads/session";
import { DEFAULT_TEMPLATE_ID, templateById } from "@/lib/ads/templates";
import { writeAd } from "@/lib/ads/writeAd";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** The copy path spends 60 + 45 seconds and must still be alive to store it. */
export const maxDuration = 300;

/**
 * Send the answers and get the advert (§65).
 *
 * ⚠️ THE CLAIM COMES FIRST, AND IT IS A CONDITIONAL UPDATE RATHER THAN A CAP.
 * A double-tapped Send puts two requests in flight; both pass a TypeScript
 * `if`, and only the WHERE clause stops both paying for a generation and
 * racing to store a different advert into the same row.
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
  // plain text box. A hole here is a hole in the advert.
  if (!answersComplete(questions, answers)) {
    return adJson({ error: AD_COPY.chat.incomplete(answers.length, questions.length) }, 400);
  }

  const claim = await claimForGeneration(admin, customer.id, existing.id);
  if (!claim.ok) {
    return claim.reason === "gone"
      ? adJson({ error: "Not found" }, 404)
      : adJson({ error: AD_COPY.errors.busy, code: "busy" }, 409);
  }

  // ⚠️ MERGED IN SQL, BEFORE THE COPY IS WRITTEN. Two writers exist — this and
  // the profile form — so a read-modify-write loses whichever landed first,
  // and the edit most likely to be lost is the fee. `writeAd` re-reads the
  // customer afterwards, because the row this request was handed is now stale.
  const template = templateById(existing.template_id ?? DEFAULT_TEMPLATE_ID)!;
  const patch = answersToProfile(questions, answers, template);
  const merged = await mergeAdProfile(admin, customer.id, patch);
  if (!merged) {
    await releaseClaim(admin, existing.id, "collecting");
    return adJson({ error: AD_COPY.errors.generic }, 500);
  }

  // ⚠️ FILED BEFORE THE ADVERT IS WRITTEN, so a generation that fails does not
  // cost the operator five minutes of typing — and so Regenerate has something
  // to rewrite from. Best effort: losing the copy of an answer is a worse
  // Regenerate, where refusing the advert over it is a worse afternoon.
  const filed = questions.map((q) => ({
    ...q,
    answer: answers.find((a) => a.id === q.id)?.answer ?? q.answer,
  }));
  await replaceQuestions(admin, existing.id, existing.questions_version, filed);

  const result = await writeAd({
    admin,
    customerId: customer.id,
    draft: claim.draft,
    answers,
  });

  if (!result.ok) {
    return result.reason === "unresolved"
      ? adJson(
          {
            error: `Before I can write this I still need ${result.labels.join(", ")}.`,
            code: "unresolved",
            missing: result.missing,
          },
          400
        )
      : adJson({ error: AD_COPY.errors.generic }, 500);
  }

  return adJson({ status: "ready", copy: result.copy, degraded: result.degraded });
}
