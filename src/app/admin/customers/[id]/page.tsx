import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { AdminCustomerForm } from "@/components/admin/AdminCustomerForm";
import { formatDate } from "@/lib/utils";
import { cityForArea } from "@/lib/postcode";
import { computePacing, computeGrPacing } from "@/lib/pacing";
import { Download } from "lucide-react";
import type { AssignmentWithLead, Customer } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function AdminCustomerDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const admin = createAdminClient();
  const { data: customerRaw } = await admin
    .from("customers")
    .select("*")
    .eq("id", params.id)
    .maybeSingle();

  if (!customerRaw) notFound();
  const customer = customerRaw as Customer;

  const { data: assignmentsRaw } = await admin
    .from("lead_assignments")
    .select("*, lead:leads(*)")
    .eq("customer_id", customer.id)
    .order("assigned_at", { ascending: false });
  const assignments = (assignmentsRaw ?? []) as AssignmentWithLead[];

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/customers"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← Back to customers
        </Link>
        <h1 className="mt-2 text-2xl font-bold">{customer.business_name}</h1>
        <p className="text-sm text-muted-foreground">
          {customer.contact_name} · {customer.email}
          {customer.phone ? ` · ${customer.phone}` : ""}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Plan: <span className="font-medium text-foreground">{customer.monthly_allocation} leads / month</span>
          {customer.website_url ? (
            <>
              {" · "}
              <a
                href={customer.website_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-brand hover:underline"
              >
                {customer.website_url}
              </a>
            </>
          ) : null}
          {customer.properties_managed
            ? ` · Manages ${customer.properties_managed} properties`
            : ""}
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-1 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Manage account</CardTitle>
            </CardHeader>
            <CardContent>
              <AdminCustomerForm customer={customer} />
            </CardContent>
          </Card>

          <GrSubscriptionCard customer={customer} />

          <FilterCard customer={customer} />
        </div>

        <div className="lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Leads assigned ({assignments.length})</CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-6">Lead</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Received</TableHead>
                    <TableHead>Email</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {assignments.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell className="pl-6 font-medium">
                        {a.lead?.lead_name}
                      </TableCell>
                      <TableCell>
                        {a.viewed_at ? (
                          <Badge variant="muted">Viewed</Badge>
                        ) : (
                          <Badge variant="brand">New</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatDate(a.assigned_at)}
                      </TableCell>
                      <TableCell>
                        {a.email_sent ? (
                          <Badge variant="brand">Sent</Badge>
                        ) : (
                          <Badge className="border-transparent bg-red-100 text-red-700">
                            Not sent
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {assignments.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={4}
                        className="py-10 text-center text-muted-foreground"
                      >
                        No leads assigned yet.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function bedroomPhrase(min: number | null, max: number | null): string {
  if (min == null && max == null) return "Any";
  if (min != null && max != null) {
    return min === max ? `Exactly ${min}` : `${min}–${max}`;
  }
  if (min != null) return `${min}+`;
  return `Up to ${max}`;
}

/**
 * Admin-only view of a customer's lead filter(s), including the internal
 * priority_score (the deficit-formula value used to rank filtered candidates).
 * Never shown to the customer.
 */
function FilterCard({ customer }: { customer: Customer }) {
  const filtered = (s: string | null | undefined) =>
    s === "active" || s === "pending_lift";

  const products: {
    label: string;
    status: string;
    areas: string[] | null;
    min: number | null;
    max: number | null;
    liftDate: string | null;
    priority: number;
  }[] = [];

  if (filtered(customer.filter_status)) {
    products.push({
      label: "Management",
      status: customer.filter_status,
      areas: customer.filter_areas,
      min: customer.filter_min_bedrooms,
      max: customer.filter_max_bedrooms,
      liftDate: customer.filter_lift_effective_date,
      priority: computePacing(customer).deficit,
    });
  }
  if (filtered(customer.gr_filter_status)) {
    products.push({
      label: "Guaranteed Rent",
      status: customer.gr_filter_status,
      areas: customer.gr_filter_areas,
      min: customer.gr_filter_min_bedrooms,
      max: customer.gr_filter_max_bedrooms,
      liftDate: customer.gr_filter_lift_effective_date,
      priority: computeGrPacing(customer).deficit,
    });
  }

  if (products.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Lead filter</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {products.map((p) => (
          <div key={p.label} className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">{p.label}</span>
              <Badge variant={p.status === "active" ? "brand" : "muted"}>
                {p.status === "pending_lift" ? "Lift scheduled" : "Active"}
              </Badge>
            </div>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Areas</dt>
                <dd className="mt-0.5 font-medium">
                  {p.areas && p.areas.length > 0
                    ? p.areas.map((a) => cityForArea(a) || a).join(", ")
                    : "Any"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Bedrooms</dt>
                <dd className="mt-0.5 font-medium">
                  {bedroomPhrase(p.min, p.max)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">
                  Priority score
                </dt>
                <dd className="mt-0.5 font-medium">{p.priority}</dd>
              </div>
              {p.status === "pending_lift" && p.liftDate && (
                <div>
                  <dt className="text-xs text-muted-foreground">Lifts on</dt>
                  <dd className="mt-0.5 font-medium">
                    {formatDate(p.liftDate)}
                  </dd>
                </div>
              )}
            </dl>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function GrSubscriptionCard({ customer }: { customer: Customer }) {
  const active = customer.gr_subscription_status === "active";
  const pacing = computeGrPacing(customer);
  const pacingLabel =
    pacing.status === "behind"
      ? "Behind"
      : pacing.status === "ahead"
        ? "Ahead"
        : "On track";
  const pacingClass =
    pacing.status === "behind"
      ? "bg-amber-100 text-amber-800"
      : pacing.status === "ahead"
        ? "bg-muted text-muted-foreground"
        : "bg-brand/10 text-brand";

  return (
    <Card className={active ? undefined : "opacity-60"}>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>Guaranteed Rent</CardTitle>
          {active ? (
            <Badge variant="brand">Active</Badge>
          ) : (
            <Badge variant="muted">No GR subscription</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {active ? (
          <dl className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">This month</dt>
              <dd className="mt-0.5 font-medium">
                {customer.gr_leads_received_this_month} /{" "}
                {customer.gr_monthly_allocation}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Lead balance</dt>
              <dd className="mt-0.5 font-medium">
                {customer.gr_lead_balance} credit
                {customer.gr_lead_balance === 1 ? "" : "s"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Pacing</dt>
              <dd className="mt-0.5">
                <span
                  className={
                    "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium " +
                    pacingClass
                  }
                >
                  {pacingLabel}
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Last GR lead</dt>
              <dd className="mt-0.5 font-medium">
                {customer.gr_last_assignment_at
                  ? formatDate(customer.gr_last_assignment_at)
                  : "—"}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">
            This customer has no active Guaranteed Rent subscription.
          </p>
        )}

        <div className="mt-4 border-t border-border pt-4">
          <a
            href="/company-let-tenancy-agreement.docx"
            download
            className="inline-flex items-center gap-2 text-sm font-medium text-brand hover:underline"
          >
            <Download className="h-4 w-4" />
            Download company let agreement
          </a>
        </div>
      </CardContent>
    </Card>
  );
}
