import { NextResponse, type NextRequest } from "next/server";
import { getCurrentCustomer } from "@/lib/auth";
import { sendFeedbackEmail } from "@/lib/emails";
import { ticketReference } from "@/lib/supportTickets";
import { collectAnswers } from "@/lib/feedback/schemas";
import { answersComplete, finaliseTicket, loadClarifyTicket } from "@/lib/feedback/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Synthesis is the one call where thinking earns its cost; it can take 20-40s. */
export const maxDuration = 60;

/**
 * The customer has answered every question. Synthesise, then notify (§47).
 *
 * ⚠️ COMPLETENESS IS ENFORCED HERE, NOT ONLY IN THE BROWSER. A disabled button
 * is a courtesy; this is the control. Every question must carry an answer,
 * because a hole in the answers is a hole in the brief in exactly the place
 * that mattered — which is the entire reason there is no skip control.
 *
 * ⚠️ THE EMAIL SENDS WHETHER OR NOT SYNTHESIS WORKED. `finaliseTicket` marks
 * 'failed' and the sweeper retries; the notification still goes out now,
 * carrying the answers, because the customer has finished and the team should
 * hear about it. A model outage may cost the brief. It may never cost the
 * request.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  let body: { answers?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { customer } = await getCurrentCustomer();
  const ticket = await loadClarifyTicket(params.id, customer);
  if (!ticket) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Already finished. Idempotent rather than an error: a double-tapped send, or
  // a retry after a flaky connection, must not run synthesis twice or send a
  // second email.
  if (ticket.ai_status !== "awaiting_answers") {
    return NextResponse.json({ ok: true, reference: ticketReference(ticket.reference) });
  }

  const stored = ticket.clarifications ?? [];
  const answers = collectAnswers(stored, body.answers);
  if (stored.length && !answersComplete(stored, answers)) {
    return NextResponse.json(
      { error: "Please answer every question before sending." },
      { status: 400 }
    );
  }

  const { status } = await finaliseTicket(ticket, customer, body.answers);

  const { error } = await sendFeedbackEmail({
    type: ticket.kind === "bug" ? "bug" : "feature",
    name: customer?.contact_name ?? "A customer",
    email: customer?.email ?? "",
    business: ticket.submitter_business,
    subject: ticket.subject,
    details: ticket.body,
    page: ticket.page,
    reference: ticketReference(ticket.reference),
    account: customer
      ? {
          customer_id: customer.id,
          business_name: customer.business_name,
          contact_name: customer.contact_name,
          email: customer.email,
          phone: customer.phone ?? null,
        }
      : null,
  });

  // Not a 502. The row landed, the brief is written, and the team can see both
  // on /admin/support — §46.2's ladder, and the reason a Resend outage is no
  // longer the customer's problem.
  if (error) console.error("feedback answers: ticket finalised but the email failed", error);

  return NextResponse.json({
    ok: true,
    reference: ticketReference(ticket.reference),
    brief: status === "ready",
  });
}
