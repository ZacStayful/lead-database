import { notFound, redirect } from "next/navigation";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { LeadDetail } from "@/components/dashboard/LeadDetail";
import type { AssignmentWithLead } from "@/lib/types";

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

  return <LeadDetail assignment={data as AssignmentWithLead} />;
}
