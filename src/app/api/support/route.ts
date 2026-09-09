import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { sendSupportEmail } from "@/lib/emails";
import { loadTicketAccount, logSupportTicket } from "@/lib/supportTicketLog";
import {
  MAX_BODY,
  MAX_SUBJECT,
  MAX_SUBMITTER_BUSINESS,
  MAX_SUBMITTER_EMAIL,
  MAX_SUBMITTER_NAME,
  ticketReference,
} from "@/lib/supportTickets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Receive a customer support request, LOG IT, and email it to the Stayful team.
 * If the sender is signed in, their account record is attached for context.
 *
 * ⚠️ THE TICKET IS WRITTEN BEFORE THE EMAIL IS SENT (§46). Until this changed,
 * a Resend failure returned 502 and the submission was gone — the customer was
 * told to try again and nothing recorded that they had asked. The row is now
 * the durable half.
 *
 * ⚠️ SO THE RESPONSE LADDER CHANGED, AND A FAILED SEND IS NO LONGER A 502 WHEN
 * THE ROW LANDED. Telling a customer to retry after we have kept their request
 * only manufactures a duplicate ticket. The four cases:
 *
 *   row ok  + email ok      → 200 {ok, reference}
 *   row ok  + email failed  → 200 {ok, reference}, logged. Recovery is /admin/support.
 *   row fail + email ok     → 200 {ok}            — exactly today's behaviour.
 *   row fail + email failed → 502                 — exactly today's message.
 */
export async function POST(request: NextRequest) {
  let body: {
    name?: string;
    email?: string;
    business?: string;
    subject?: string;
    message?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const name = body.name?.trim();
  const email = body.email?.trim();
  const subject = body.subject?.trim();
  const message = body.message?.trim();
  const business = body.business?.trim() || null;

  if (!name || !email || !subject || !message) {
    return NextResponse.json(
      { error: "Name, email, a subject and your message are all required." },
      { status: 400 }
    );
  }

  // Length caps mirror 0133's CHECK constraints. Before §46 nothing here was
  // capped because the only cost of a long field was a long email; now an
  // over-long field would be a constraint violation instead of a clear 400.
  const tooLong =
    name.length > MAX_SUBMITTER_NAME ||
    email.length > MAX_SUBMITTER_EMAIL ||
    subject.length > MAX_SUBJECT ||
    message.length > MAX_BODY ||
    (business?.length ?? 0) > MAX_SUBMITTER_BUSINESS;
  if (tooLong) {
    return NextResponse.json(
      { error: "That message is too long to send. Please shorten it." },
      { status: 400 }
    );
  }

  // Attach the signed-in customer's account, if any (authoritative source).
  let context: Awaited<ReturnType<typeof loadTicketAccount>> = null;
  try {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) context = await loadTicketAccount(user.id);
  } catch {
    /* treat as anonymous */
  }

  const ticket = await logSupportTicket({
    source: "support_form",
    kind: "support",
    name,
    email,
    business,
    subject,
    body: message,
    account: context?.account ?? null,
    customer: context?.customer ?? null,
  });

  const { error } = await sendSupportEmail({
    name,
    email,
    business,
    subject,
    message,
    reference: ticket ? ticketReference(ticket.reference) : null,
    account: context?.account ?? null,
  });

  if (error) {
    if (!ticket) {
      return NextResponse.json(
        { error: "Could not send your request. Please try again." },
        { status: 502 }
      );
    }
    console.error("support: ticket logged but the email failed", error);
  }

  return NextResponse.json({
    ok: true,
    reference: ticket ? ticketReference(ticket.reference) : null,
  });
}
