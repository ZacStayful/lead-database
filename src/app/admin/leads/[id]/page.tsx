import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AdminLeadControls } from "@/components/admin/AdminLeadControls";
import { formatDate, enquiryDateWithAge } from "@/lib/utils";
import { statusBadge } from "@/components/dashboard/leadStatus";
import {
  pipelineBadgeClass,
  pipelineLabel,
} from "@/components/dashboard/pipelineStage";
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
    .select(
      "id, assigned_at, customer_id, status, pipeline_stage, rejection_reason, quality_claim_id, customers(id, business_name, email)"
    )
    .eq("lead_id", lead.id);

  const assignments = (assignmentsRaw ?? []) as unknown as {
    id: string;
    assigned_at: string;
    customer_id: string;
    status: string;
    pipeline_stage: string;
    rejection_reason: string | null;
    quality_claim_id: string | null;
    customers: { id: string; business_name: string; email: string } | null;
  }[];

  // Every operator's view of this lead in one place. Rejections and quality
  // claims existed in the database from 0021 onward but were never surfaced to
  // admin, so a lead that three operators had all written off looked identical
  // to one nobody had touched.
  const { data: claimsRaw } = await admin
    .from("lead_quality_claims")
    .select("id, lead_assignment_id, reason, status, detail, created_at")
    .eq("lead_id", lead.id);
  const claimByAssignment = new Map(
    ((claimsRaw ?? []) as {
      id: string;
      lead_assignment_id: string;
      reason: string;
      status: string;
      detail: string;
      created_at: string;
    }[]).map((c) => [c.lead_assignment_id, c])
  );
  const assignedIds = new Set(assignments.map((a) => a.customer_id));

  const { data: customersRaw } = await admin
    .from("customers")
    .select("*")
    .eq("is_active", true)
    .order("business_name");
  // Only offer customers subscribed to this lead's product, so a GR lead is
  // never force-assigned to a management-only customer (and vice-versa).
  const isGuaranteedRent = lead.lead_type === "guaranteed_rent";
  const availableCustomers = ((customersRaw ?? []) as Customer[])
    .filter((c) => !assignedIds.has(c.id))
    .filter((c) =>
      isGuaranteedRent
        ? c.gr_subscription_status === "active"
        : c.subscription_status === "active"
    )
    .map((c) => ({ id: c.id, business_name: c.business_name }));

  const fields: [string, string | null][] = [
    ["Lead name", lead.lead_name],
    [
      "Lead type",
      lead.lead_type === "guaranteed_rent" ? "Guaranteed Rent" : "Management",
    ],
    ["Email", lead.email],
    ["Phone", lead.phone],
    ["Address", lead.address],
    ["Bedrooms", lead.bedrooms],
    ["Lead profile", lead.lead_profile],
    ["Enquiry date", enquiryDateWithAge(lead.enquiry_date)],
    ["Ingested", formatDate(lead.created_at)],
    [
      "Quality flag",
      lead.quality_flag === "dead"
        ? "Dead — every operator wrote it off, never reassigned"
        : lead.quality_flag === "suspect"
          ? "Suspect — at least one operator reported it dead"
          : null,
    ],
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
                    {assignments.map((a) => {
                      const claim = claimByAssignment.get(a.id);
                      return (
                        <li
                          key={a.id}
                          className="rounded-md border-[0.5px] border-border px-3 py-2 text-sm"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <span className="font-medium">
                              {a.customers?.business_name ?? "Unknown"}
                            </span>
                            <span className="text-muted-foreground">
                              {formatDate(a.assigned_at)}
                            </span>
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-2">
                            <Badge className={statusBadge(a.status).className}>
                              {statusBadge(a.status).label}
                            </Badge>
                            <Badge className={pipelineBadgeClass(a.pipeline_stage)}>
                              {pipelineLabel(a.pipeline_stage)}
                            </Badge>
                            {a.rejection_reason && (
                              <Badge variant="secondary">
                                {a.rejection_reason.replace(/_/g, " ")}
                              </Badge>
                            )}
                            {claim && (
                              <Badge variant="secondary">
                                claim: {claim.status.replace(/_/g, " ")}
                              </Badge>
                            )}
                          </div>
                          {claim?.detail && (
                            <p className="mt-1.5 text-xs text-muted-foreground">
                              &ldquo;{claim.detail}&rdquo;
                            </p>
                          )}
                        </li>
                      );
                    })}
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
                leadType={lead.lead_type}
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
