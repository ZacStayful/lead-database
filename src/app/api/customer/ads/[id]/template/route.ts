import type { NextRequest } from "next/server";
import { AD_COPY } from "@/lib/ads/copy";
import { adContext } from "@/lib/ads/context";
import { fallbackQuestionnaire } from "@/lib/ads/fallback";
import { generateQuestions } from "@/lib/ads/generate";
import { recordGenerations } from "@/lib/ads/ledger";
import { adJson, adWriteSession, loadDraft, spendBudget } from "@/lib/ads/session";
import { templateById } from "@/lib/ads/templates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * "Use a different angle" (§65).
 *
 * ⚠️ IT NULLS THE ANSWERS, AND THE UI SAYS SO BEFORE THE TAP. A different
 * template asks different questions, so answers filed against the old ones are
 * answers to questions that no longer exist — keeping them would put a reply
 * about a fee under a question about a review score.
 *
 * What the answers already WROTE survives: `ad_profile` is merged as they go,
 * so switching angle does not make the operator retype their business.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const gate = await adWriteSession();
  if (!gate.ok) return gate.response;
  const { admin, customer } = gate.session;

  const draft = await loadDraft(admin, customer.id, params.id);
  if (!draft) return adJson({ error: "Not found" }, 404);

  let body: { template_id?: unknown };
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const template = typeof body.template_id === "string" ? templateById(body.template_id) : null;
  if (!template) return adJson({ error: "Unknown template" }, 400);
  if (template.id === draft.template_id) {
    return adJson({ error: "That is already the angle." }, 400);
  }

  // ⚠️ SPENT BEFORE THE MODEL IS CALLED, atomically. A budget checked in
  // TypeScript is a budget two tabs both pass.
  const spent = await spendBudget(admin, customer.id, draft.id, "template");
  if (spent === null) {
    return adJson({ error: AD_COPY.errors.switches, code: "template_cap" }, 429);
  }

  const context = adContext(customer, template);
  const set = await generateQuestions({
    prompt: draft.prompt,
    account: context.brief,
    forcedTemplate: template,
    fallback: () => fallbackQuestionnaire(template, context.resolution),
  });

  const questions = set?.questions ?? fallbackQuestionnaire(template, context.resolution);

  // ⚠️ STORED, NOT RETURNED — see AD_COPY.chat.standardQuestions. `set.degraded`
  // went back in the JSON and was read by nobody, so the operator had no way of
  // knowing these were our own questions rather than ones picked for their
  // account. `template_reason` is already stored and already rendered.
  const reason = [set?.reason || draft.template_reason || ""]
    .concat(set?.degraded ?? true ? [AD_COPY.chat.standardQuestions] : [])
    .filter(Boolean)
    .join(" ");

  const { error } = await admin
    .from("ad_drafts")
    .update({
      template_id: template.id,
      template_reason: reason,
      questions,
      // ⚠️ A NEW LADDER IS A NEW VERSION. A simplify request still in flight
      // against the old array must lose its compare-and-swap rather than
      // writing one of the old questions back into the new set.
      questions_version: draft.questions_version + 1,
      status: "collecting",
      copy: null,
      error: null,
    })
    .eq("id", draft.id)
    .eq("customer_id", customer.id);

  if (error) {
    console.error("ads: could not switch template", error.message);
    return adJson({ error: AD_COPY.errors.generic }, 500);
  }

  if (set) {
    await recordGenerations(admin, { customerId: customer.id, draftId: draft.id, entries: set.entries });
  }

  return adJson({
    template_id: template.id,
    template_reason: reason,
    questions,
    questions_version: draft.questions_version + 1,
    switches_used: spent,
  });
}
