import { notFound, redirect } from "next/navigation";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { LeadDetail } from "@/components/dashboard/LeadDetail";
import type { AssignmentWithLead, LeadNote } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function LeadDetailPage({
  params,
}: {
  params: { id: string };
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

  const { data: notesData } = await admin
    .from("lead_notes")
    .select("id, lead_assignment_id, customer_id, body, created_at")
    .eq("lead_assignment_id", assignment.id)
    .order("created_at", { ascending: false });

  return (
    <LeadDetail
      assignment={assignment}
      notes={(notesData ?? []) as LeadNote[]}
    />
  );
}
