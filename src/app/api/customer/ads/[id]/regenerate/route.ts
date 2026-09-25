import { AD_COPY } from "@/lib/ads/copy";
import { collectAnswers } from "@/lib/ads/schemas";
import { adJson, adWriteSession, claimForGeneration, loadDraft, releaseClaim, spendBudget } from "@/lib/ads/session";
import { writeAd } from "@/lib/ads/writeAd";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * "Rewrite the words" (§65) — same answers, a different angle.
 *
 * ⚠️ IT PASSES THE PREVIOUS MESSAGE BACK. Without it the model rewrites the
 * same argument with different adjectives, which reads as the button not
 * working. The alternative shape — having the model NAME which of the five
 * angles it used, and asking for a different one — was dropped: a
 * self-reported label can be wrong, and the previous message cannot.
 */
export async function POST(_request: Request, { params }: { params: { id: string } }) {
  const gate = await adWriteSession();
  if (!gate.ok) return gate.response;
  const { admin, customer } = gate.session;

  const existing = await loadDraft(admin, customer.id, params.id);
  if (!existing) return adJson({ error: "Not found" }, 404);

  // The answers were filed against their questions when they were sent, so a
  // rewrite re-reads them rather than asking again.
  const answers = collectAnswers(
    existing.questions ?? [],
    (existing.questions ?? []).map((q) => ({ id: q.id, answer: q.answer ?? "" }))
  );

  const spent = await spendBudget(admin, customer.id, existing.id, "regenerate");
  if (spent === null) {
    return adJson({ error: AD_COPY.errors.regenerations, code: "regenerate_cap" }, 429);
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
    // The recommended variant is the one they are looking at, so it is the one
    // a rewrite has to differ from.
    previousMessage: existing.copy?.variants?.[0]?.message ?? null,
  });

  if (!result.ok) {
    if (result.reason === "unresolved") {
      return adJson(
        {
          error: AD_COPY.errors.unresolved(result.labels),
          code: "unresolved",
          missing: result.missing,
        },
        400
      );
    }
    if (result.reason === "not_written") {
      // ⚠️ `writeAd` HAS ALREADY RELEASED IT TO `collecting`, and it must not
      // be failed on top of that. The previous ad is still in the row: a
      // rewrite that could not reach the model leaves the operator exactly
      // where they were, with a sentence saying so.
      return adJson({
        status: "collecting",
        error: AD_COPY.errors.notWritten[result.failure] ?? AD_COPY.errors.generic,
        code: "not_written",
        regenerations_used: spent,
      });
    }
    await releaseClaim(admin, existing.id, "failed");
    return adJson({ error: AD_COPY.errors.generic }, 500);
  }

  return adJson({ status: "ready", copy: result.copy, regenerations_used: spent });
}
