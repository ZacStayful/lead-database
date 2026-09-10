import { NextResponse, type NextRequest } from "next/server";
import { getCurrentCustomer } from "@/lib/auth";
import { accountState } from "@/lib/feedback/accountState";
import { generateQuestions } from "@/lib/feedback/clarify";
import { loadClarifyTicket, saveQuestions, toStored } from "@/lib/feedback/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** The customer is watching a spinner; the SDK timeout is 25s and this is the room around it. */
export const maxDuration = 60;

/**
 * Generate the questions for a ticket that has just been logged (§47).
 *
 * ⚠️ AN EMPTY QUESTION LIST IS A SUCCESS, NOT AN ERROR. Every failure — no key,
 * a timeout, malformed output — comes back as `{ questions: [] }` and the client
 * goes straight to sending. The customer must never see a model problem, and
 * their ticket is already on file either way.
 *
 * The questions are PERSISTED rather than held in the browser. Not for secrecy
 * — a customer can already write anything they like into `body` — but because
 * the answers route has to know what was actually asked in order to pair
 * answers to questions and to enforce the simplification budget. The browser is
 * not a place to keep the state that bounds a spend.
 */
export async function POST(request: NextRequest) {
  let body: { ticketId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { customer } = await getCurrentCustomer();
  const ticket = await loadClarifyTicket(body.ticketId ?? "", customer);
  if (!ticket) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Already answered, already swept, or never eligible. Re-asking would
  // overwrite answers the customer has already given.
  if (ticket.ai_status !== "awaiting_answers") {
    return NextResponse.json({ questions: [] });
  }

  // Asked once already. Hand back what was stored rather than spending another
  // call and shuffling the questions under a customer who reloaded the page.
  if (ticket.clarifications?.length) {
    return NextResponse.json({ questions: ticket.clarifications });
  }

  const generated = await generateQuestions({
    kind: ticket.kind,
    summary: ticket.subject,
    body: ticket.body,
    page: ticket.page,
    account: accountState(customer),
  });

  if (!generated) return NextResponse.json({ questions: [] });

  const stored = toStored(generated.questions);
  // A failed save is not fatal: ask them anyway. The answers route will simply
  // have nothing to pair against and the ticket sends unclarified.
  await saveQuestions(ticket.id, stored);

  return NextResponse.json({ questions: stored, requestClass: generated.requestClass });
}
