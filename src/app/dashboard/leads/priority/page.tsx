import { redirect } from "next/navigation";
import { getCurrentCustomer } from "@/lib/auth";
import { fetchOrderedAssignments } from "@/lib/leadOrder";
import { LeadCard } from "@/components/dashboard/LeadCard";

export const dynamic = "force-dynamic";

/**
 * Priority call list — active leads ordered by when they are due to be called.
 * Excludes won and not_relevant; every pipeline stage (including abandoned) is
 * included. Ordered by due_to_call_date ascending (overdue first, nulls last),
 * then enquiry_date ascending. Cards deep-link back with ?from=priority so
 * prev/next navigation follows this same order.
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

      {assignments.length === 0 ? (
        <div className="rounded-lg border-[0.5px] border-dashed border-border p-12 text-center text-muted-foreground">
          No active leads to call right now.
        </div>
      ) : (
        <div className="space-y-3">
          {assignments.map((a) => (
            <LeadCard key={a.id} assignment={a} from="priority" />
          ))}
        </div>
      )}
    </div>
  );
}
