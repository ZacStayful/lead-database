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

  // Messaging state for the two buttons (§28). Resolved server-side on the
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
    />
  );
}
