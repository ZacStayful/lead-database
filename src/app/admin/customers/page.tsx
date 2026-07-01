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
import type { Customer } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function AdminCustomersPage() {
  const admin = createAdminClient();
  const { data } = await admin
    .from("customers")
    .select("*")
    .order("created_at", { ascending: false });
  const customers = (data ?? []) as Customer[];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Customers</h1>
        <p className="text-sm text-muted-foreground">
          {customers.length} customer{customers.length === 1 ? "" : "s"}
        </p>
      </div>
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Business</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Leads</TableHead>
              <TableHead>Overflow</TableHead>
              <TableHead>Last lead</TableHead>
              <TableHead className="text-right">Edit</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {customers.map((c) => (
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
                  {c.overflow_enabled ? (
                    <Badge variant="outline">On</Badge>
                  ) : (
                    <span className="text-muted-foreground">Off</span>
                  )}
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
