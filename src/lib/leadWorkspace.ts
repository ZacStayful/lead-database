/**
 * Everything one lead's workspace needs, loaded once (§56.7).
 *
 * The lead page and the conversation page render the same contact panel and
 * the same thread column, so they share one loader — the body of the old
 * `leads/[id]/page.tsx`, lifted rather than rewritten, plus a single
 * lead_events read that feeds BOTH the thread's click rows and the activity
 * column. One server pass per render, no per-item reads.
 *
 * ⚠️ The lead goes through `viewerScopedLead` before anything else happens
 * to it: a resold lead's owner id and profile belong to the uploader (§32.8).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildContactTimeline,
  contactPlanSettings,
  type ContactTimelineView,
} from "@/lib/contact/contactPlan";
import { TOTAL_ATTEMPTS } from "@/lib/contact/contactStrategy";
import { viewerScopedLead } from "@/lib/customerLeads";
import { fetchOrderedAssignments, parseSource, type LeadSource } from "@/lib/leadOrder";
import { buildLeadActivity, type ActivityItem } from "@/lib/leadActivity";
import { channelAvailability } from "@/lib/messaging/service";
import { buildThreadItems, type ThreadItem } from "@/lib/messaging/threadItems";
import type { ChannelAvailability } from "@/lib/messaging/types";
import { deadLeadClaimState } from "@/lib/quality/claimState";
import type { AssignmentWithLead, Customer, LeadFile, LeadNote } from "@/lib/types";

export interface LeadWorkspaceData {
  assignment: AssignmentWithLead;
  notes: LeadNote[];
  files: LeadFile[];
  /** How many messages exist on the assignment — the delete confirm names it. */
  messageCount: number;
  contactTimeline: ContactTimelineView | null;
  messageChannels: ChannelAvailability[];
  deadLeadClaim: Awaited<ReturnType<typeof deadLeadClaimState>>;
  signedCountBefore: number;
  presentationConfigured: boolean;
  position: {
    from: LeadSource;
    index: number;
    total: number;
    prevLeadId: string | null;
    nextLeadId: string | null;
  };
  threadItems: ThreadItem[];
  activity: ActivityItem[];
  /** Unread inbound replies across the lead's threads. */
  unread: number;
  starred: boolean;
  /** Which message channels have a thread — the thread header's star/read verbs need one. */
  hasThread: boolean;
}

