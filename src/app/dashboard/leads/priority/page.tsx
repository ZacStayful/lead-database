import { redirect } from "next/navigation";
import { viewerScopedLead } from "@/lib/customerLeads";
import { getCurrentCustomer } from "@/lib/auth";
import { fetchOrderedAssignments } from "@/lib/leadOrder";
import { PriorityLeadsList } from "@/components/dashboard/PriorityLeadsList";

export const dynamic = "force-dynamic";

/**
 * Priority call list — active leads ordered by when they are due to be called.
 * Excludes won and not_relevant; every pipeline stage (including abandoned) is
 * included. Ordered by due_to_call_date ascending (overdue first, nulls last),
 * then assigned_at ascending. Cards deep-link back with ?from=priority so
 * prev/next navigation follows this same order — the stage chips narrow the
 * list without disturbing it.
 */
export default async function PriorityLeadsPage() {
  const { user, customer } = await getCurrentCustomer();
  if (!user) redirect("/login");
  if (!customer) redirect("/dashboard");

  // Scoped to this viewer, as on the feed and the detail page: a lead sold on
  // from another operator carries THEIR customer id, which is not the buyer's
  // to see (§32.8).
  const assignments = (await fetchOrderedAssignments(customer.id, "priority")).map(
    (a) => ({ ...a, lead: viewerScopedLead(a.lead, customer.id) })
  ) as Awaited<ReturnType<typeof fetchOrderedAssignments>>;

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
