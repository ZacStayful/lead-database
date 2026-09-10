import { createAdminClient } from "@/lib/supabase/admin";
import { ticketReference } from "@/lib/supportTickets";
import type { Customer } from "@/lib/types";
import { accountState } from "./accountState";
import { synthesiseBrief } from "./clarify";
import { renderPrompt } from "./render";
import {
  MAX_DEPTH,
  MAX_SIMPLIFY_PER_TICKET,
  answersComplete,
  collectAnswers,
  type Answer,
  type Question,
} from "./schemas";

/**
 * The clarification lifecycle, server-side.
 *
 * The routes are deliberately thin over this: ownership, budget and the
 * ai_status transitions are decisions, and decisions belong somewhere they can
 * be read in one place rather than spread across four handlers.
 */

export type ClarifyTicket = {
  id: string;
  reference: number;
  kind: string;
  subject: string;
  body: string;
  page: string | null;
  plan_snapshot: string | null;
  submitter_business: string | null;
  customer_id: string | null;
  ai_status: string | null;
  submitted_at: string;
  clarifications: StoredQuestion[] | null;
};

/** A question mid-flight. `answer` is null until the customer commits. */
export type StoredQuestion = Question & { answer: string | null };

const TICKET_COLUMNS =
  "id, reference, kind, subject, body, page, plan_snapshot, submitter_business, customer_id, ai_status, submitted_at, clarifications";

/**
 * Load a ticket the signed-in customer is allowed to be answering.
 *
 * ⚠️ OWNERSHIP IS CHECKED HERE AND NOWHERE ELSE, so every route must come
 * through this. The read runs on the service role (the §8 pattern), so RLS is
 * not protecting anything: this comparison is. A ticket with a null
 * customer_id was submitted signed out and can never be claimed.
 */
export async function loadClarifyTicket(
  ticketId: string,
  customer: Customer | null
): Promise<ClarifyTicket | null> {
  if (!customer || !ticketId) return null;
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("support_tickets")
    .select(TICKET_COLUMNS)
    .eq("id", ticketId)
    .maybeSingle();
  if (error || !data) return null;

  const ticket = data as unknown as ClarifyTicket;
  if (!ticket.customer_id || ticket.customer_id !== customer.id) return null;
  return ticket;
}

/** Persist the in-flight questions. Never throws; a failed write degrades to no clarification. */
export async function saveQuestions(
  ticketId: string,
  questions: StoredQuestion[]
): Promise<boolean> {
  try {
    const admin = createAdminClient();
    const { error } = await admin
      .from("support_tickets")
      .update({ clarifications: questions, updated_at: new Date().toISOString() })
      .eq("id", ticketId);
    if (error) {
      console.error("feedback/session: could not save questions", error);
      return false;
    }
    return true;
  } catch (err) {
    console.error("feedback/session: could not save questions", err);
    return false;
  }
}

/**
 * How much of the simplification budget this ticket has spent.
 *
 * Counted from the stored depths rather than from a counter column, so it
 * cannot be desynchronised and cannot be advanced by a crafted request: the
 * only way to raise it is to have actually been simplified.
 */
export function simplifySpent(questions: StoredQuestion[]): number {
  return questions.reduce((total, q) => total + q.depth, 0);
}

export function canSimplify(questions: StoredQuestion[], question: Question): boolean {
  return question.depth < MAX_DEPTH && simplifySpent(questions) < MAX_SIMPLIFY_PER_TICKET;
}

export function toStored(questions: Question[]): StoredQuestion[] {
  return questions.map((q) => ({ ...q, answer: null }));
}

/**
 * Recent tickets, for the synthesis call's prior-art check.
 *
 * ⚠️ THIS GOES IN THE USER TURN, NOT THE CACHED PACK. It changes every time a
 * ticket arrives, so putting it in `system` would invalidate the ~3k-token pack
 * on every request.
 *
 * The shipped columns are the payoff. A request that matches a SHIPPED ticket
 * is not a feature request at all — it is a regression or a discoverability
 * failure — and that reframing is the single most expensive thing to get wrong.
 */
