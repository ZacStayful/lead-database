import { redirect } from "next/navigation";
import { getCurrentCustomer } from "@/lib/auth";
import { fetchOrderedAssignments } from "@/lib/leadOrder";
import { PriorityLeadsList } from "@/components/dashboard/PriorityLeadsList";

export const dynamic = "force-dynamic";

/**
 * Priority call list — active leads ordered by when they are due to be called.
 * Excludes won and not_relevant; every pipeline stage (including abandoned) is
 * included. Ordered by due_to_call_date ascending (overdue first, nulls last),
 * then enquiry_date ascending. Cards deep-link back with ?from=priority so
 * prev/next navigation follows this same order — the stage chips narrow the
 * list without disturbing it.
 */
export default async function PriorityLeadsPage() {
  const { user, customer } = await getCurrentCustomer();
  if (!user) redirect("/login");
  if (!customer) redirect("/dashboard");

  const assignments = await fetchOrderedAssignments(customer.id, "priority");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Priority call list</h1>
        <p className="text-sm text-muted-foreground">
          Your active leads in call order — soonest and overdue call-backs first.
        </p>
      </div>

      <PriorityLeadsList assignments={assignments} />
    </div>
  );
}
