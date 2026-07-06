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
        <div className="lg:col-span-1">
          <Card>
            <CardHeader>
              <CardTitle>Manage account</CardTitle>
            </CardHeader>
            <CardContent>
              <AdminCustomerForm customer={customer} />
            </CardContent>
          </Card>
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
                    </TableRow>
                  ))}
                  {assignments.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={3}
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