export async function recentTicketDigest(excludeId: string): Promise<string> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("support_tickets")
      .select("reference, kind, status, subject, shipped_migration, shipped_claude_section")
      .neq("id", excludeId)
      .order("submitted_at", { ascending: false })
      .limit(60);
    if (!data?.length) return "No earlier requests on file.";
    return data
      .map((t) => {
        const row = t as Record<string, unknown>;
        const shipped =
          row.shipped_migration || row.shipped_claude_section
            ? ` — SHIPPED in ${row.shipped_migration ?? "?"}${
                row.shipped_claude_section ? ` (§${row.shipped_claude_section})` : ""
              }`
            : "";
        return `${ticketReference(row.reference as number)} [${row.kind}/${row.status}] ${row.subject}${shipped}`;
      })
      .join("\n");
  } catch (err) {
    console.error("feedback/session: could not read ticket history", err);
    return "Could not read earlier requests.";
  }
}

export type FinaliseResult = {
  answers: Answer[];
  status: "ready" | "failed";
};

/**
 * Run synthesis and write the result.
 *
 * ⚠️ NEVER THROWS AND NEVER BLOCKS THE EMAIL. A failed synthesis leaves
 * ai_status = 'failed' for the sweeper to retry, and the caller sends the
 * notification either way. The customer's request landing is not contingent on
 * a model being reachable — that is 0133's guarantee and this must not weaken
 * it.
 */
export async function finaliseTicket(
  ticket: ClarifyTicket,
  customer: Customer | null,
  rawAnswers: unknown
): Promise<FinaliseResult> {
  const stored = ticket.clarifications ?? [];
  const answers = collectAnswers(stored, rawAnswers);
  const admin = createAdminClient();

  const merged: StoredQuestion[] = stored.map((q) => ({
    ...q,
    answer: answers.find((a) => a.id === q.id)?.answer ?? q.answer,
  }));

  const brief = await synthesiseBrief({
    kind: ticket.kind,
    summary: ticket.subject,
    body: ticket.body,
    page: ticket.page,
    account: accountState(customer),
    answers,
    history: await recentTicketDigest(ticket.id),
  });

  const patch: Record<string, unknown> = {
    clarifications: merged,
    ai_model: "claude-opus-5",
    updated_at: new Date().toISOString(),
  };

  if (brief) {
    patch.brief = brief;
    patch.severity = brief.severity;
    patch.generated_prompt = renderPrompt(brief, {
      reference: ticket.reference,
      kind: ticket.kind,
      summary: ticket.subject,
      body: ticket.body,
      page: ticket.page,
      planSnapshot: ticket.plan_snapshot,
      businessName: ticket.submitter_business,
      submittedAt: new Date(ticket.submitted_at),
      answers,
    });
    patch.ai_status = "ready";
    patch.ai_error = null;
  } else {
    patch.ai_status = "failed";
    patch.ai_error = "synthesis returned nothing usable";
  }

  try {
    await admin.from("support_tickets").update(patch).eq("id", ticket.id);
  } catch (err) {
    console.error("feedback/session: could not write brief", err);
  }

  return { answers, status: brief ? "ready" : "failed" };
}

/**
 * Re-run synthesis for a ticket whose first attempt failed.
 *
 * The customer has already been emailed and their answers are already stored,
 * so this only fills in the brief that a transient model outage cost. It reads
 * the answers back out of `clarifications` rather than taking them from
 * anywhere else — they are the only record of what was asked and said.
 *
 * ⚠️ CLAIMED BEFORE THE WORK, like the abandonment sweep. Without the
 * conditional update two overlapping runs would both spend a synthesis call on
 * the same row.
 */
export async function retryFailedSynthesis(ticketId: string): Promise<"ready" | "failed" | "skipped"> {
  const admin = createAdminClient();

  const { data: claimed } = await admin
    .from("support_tickets")
    .update({ ai_status: "awaiting_answers", updated_at: new Date().toISOString() })
    .eq("id", ticketId)
    .eq("ai_status", "failed")
    .select(TICKET_COLUMNS);

  const ticket = (claimed?.[0] ?? null) as unknown as ClarifyTicket | null;
  if (!ticket) return "skipped";

  // The full customer row, for the account state the prompt needs. A ticket
  // whose customer has since been deleted still synthesises — accountState()
  // handles null — it just has less to go on.
  let customer: Customer | null = null;
  if (ticket.customer_id) {
    const { data } = await admin
      .from("customers")
      .select("*")
      .eq("id", ticket.customer_id)
      .maybeSingle();
    customer = (data as Customer | null) ?? null;
  }

  const stored = ticket.clarifications ?? [];
  const { status } = await finaliseTicket(
    ticket,
    customer,
    stored.map((q) => ({ id: q.id, answer: q.answer ?? "" }))
  );
  return status;
}

export { answersComplete };