export async function loadLeadWorkspace(
  admin: SupabaseClient,
  customer: Customer,
  leadId: string,
  opts: { from?: string; isAdmin: boolean }
): Promise<LeadWorkspaceData | null> {
  const { data } = await admin
    .from("lead_assignments")
    .select("*, lead:leads(*)")
    .eq("lead_id", leadId)
    .eq("customer_id", customer.id)
    .maybeSingle();
  if (!data || !(data as AssignmentWithLead).lead) return null;

  const assignment = {
    ...(data as AssignmentWithLead),
    lead: viewerScopedLead((data as AssignmentWithLead).lead, customer.id),
  } as AssignmentWithLead;

  const from = parseSource(opts.from);
  const [signed, notesRes, filesRes, ordered, messagesRes, eventsRes, planSettings, threadsRes, deadLeadClaim, messageChannels] =
    await Promise.all([
      admin
        .from("lead_assignments")
        .select("id", { count: "exact", head: true })
        .eq("customer_id", customer.id)
        .eq("status", "won"),
      admin
        .from("lead_notes")
        .select("id, lead_assignment_id, customer_id, body, created_at")
        .eq("lead_assignment_id", assignment.id)
        .order("created_at", { ascending: false }),
      admin
        .from("lead_files")
        .select("*")
        .eq("lead_assignment_id", assignment.id)
        .order("created_at", { ascending: false }),
      fetchOrderedAssignments(customer.id, from),
      admin
        .from("lead_messages")
        .select(
          "id, channel, direction, status, subject, body_text, created_at, read_at, first_opened_at, first_clicked_at, from_address, to_address"
        )
        .eq("assignment_id", assignment.id)
        .eq("customer_id", customer.id)
        .order("created_at", { ascending: false })
        .limit(200),
      admin
        .from("lead_events")
        .select("id, event_type, created_at, metadata")
        .eq("assignment_id", assignment.id)
        .in("event_type", ["tel_click", "whatsapp_click", "mailto_click", "stage_changed"])
        .order("created_at", { ascending: false })
        .limit(500),
      contactPlanSettings(admin),
      admin
        .from("lead_message_threads")
        .select("id, unread_inbound_count, starred_at")
        .eq("customer_id", customer.id)
        .eq("assignment_id", assignment.id),
      deadLeadClaimState(admin, customer.id, assignment.id),
      channelAvailability(admin, {
        customerId: customer.id,
        assignment,
        lead: assignment.lead,
        preview: opts.isAdmin,
      }),
    ]);

  // The contact plan (§42): where this landlord sits in the five-attempt
  // sequence. Read on the admin client because message_sequence_* are deny-all
  // to the browser, and gated on the platform switch — with it off the whole
  // block renders nothing, exactly as before this feature existed.
  let contactTimeline: ContactTimelineView | null = null;
  if (planSettings.enabled || opts.isAdmin) {
    const { data: runRow } = await admin
      .from("message_sequence_runs")
      .select("id, status, message_sequences!inner(delivery)")
      .eq("assignment_id", assignment.id)
      .eq("message_sequences.delivery", "manual")
      .maybeSingle();
    const run = runRow as { id: string; status: string } | null;
    if (run) {
      const { data: attemptRows } = await admin
        .from("message_sequence_drafts")
        .select("step_number, channel, body, send_after, state, done_at, done_source, call_outcome")
        .eq("run_id", run.id)
        .order("step_number", { ascending: true });
      contactTimeline = buildContactTimeline({
        rows: (attemptRows ?? []) as never,
        landlordContactMethod: assignment.lead.landlord_contact_method ?? null,
        runStatus: run.status,
      });
    }
  }

  const index = ordered.findIndex((a) => a.id === assignment.id);
  const messages = (messagesRes.data ?? []) as {
    id: string;
    channel: "email" | "whatsapp";
    direction: "outbound" | "inbound";
    status: string;
    subject: string | null;
    body_text: string | null;
    created_at: string;
    read_at: string | null;
    first_opened_at: string | null;
    first_clicked_at: string | null;
    from_address: string | null;
    to_address: string | null;
  }[];
  const events = (eventsRes.data ?? []) as {
    id: string;
    event_type: string;
    created_at: string;
    metadata: Record<string, unknown> | null;
  }[];
  const threads = (threadsRes.data ?? []) as {
    id: string;
    unread_inbound_count: number | null;
    starred_at: string | null;
  }[];

  return {
    assignment,
    notes: (notesRes.data ?? []) as LeadNote[],
    files: (filesRes.data ?? []) as LeadFile[],
    messageCount: messages.length,
    contactTimeline,
    messageChannels,
    deadLeadClaim,
    signedCountBefore: signed.count ?? 0,
    presentationConfigured: customer.presentation_settings_updated_at != null,
    position: {
      from,
      index,
      total: ordered.length,
      prevLeadId: index > 0 ? ordered[index - 1].lead_id : null,
      nextLeadId: index >= 0 && index < ordered.length - 1 ? ordered[index + 1].lead_id : null,
    },
    threadItems: buildThreadItems({
      messages,
      events,
      attempts: contactTimeline?.attempts,
      totalAttempts: TOTAL_ATTEMPTS,
    }),
    activity: buildLeadActivity({
      assignment: {
        id: assignment.id,
        assigned_at: assignment.assigned_at,
        first_contacted_at: assignment.first_contacted_at ?? null,
        landlord_referral_sent_at: assignment.landlord_referral_sent_at ?? null,
        status: assignment.status,
        closed_at: assignment.closed_at ?? null,
        last_status_change_at: assignment.last_status_change_at ?? null,
      },
      events,
      messages,
      notes: ((notesRes.data ?? []) as LeadNote[]).map((n) => ({ id: n.id, body: n.body, created_at: n.created_at })),
      files: ((filesRes.data ?? []) as LeadFile[]).map((f) => ({ id: f.id, file_name: f.file_name, created_at: f.created_at })),
      attempts: contactTimeline?.attempts,
      totalAttempts: TOTAL_ATTEMPTS,
    }),
    unread: threads.reduce((n, t) => n + (t.unread_inbound_count ?? 0), 0),
    starred: threads.some((t) => Boolean(t.starred_at)),
    hasThread: threads.length > 0,
  };
}
