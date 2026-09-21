import type { NextRequest } from "next/server";
import { AD_COPY } from "@/lib/ads/copy";
import { adContext } from "@/lib/ads/context";
import { simplifyQuestion } from "@/lib/ads/generate";
import { recordGenerations } from "@/lib/ads/ledger";
import { canSimplify } from "@/lib/ads/schemas";
import { adJson, adWriteSession, loadDraft, replaceQuestions } from "@/lib/ads/session";
import { DEFAULT_TEMPLATE_ID, templateById } from "@/lib/ads/templates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * "Not sure what this means?" (§65).
 *
 * ⚠️ THE BUDGET SCALES WITH THE QUESTION COUNT, and §50's flat `MAX_DEPTH * 3`
 * breaks twice if copied: a template can ask eight slot questions where a
 * support ticket asks three, so a flat six is exhausted by the first four
 * rewordings — and §50 can tolerate running out because the ticket still
 * sends. An ad with no answers cannot be built at all.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const gate = await adWriteSession();
  if (!gate.ok) return gate.response;
  const { admin, customer } = gate.session;

  const draft = await loadDraft(admin, customer.id, params.id);
  if (!draft) return adJson({ error: "Not found" }, 404);

  let body: { question_id?: unknown };
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const questionId = typeof body.question_id === "string" ? body.question_id : "";
  const questions = draft.questions ?? [];
  const index = questions.findIndex((q) => q.id === questionId);
  if (index < 0) return adJson({ error: "Not found" }, 404);

  if (!canSimplify(questions)) {
    // Not an error: the ladder has a floor and they are on it.
    return adJson({ question: questions[index], exhausted: true });
  }

  const template = templateById(draft.template_id ?? DEFAULT_TEMPLATE_ID)!;
  const result = await simplifyQuestion({
    question: questions[index],
    account: adContext(customer, template).brief,
  });

  const next = questions.slice();
  next[index] = result.question;

  // ⚠️ A COMPARE-AND-SWAP ON questions_version. Two tabs simplifying different
  // questions would otherwise each write a whole array built from what they
  // read, so the later write discards the other's rewording AND its spent
  // budget — and the budget is derived from the array.
  const written = await replaceQuestions(admin, draft.id, draft.questions_version, next);
  await recordGenerations(admin, { customerId: customer.id, draftId: draft.id, entries: result.entries });

  if (!written) {
    return adJson({ error: AD_COPY.errors.busy, code: "questions_moved" }, 409);
  }
  return adJson({ question: result.question, questions_version: draft.questions_version + 1 });
}
