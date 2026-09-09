import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { sendFeedbackEmail } from "@/lib/emails";
import { loadTicketAccount, logSupportTicket } from "@/lib/supportTicketLog";
import {
  MAX_BODY,
  MAX_PAGE,
  MAX_SUBJECT,
  MAX_SUBMITTER_BUSINESS,
  MAX_SUBMITTER_EMAIL,
  MAX_SUBMITTER_NAME,
  ticketReference,
} from "@/lib/supportTickets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Receive a bug report or feature request, LOG IT, and email it to the team.
 *
 * ⚠️ THIS ROUTE IS PUBLIC. `middleware.ts` matches only /dashboard and /admin,
 * so it works signed out and always has — CLAUDE.md §8's claim that
 * forgot-password is the only unauthenticated route is simply wrong, and §46
 * corrects it. That matters more now than it did: since §46 this is the first
 * unauthenticated write of free text into a table in the codebase.
 *
 * The abuse surface is not new — the route already fired an unlimited email to
 * the team on every anonymous POST, and a row is strictly cheaper than an
 * email — but it is now worth bounding, and the LENGTH CAPS below are what
 * ships for that. A durable per-address limiter is a deferred item in §46:
 * `consume_reset_budget` is the obvious reuse and is the wrong shape, because
 * its `subject_kind` CHECK admits only 'email' and 'ip' and the table it writes
 * is named for password resets.
 *
 * See the support route for the response ladder — it is identical, and the
 * reason a failed email is no longer a 502 once the row landed.
 */
export async function POST(request: NextRequest) {
  let body: {
    type?: string;
    name?: string;
    email?: string;
    business?: string;
    subject?: string;
    details?: string;
    page?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const type = body.type === "bug" ? "bug" : "feature";
  const name = body.name?.trim();
  const email = body.email?.trim();
  const subject = body.subject?.trim();
  const details = body.details?.trim();
  const business = body.business?.trim() || null;
  const page = body.page?.trim() || null;

  if (!name || !email || !subject || !details) {
    return NextResponse.json(
      { error: "Name, email, a short summary and details are all required." },
      { status: 400 }
    );
  }

  // Length caps mirror 0133's CHECK constraints, and on a PUBLIC endpoint they
  // are the bound on what an anonymous caller can write.
  const tooLong =
    name.length > MAX_SUBMITTER_NAME ||
    email.length > MAX_SUBMITTER_EMAIL ||
    subject.length > MAX_SUBJECT ||
    details.length > MAX_BODY ||
    (business?.length ?? 0) > MAX_SUBMITTER_BUSINESS ||
    (page?.length ?? 0) > MAX_PAGE;
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
    source: "feedback_form",
    kind: type,
    name,
    email,
    business,
    subject,
    body: details,
    page,
    account: context?.account ?? null,
    customer: context?.customer ?? null,
  });

  const { error } = await sendFeedbackEmail({
    type,
    name,
    email,
    business,
    subject,
    details,
    page,
    reference: ticket ? ticketReference(ticket.reference) : null,
    account: context?.account ?? null,
  });

  if (error) {
    if (!ticket) {
      return NextResponse.json(
        { error: "Could not send your message. Please try again." },
        { status: 502 }
      );
    }
    console.error("feedback: ticket logged but the email failed", error);
  }

  return NextResponse.json({
    ok: true,
    reference: ticket ? ticketReference(ticket.reference) : null,
  });
}
