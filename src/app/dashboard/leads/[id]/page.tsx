import { notFound, redirect } from "next/navigation";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { LeadDetail } from "@/components/dashboard/LeadDetail";
import { fetchOrderedAssignments, parseSource } from "@/lib/leadOrder";
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

  const assignment = data as AssignmentWithLead;

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
    />
  );
}
