import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  answersLockRefuses,
  mergeAnswers,
  parseAnswersPatch,
  readStoredAnswers,
} from "@/lib/funnel/answers";
import { advanceStep, isFirstAnswer, namesOtherProduct } from "@/lib/funnel/session";
import { FUNNEL_NO_STORE, funnelGate } from "@/lib/funnel/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = FUNNEL_NO_STORE;

/**
 * POST /api/funnel/[token]/answers — save what the visitor has answered so
 * far, and the plan they chose (batch 02 Phase 3: "every answer saves to the
 * session. Returning to the link resumes where they stopped").
 *
 * No sign-in: the token is the credential, checked by `funnelGate` exactly as
 * the preview route checks it.
 *
 * ⚠️ IT JUDGES SHAPE, NOT MEANING. A closed set of named fields, each of its
 * right shape (`parseAnswersPatch`); whether a postcode is real is the preview
 * route's question, asked by the one validator it has. Nothing here reads the
 * supply, so a save spends none of the 20 previews.
 *
 * ⚠️ THE POSTCODE LOCK HOLDS HERE TOO. Once a postcode has been previewed, a
 * save naming a different one is refused with the same 409 the preview route
 * gives. Without it the answers could disagree with the snapshot beside them.
 */
export async function POST(request: NextRequest, { params }: { params: { token: string } }) {
  const admin = createAdminClient();

  const gate = await funnelGate(admin, params.token, "answers");
  if (!gate.ok) return gate.response;
  const session = gate.session;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers: NO_STORE });
  }
  if (namesOtherProduct(body)) {
    return NextResponse.json({ code: "management_only" }, { status: 400, headers: NO_STORE });
  }

  const parsed = parseAnswersPatch(body);
  if (!parsed.ok) {
    return NextResponse.json({ code: "invalid_answers", field: parsed.field }, { status: 400, headers: NO_STORE });
  }
  const patch = parsed.value;

  if (answersLockRefuses(session.base_postcode_locked, patch.answers.basePostcode)) {
    return NextResponse.json(
      { code: "postcode_locked", lockedPostcode: session.base_postcode_locked },
      { status: 409, headers: NO_STORE }
    );
  }

  const update: Record<string, unknown> = {
    answers: mergeAnswers(readStoredAnswers(session.answers), patch.answers),
  };
  if (patch.plan !== null) update.plan_selected = patch.plan;
  if (patch.questionsDone) update.step = advanceStep(session.step, "questions_done");

  // Never moves a paid session (funnelGate has already refused one; this is
  // the second stop, in the write itself).
  const { error } = await admin
    .from("funnel_sessions")
    .update(update)
    .eq("id", session.id)
    .neq("step", "paid");
  if (error) {
    console.error("[funnel/answers] could not save", error.message);
    return NextResponse.json({ code: "unavailable" }, { status: 503, headers: NO_STORE });
  }

  // The first answer (batch 03, 0166): the point the session's entry_point is
  // frozen at (E1), and Phase 2's "Funnel started". Claimed by its own write,
  // guarded on the stamp still being null, so two first saves racing each
  // other leave the earlier time, and a later save never moves it. Best
  // effort: the answer itself is already saved.
  if (isFirstAnswer(session.first_answered_at, patch.answers as Record<string, unknown>)) {
    const { error: stampError } = await admin
      .from("funnel_sessions")
      .update({ first_answered_at: new Date().toISOString() })
      .eq("id", session.id)
      .is("first_answered_at", null);
    if (stampError) console.error("[funnel/answers] could not stamp the first answer", stampError.message);
  }

  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
