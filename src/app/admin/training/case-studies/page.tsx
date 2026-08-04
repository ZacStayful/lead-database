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
import { Badge } from "@/components/ui/badge";
import { GATE_LABEL, LOSS_REASON_LABEL, OUTCOME_LABEL } from "@/lib/caseStudies";
import type { CaseStudy } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function AdminCaseStudiesPage() {
  const admin = createAdminClient();

  const { data } = await admin
    .from("case_studies")
    .select("*")
    .order("sort_order", { ascending: true });

  const cases = (data ?? []) as CaseStudy[];

  // One grouped count rather than a query per row.
  const { data: eventRows } = await admin
    .from("case_study_events")
    .select("case_study_id");

  const eventCounts = new Map<string, number>();
  for (const row of eventRows ?? []) {
    const id = row.case_study_id as string;
    eventCounts.set(id, (eventCounts.get(id) ?? 0) + 1);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link
            href="/admin/training"
            className="text-sm text-muted-foreground hover:underline"
          >
            Back to training
          </Link>
          <h1 className="mt-2 text-2xl font-bold">Case studies</h1>
          <p className="text-sm text-muted-foreground">
            Anonymised lead journeys. Drafts are invisible to subscribers until
            published.
          </p>
        </div>
        <Link
          href="/admin/training/case-studies/new"
          className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-foreground transition-opacity hover:opacity-90"
        >
          New case study
        </Link>
      </div>

      <div className="rounded-lg border-[0.5px] border-border bg-card">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Order</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead className="text-right">Days</TableHead>
                <TableHead>Gate</TableHead>
                <TableHead className="text-right">Events</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Edit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cases.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="text-muted-foreground">
                    {c.sort_order}
                  </TableCell>
                  <TableCell>
                    <span className="font-medium">{c.reference}</span>
                    <span className="block text-sm text-muted-foreground">
                      {c.property_summary}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge
                      className={
                        c.outcome === "signed"
                          ? "border-transparent bg-green-100 text-green-700"
                          : "border-transparent bg-gray-100 text-gray-600"
                      }
                    >
                      {OUTCOME_LABEL[c.outcome]}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {c.loss_reason ? LOSS_REASON_LABEL[c.loss_reason] : "—"}
                  </TableCell>
                  <TableCell className="text-right">{c.days_to_outcome}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {GATE_LABEL[c.gate_reached]}
                  </TableCell>
                  <TableCell className="text-right">
                    {eventCounts.get(c.id) ?? 0}
                  </TableCell>
                  <TableCell>
                    {c.is_published ? (
                      <Badge className="border-transparent bg-green-100 text-green-700">
                        Published
                      </Badge>
                    ) : (
                      <Badge className="border-transparent bg-amber-100 text-amber-700">
                        Draft
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Link
                      href={`/admin/training/case-studies/${c.id}`}
                      className="text-sm text-brand hover:underline"
                    >
                      Edit
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
              {cases.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={9}
                    className="py-10 text-center text-muted-foreground"
                  >
                    No case studies yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
