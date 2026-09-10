import { NextResponse, type NextRequest } from "next/server";
import { getCurrentCustomer } from "@/lib/auth";
import { accountState } from "@/lib/feedback/accountState";
import { simplifyQuestion } from "@/lib/feedback/clarify";
import { terminalQuestion } from "@/lib/feedback/schemas";
import { canSimplify, loadClarifyTicket, saveQuestions } from "@/lib/feedback/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * "Not sure what this means?" — ask one question again, more simply (§50).
 *
 * ⚠️ THIS ROUTE EXISTS BECAUSE THERE IS NO SKIP BUTTON. The questions are
 * compulsory, which is only fair if not understanding one leads somewhere. It
 * leads here.
 *
 * ⚠️ IT ALWAYS RETURNS AN ANSWERABLE QUESTION. Not found and not authorised are
 * the only failures; everything else — budget exhausted, model down, malformed
 * output, a crafted depth — lands on the terminal free-text form, which anyone
 * can answer. A customer stuck in front of a compulsory question with no way
 * forward is the one state this feature must never produce.
 *
 * ⚠️ THE DEPTH IS READ FROM THE STORED QUESTION, NEVER FROM THE REQUEST. The
 * budget is spent server-side or it is not a budget: a client that sent its own
 * depth could loop the ladder indefinitely and bill the account for it.
 */
export async function POST(request: NextRequest) {
  let body: { ticketId?: string; questionId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { customer } = await getCurrentCustomer();
  const ticket = await loadClarifyTicket(body.ticketId ?? "", customer);
  if (!ticket) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const stored = ticket.clarifications ?? [];
  const index = stored.findIndex((q) => q.id === body.questionId);
  if (index === -1) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const previous = stored[index];
  const next = canSimplify(stored, previous)
    ? await simplifyQuestion({
        question: previous,
        summary: ticket.subject,
        body: ticket.body,
        account: accountState(customer),
      })
    : // Out of budget. Drop straight to the floor without spending a call —
      // the customer still gets a question they can answer.
      terminalQuestion(previous.id, previous.question);

  stored[index] = { ...next, answer: previous.answer };
  await saveQuestions(ticket.id, stored);

  return NextResponse.json({ question: stored[index] });
}
