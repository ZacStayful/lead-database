import { redirect } from "next/navigation";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { LeadsList } from "@/components/dashboard/LeadsList";
import { ExportButton } from "@/components/dashboard/ExportButton";
import type { AssignmentWithLead } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function LeadsPage() {
  const { user, customer } = await getCurrentCustomer();
  if (!user) redirect("/login");
  if (!customer) redirect("/dashboard");

  const admin = createAdminClient();
  const { data } = await admin
    .from("lead_assignments")
    .select("*, lead:leads(*)")
    .eq("customer_id", customer.id)
    .order("assigned_at", { ascending: false });

  const assignments = (data ?? []) as AssignmentWithLead[];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">All leads</h1>
          <p className="text-sm text-muted-foreground">
            {assignments.length} lead{assignments.length === 1 ? "" : "s"} received
          </p>
        </div>
        <ExportButton />
      </div>
      <LeadsList assignments={assignments} />
    </div>
  );
}
