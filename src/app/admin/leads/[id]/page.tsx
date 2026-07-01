import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AdminLeadControls } from "@/components/admin/AdminLeadControls";
import { formatDate } from "@/lib/utils";
import type { Customer, Lead } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function AdminLeadDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const admin = createAdminClient();

  const { data: leadRaw } = await admin
    .from("leads")
    .select("*")
    .eq("id", params.id)
    .maybeSingle();

  if (!leadRaw) notFound();
  const lead = leadRaw as Lead;

  const { data: assignmentsRaw } = await admin
    .from("lead_assignments")
    .select("id, assigned_at, customer_id, customers(id, business_name, email)")
    .eq("lead_id", lead.id);

  const assignments = (assignmentsRaw ?? []) as unknown as {
    id: string;
    assigned_at: string;
    customer_id: string;
    customers: { id: string; business_name: string; email: string } | null;
  }[];
  const assignedIds = new Set(assignments.map((a) => a.customer_id));

  const { data: customersRaw } = await admin
    .from("customers")
    .select("*")
    .eq("is_active", true)
    .order("business_name");
  const availableCustomers = ((customersRaw ?? []) as Customer[])
    .filter((c) => !assignedIds.has(c.id))
    .map((c) => ({ id: c.id, business_name: c.business_name }));

  const fields: [string, string | null][] = [
    ["Lead name", lead.lead_name],
    ["Email", lead.email],
    ["Phone", lead.phone],
    ["Address", lead.address],
    ["Bedrooms", lead.bedrooms],
    ["Estimated monthly income", lead.estimated_monthly_income],
    ["Lead profile", lead.lead_profile],
    ["Enquiry date", lead.enquiry_date],
    ["Monday item ID", lead.monday_item_id],
    ["Ingested", formatDate(lead.created_at)],
  ];

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/leads"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← Back to leads
        </Link>
        <div className="mt-2 flex items-center gap-3">
          <h1 className="text-2xl font-bold">{lead.lead_name}</h1>
          <Badge
            variant={
              lead.assignment_count >= lead.max_assignments ? "muted" : "brand"
            }
          >
            {lead.assignment_count} / {lead.max_assignments} assigned
          </Badge>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Lead details</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
                {fields.map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-xs text-muted-foreground">{label}</dt>
                    <dd className="mt-0.5 text-sm">{value || "—"}</dd>
                  </div>
                ))}
              </dl>

              <div className="mt-6">
                <h3 className="mb-2 text-sm font-medium">Recipients</h3>
                {assignments.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Not yet assigned to any customer.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {assignments.map((a) => (
                      <li
                        key={a.id}
                        className="flex items-center justify-between rounded-md border-[0.5px] border-border px-3 py-2 text-sm"
                      >
                        <span className="font-medium">
                          {a.customers?.business_name ?? "Unknown"}
                        </span>
                        <span className="text-muted-foreground">
                          {formatDate(a.assigned_at)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="lg:col-span-1">
          <Card>
            <CardHeader>
              <CardTitle>Override controls</CardTitle>
            </CardHeader>
            <CardContent>
              <AdminLeadControls
                leadId={lead.id}
                maxAssignments={lead.max_assignments}
                assignmentCount={lead.assignment_count}
                customers={availableCustomers}
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
