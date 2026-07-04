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
import { SyncMondayButton } from "@/components/admin/SyncMondayButton";
import { formatDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

interface LeadRow {
  id: string;
  lead_name: string;
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
      "id, lead_name, address, assignment_count, max_assignments, created_at, lead_assignments(customers(business_name))"
    )
    .order("created_at", { ascending: false });

  const leads = (data ?? []) as unknown as LeadRow[];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Leads</h1>
          <p className="text-sm text-muted-foreground">
            {leads.length} lead{leads.length === 1 ? "" : "s"} ingested
          </p>
        </div>
        <SyncMondayButton />
      </div>
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Lead</TableHead>
              <TableHead>Address</TableHead>
              <TableHead>Assigned</TableHead>
              <TableHead>Recipients</TableHead>
              <TableHead>Received</TableHead>
              <TableHead className="text-right">View</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {leads.map((l) => {
              const recipients = l.lead_assignments
                .map((a) => a.customers?.business_name)
                .filter(Boolean);
              const full = l.assignment_count >= l.max_assignments;
              return (
                <TableRow key={l.id}>
                  <TableCell className="font-medium">{l.lead_name}</TableCell>
                  <TableCell className="max-w-[220px] truncate text-muted-foreground">
                    {l.address ?? "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={full ? "muted" : "brand"}>
                      {l.assignment_count} / {l.max_assignments}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-[200px] truncate text-muted-foreground">
                    {recipients.length ? recipients.join(", ") : "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(l.created_at)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Link
                      href={`/admin/leads/${l.id}`}
                      className="text-brand hover:underline"
                    >
                      View
                    </Link>
                  </TableCell>
                </TableRow>
              );
            })}
            {leads.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="py-10 text-center text-muted-foreground"
                >
                  No leads yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
