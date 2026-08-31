import {
  buildContactTimeline,
  contactPlanSettings,
  type ContactTimelineView,
} from "@/lib/contact/contactPlan";
import { notFound, redirect } from "next/navigation";
import { viewerScopedLead } from "@/lib/customerLeads";
import { getCurrentCustomer, isAdminUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { LeadDetail } from "@/components/dashboard/LeadDetail";
import { fetchOrderedAssignments, parseSource } from "@/lib/leadOrder";
import { channelAvailability } from "@/lib/messaging/service";
import type { AssignmentWithLead, LeadNote, LeadFile } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function LeadDetailPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { from?: string };
}) {
  const { user, customer } = await getCurrentCustomer();
  if (!user) redirect("/login");
  if (!customer) redirect("/dashboard");

  const admin = createAdminClient();
  const { data } = await admin
    .from("lead_assignments")
    .select("*, lead:leads(*)")
    .eq("lead_id", params.id)
    .eq("customer_id", customer.id)
    .maybeSingle();

  if (!data || !(data as AssignmentWithLead).lead) {
    notFound();
  }

  const assignment = {
    ...(data as AssignmentWithLead),
    // As on the feed: a resold lead's owner id belongs to the operator who
    // uploaded it, not to the customer reading this page.
    lead: viewerScopedLead((data as AssignmentWithLead).lead, customer.id),
  } as AssignmentWithLead;

  // How many landlords this customer has already signed — powers the "your Nth
  // sign-up" celebration when they mark this lead as signed.
  const { count: signedCountBefore } = await admin
    .from("lead_assignments")
    .select("id", { count: "exact", head: true })
    .eq("customer_id", customer.id)
    .eq("status", "won");

  const { data: notesData } = await admin
    .from("lead_notes")
    .select("id, lead_assignment_id, customer_id, body, created_at")
    .eq("lead_assignment_id", assignment.id)
    .order("created_at", { ascending: false });

  const { data: filesData } = await admin
    .from("lead_files")
    .select("*")
    .eq("lead_assignment_id", assignment.id)
    .order("created_at", { ascending: false });

  // Prev/next navigation within whichever list this lead was opened from.
  const from = parseSource(searchParams.from);
  const ordered = await fetchOrderedAssignments(customer.id, from);
  const idx = ordered.findIndex((a) => a.id === assignment.id);
  const prevLeadId = idx > 0 ? ordered[idx - 1].lead_id : null;
  const nextLeadId =
    idx >= 0 && idx < ordered.length - 1 ? ordered[idx + 1].lead_id : null;

  // The lead's own messages, for the timeline (§40). Rendered alongside notes
  // rather than written AS notes — a lead_notes row is a claim about operator
  // work that a dozen routing predicates read, and one per message would have
  // changed lead allocation by accident.
  const { data: messageData } = await admin
    .from("lead_messages")
    .select(
      "id, channel, direction, status, subject, body_text, created_at, read_at, first_opened_at, first_clicked_at"
    )
    .eq("assignment_id", assignment.id)
    .eq("customer_id", customer.id)
    .order("created_at", { ascending: false })
    .limit(200);

  // The contact plan (§42): where this landlord sits in the five-attempt
  // sequence. Read on the admin client because message_sequence_* are deny-all
  // to the browser, and gated on the platform switch — with it off the whole
  // block renders nothing, exactly as before this feature existed.
  const planSettings = await contactPlanSettings(admin);
  let contactTimeline: ContactTimelineView | null = null;
  if (planSettings.enabled || isAdminUser(user)) {
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
        .select(
          "step_number, channel, body, send_after, state, done_at, done_source, call_outcome"
        )
        .eq("run_id", run.id)
        .order("step_number", { ascending: true });

      contactTimeline = buildContactTimeline({
        rows: (attemptRows ?? []) as never,
        landlordContactMethod: assignment.lead.landlord_contact_method ?? null,
        runStatus: run.status,
      });
    }
  }

  // Messaging state for the two buttons (§40). Resolved server-side on the
  // admin client, because the connection tables are deny-all to the browser.
  const messageChannels = await channelAvailability(admin, {
    customerId: customer.id,
    assignment,
    lead: assignment.lead,
    // Admins see the buttons while messaging_enabled is still false, so the
    // whole flow can be exercised on production before any customer sees it.
    preview: isAdminUser(user),
  });

  return (
    <LeadDetail
      assignment={assignment}
      notes={(notesData ?? []) as LeadNote[]}
      files={(filesData ?? []) as LeadFile[]}
      userId={user.id}
      from={from}
      prevLeadId={prevLeadId}
      nextLeadId={nextLeadId}
      signedCountBefore={signedCountBefore ?? 0}
      presentationConfigured={customer.presentation_settings_updated_at != null}
      messageChannels={messageChannels}
      messages={(messageData ?? []) as never}
      contactTimeline={contactTimeline}
    />
  );
}
