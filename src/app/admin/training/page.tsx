import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import type { TrainingModule } from "@/lib/types";

export const dynamic = "force-dynamic";

const SCOPE_LABEL: Record<string, string> = {
  both: "Both",
  management: "Management",
  guaranteed_rent: "Guaranteed Rent",
};

const TYPE_LABEL: Record<string, string> = {
  video: "Video",
  audio: "Audio",
  article: "Article",
};

/**
 * Admin list of training modules. Reads on the service role so drafts are
 * visible — the table's RLS policy only exposes published rows, and this page
 * exists to work on the ones that are not.
 */
export default async function AdminTrainingPage() {
  const admin = createAdminClient();
  const { data } = await admin
    .from("training_modules")
    .select("*")
    .order("sort_order", { ascending: true });

  const modules = (data ?? []) as TrainingModule[];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Training</h1>
          <p className="text-sm text-muted-foreground">
            Modules shown to every subscriber. Drafts are invisible until
            published.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/admin/training/case-studies"
            className="rounded-md border-[0.5px] border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent"
          >
            Case studies
          </Link>
          <Link
            href="/admin/training/new"
            className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-foreground transition-opacity hover:opacity-90"
          >
            New module
          </Link>
        </div>
      </div>

      <div className="rounded-lg border-[0.5px] border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Order</TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Applies to</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Edit</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {modules.map((m) => (
              <TableRow key={m.id}>
                <TableCell className="text-muted-foreground">
                  {m.sort_order}
                </TableCell>
                <TableCell>
                  <span className="font-medium">{m.title}</span>
                  <span className="block text-sm text-muted-foreground">
                    {m.slug}
                  </span>
                </TableCell>
                <TableCell>
                  <Badge className="border-transparent bg-gray-100 text-gray-700">
                    {TYPE_LABEL[m.content_type] ?? m.content_type}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {SCOPE_LABEL[m.lead_type_scope] ?? m.lead_type_scope}
                </TableCell>
                <TableCell>
                  {m.is_published ? (
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
                    href={`/admin/training/${m.id}`}
                    className="text-sm text-brand hover:underline"
                  >
                    Edit
                  </Link>
                </TableCell>
              </TableRow>
            ))}
            {modules.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="py-10 text-center text-muted-foreground"
                >
                  No modules yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Card>
        <CardContent className="pt-6 text-sm text-muted-foreground">
          Recordings are stored privately and played through short-lived signed
          links, so they are only reachable by a signed-in subscriber. Before
          publishing a real call, make sure the people on it were told the call
          was recorded and could be used this way.
        </CardContent>
      </Card>
    </div>
  );
}
