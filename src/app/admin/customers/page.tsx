import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import { computePacing, type PacingStatus } from "@/lib/pacing";
import type { Customer } from "@/lib/types";
import { AlertTriangle } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function AdminCustomersPage() {
  const admin = createAdminClient();
  const { data } = await admin
    .from("customers")
    .select("*")
    .order("created_at", { ascending: false });
  const customers = (data ?? []) as Customer[];

  // Precompute pacing once per customer.
  const rows = customers.map((c) => ({ customer: c, pacing: computePacing(c) }));

  // Supply-problem alerts: behind by 5+, fewer than 10 days left, still active.
  const alerts = rows.filter(
    ({ customer, pacing }) =>
      customer.is_active && pacing.deficit >= 5 && pacing.daysRemaining < 10
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Customers</h1>
        <p className="text-sm text-muted-foreground">
          {customers.length} customer{customers.length === 1 ? "" : "s"}
        </p>
      </div>

      {alerts.length > 0 && (
        <div className="rounded-lg border-[0.5px] border-amber-300 bg-amber-50 p-4">
          <div className="flex items-center gap-2 text-amber-800">
            <AlertTriangle className="h-4 w-4" />
            <p className="text-sm font-semibold">
              Potential supply problem — {alerts.length} customer
              {alerts.length === 1 ? "" : "s"} at risk of missing allocation
            </p>
          </div>
          <ul className="mt-2 space-y-1 text-sm text-amber-800">
            {alerts.map(({ customer, pacing }) => (
              <li key={customer.id}>
                <span className="font-medium">{customer.business_name}</span> —{" "}
                {customer.leads_received_this_month} received vs{" "}
                {pacing.expected} expected, {pacing.daysRemaining} day
                {pacing.daysRemaining === 1 ? "" : "s"} remaining
              </li>
            ))}
          </ul>
        </div>
      )}
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Business</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Leads</TableHead>
              <TableHead>Pacing</TableHead>
              <TableHead>Last lead</TableHead>
              <TableHead className="text-right">Edit</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ customer: c, pacing }) => (
              <TableRow key={c.id}>
                <TableCell className="font-medium">{c.business_name}</TableCell>
                <TableCell className="text-muted-foreground">{c.email}</TableCell>
                <TableCell>
                  <Badge
                    variant={
                      c.subscription_status === "active" ? "brand" : "muted"
                    }
                  >
                    {c.subscription_status}
                  </Badge>
                </TableCell>
                <TableCell>
                  {c.leads_received_this_month} / {c.monthly_allocation}
                </TableCell>
                <TableCell>
                  <PacingBadge status={pacing.status} />
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {c.last_assignment_at ? formatDate(c.last_assignment_at) : "—"}
                </TableCell>
                <TableCell className="text-right">
                  <Link
                    href={`/admin/customers/${c.id}`}
                    className="text-brand hover:underline"
                  >
                    Edit
                  </Link>
                </TableCell>
              </TableRow>
            ))}
            {customers.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className="py-10 text-center text-muted-foreground"
                >
                  No customers yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

function PacingBadge({ status }: { status: PacingStatus }) {
  if (status === "behind") {
    return (
      <span className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800">
        Behind
      </span>
    );
  }
  if (status === "ahead") {
    return (
      <span className="inline-flex items-center rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
        Ahead
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-brand/10 px-2.5 py-0.5 text-xs font-medium text-brand">
      On track
    </span>
  );
}
