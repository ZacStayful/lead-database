import { createAdminClient } from "@/lib/supabase/admin";
import { SyncMondayButton } from "@/components/admin/SyncMondayButton";
import {
  AdminLeadsTable,
  type LeadRow,
  type CustomerRow,
} from "@/components/admin/AdminLeadsTable";

export const dynamic = "force-dynamic";

interface LeadQueryRow {
  id: string;
  lead_name: string;
  lead_type: string;
  address: string | null;
  assignment_count: number;
  max_assignments: number;
  created_at: string;
  lead_assignments: {
    customers: { business_name: string } | null;
  }[];
}

export default async function AdminLeadsPage() {
  const admin = createAdminClient();
  const { data } = await admin
    .from("leads")
    .select(
      "id, lead_name, lead_type, address, assignment_count, max_assignments, created_at, lead_assignments(customers(business_name))"
    )
    .order("created_at", { ascending: false });

  const rawLeads = (data ?? []) as unknown as LeadQueryRow[];
  const leads: LeadRow[] = rawLeads.map((l) => ({
    id: l.id,
    lead_name: l.lead_name,
    lead_type: l.lead_type,
    address: l.address,
    assignment_count: l.assignment_count,
    max_assignments: l.max_assignments,
    created_at: l.created_at,
    recipients: l.lead_assignments
      .map((a) => a.customers?.business_name)
      .filter((n): n is string => Boolean(n)),
  }));

  const pendingCount = leads.filter(
    (l) => l.assignment_count < l.max_assignments
  ).length;
  const unassignedCount = leads.filter((l) => l.assignment_count === 0).length;

  // Approved (real) customers — the pool the bulk assigner offers, with their
  // per-product credit counts for context.
  const { data: custRaw } = await admin
    .from("customers")
    .select(
      "id, business_name, is_active, account_status, subscription_status, lead_balance, gr_subscription_status, gr_lead_balance"
    )
    .eq("account_status", "active")
    .order("business_name");
  const custs = (custRaw ?? []) as (CustomerRow & {
    is_active: boolean;
    account_status: string;
  })[];
  const customers: CustomerRow[] = custs.map((c) => ({
    id: c.id,
    business_name: c.business_name,
    lead_balance: c.lead_balance,
    gr_lead_balance: c.gr_lead_balance,
    subscription_status: c.subscription_status,
    gr_subscription_status: c.gr_subscription_status,
  }));

  // Why leads aren't assigning: assignment is gated on paid credits, so surface
  // how many eligible buyers / credits exist per pool. When a pool has none, its
  // leads simply can't auto-assign — that's the answer, not a bug.
  const mgmt = custs.filter(
    (c) => c.subscription_status === "active" && c.lead_balance > 0
  );
  const gr = custs.filter(
    (c) => c.gr_subscription_status === "active" && c.gr_lead_balance > 0
  );
  const pools = [
    {
      label: "Management",
      buyers: mgmt.length,
      credits: mgmt.reduce((s, c) => s + c.lead_balance, 0),
      waiting: leads.filter(
        (l) =>
          l.lead_type !== "guaranteed_rent" &&
          l.assignment_count < l.max_assignments
      ).length,
    },
    {
      label: "Guaranteed Rent",
      buyers: gr.length,
      credits: gr.reduce((s, c) => s + c.gr_lead_balance, 0),
      waiting: leads.filter(
        (l) =>
          l.lead_type === "guaranteed_rent" &&
          l.assignment_count < l.max_assignments
      ).length,
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Leads</h1>
          <p className="text-sm text-muted-foreground">
            {leads.length} lead{leads.length === 1 ? "" : "s"} ingested
            {pendingCount > 0 && (
              <>
                {" · "}
                <span className="font-medium text-foreground">
                  {pendingCount} awaiting assignment
                </span>
                {unassignedCount > 0 && ` (${unassignedCount} with none yet)`}
              </>
            )}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Tick leads below, then choose who receives them — old leads stay put
            unless you pick them.
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <SyncMondayButton />
          <SyncMondayButton
            endpoint="/api/monday/sync-gr"
            label="Sync GR from Monday"
          />
        </div>
      </div>

      {/* Why leads aren't assigning: assignment needs a buyer with paid credits. */}
      <div className="grid gap-3 sm:grid-cols-2">
        {pools.map((p) => {
          const blocked = p.waiting > 0 && p.credits === 0;
          return (
            <div
              key={p.label}
              className={
                "rounded-lg border-[0.5px] p-4 " +
                (blocked
                  ? "border-amber-300 bg-amber-50"
                  : "border-border bg-card")
              }
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{p.label}</span>
                <span className="text-xs text-muted-foreground">
                  {p.waiting} awaiting
                </span>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                <span className="font-medium text-foreground">
                  {p.buyers} buyer{p.buyers === 1 ? "" : "s"}
                </span>{" "}
                with credits · {p.credits} credit
                {p.credits === 1 ? "" : "s"} available
              </p>
              {blocked && (
                <p className="mt-1 text-xs text-amber-700">
                  No one can receive these automatically — select them below and
                  assign with “Override credit limit”, or add a paying {p.label}{" "}
                  buyer.
                </p>
              )}
            </div>
          );
        })}
      </div>

      <AdminLeadsTable leads={leads} customers={customers} />
    </div>
  );
}
