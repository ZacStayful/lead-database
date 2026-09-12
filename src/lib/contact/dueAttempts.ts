/**
 * The due-attempt scan (§42), lifted out of the contact-followups cron so that
 * TWO readers run the same query: the 08:15 daily prompt, and the Today panel
 * on the dashboard home (§54). A second hand-written copy of this query is
 * exactly how §42.8's 91 sequence runs were destroyed — a scan that looked
 * right and was never the one running.
 *
 * ⚠️ BOUNDED BY `contact_notify_from`, AND IT FAILS CLOSED. The 2026-09-01
 * backfill put a plan on every open lead, so the naive "what is due" query
 * returns 326 attempts across 23 customers — landlords who enquired months
 * ago. The cutoff keeps the prompt (and now the panel) to leads assigned from
 * go-live onward; an unreadable cutoff means NOTHING is due rather than
 * everything. Both `!inner`s are load-bearing (§27.8): a left join returns
 * every draft with its run nulled, which is a scan that looks correct and is
 * wrong.
 *
 * `followUpCronGuard.test.ts` pins the clauses against THIS file.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ContactChannel } from "@/lib/contact/contactStrategy";
import type { DueAttempt } from "@/lib/contact/followUpSummary";

interface AttemptRow {
  step_number: number;
  channel: string;
  send_after: string;
  message_sequence_runs: {
    customer_id: string;
    assignment_id: string;
    lead_id: string;
    lead_assignments: {
      assigned_at: string;
      lead: { lead_name: string | null } | null;
    } | null;
  } | null;
}

/** The go-live cutoff, or null when unreadable — and null means "nothing is due". */
export async function readNotifyCutoff(admin: SupabaseClient): Promise<string | null> {
  const { data } = await admin
    .from("system_settings")
    .select("value")
    .eq("key", "contact_notify_from")
    .maybeSingle();
  const cutoff = (data as { value?: string } | null)?.value;
  return cutoff && cutoff.trim() !== "" ? cutoff : null;
}

/**
 * Pending attempts whose time has come, grouped by customer. Pass `customerId`
 * to scope the scan to one customer (the dashboard); omit it for everybody
 * (the cron). Returns an empty map when the cutoff is unreadable.
 */
export async function fetchDueAttempts(
  admin: SupabaseClient,
  opts: { customerId?: string; now?: Date } = {}
): Promise<{ byCustomer: Map<string, DueAttempt[]>; cutoff: string | null; error: string | null }> {
  const now = opts.now ?? new Date();
  const cutoff = await readNotifyCutoff(admin);
  if (!cutoff) return { byCustomer: new Map(), cutoff: null, error: null };

  let query = admin
    .from("message_sequence_drafts")
    .select(
      "step_number, channel, send_after, " +
        "message_sequence_runs!inner(customer_id, assignment_id, lead_id, " +
        "lead_assignments!inner(assigned_at, lead:leads(lead_name)))"
    )
    .eq("state", "pending")
    .eq("message_sequence_runs.status", "active")
    .lte("send_after", now.toISOString())
    .gte("message_sequence_runs.lead_assignments.assigned_at", cutoff)
    .limit(2000);
  if (opts.customerId) {
    query = query.eq("message_sequence_runs.customer_id", opts.customerId);
  }

  const { data: rows, error } = await query;
  if (error) return { byCustomer: new Map(), cutoff, error: error.message };

  const byCustomer = new Map<string, DueAttempt[]>();
  for (const r of (rows ?? []) as unknown as AttemptRow[]) {
    const run = r.message_sequence_runs;
    if (!run) continue;
    const assignedAt = run.lead_assignments?.assigned_at;
    if (!assignedAt) continue;
    const overdueDays = Math.max(
      0,
      Math.floor((now.getTime() - new Date(r.send_after).getTime()) / 86_400_000)
    );
    const list = byCustomer.get(run.customer_id) ?? [];
    list.push({
      assignmentId: run.assignment_id,
      leadId: run.lead_id,
      leadName: run.lead_assignments?.lead?.lead_name ?? null,
      channel: r.channel as ContactChannel,
      stepNumber: r.step_number,
      overdueDays,
    });
    byCustomer.set(run.customer_id, list);
  }
  return { byCustomer, cutoff, error: null };
}
