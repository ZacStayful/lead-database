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
import { audienceLabel } from "@/lib/announcements";
import { formatDate } from "@/lib/utils";
import type { Announcement } from "@/lib/types";

export const dynamic = "force-dynamic";

const STATUS_STYLE: Record<string, string> = {
  draft: "border-transparent bg-gray-100 text-gray-700",
  sending: "border-transparent bg-amber-100 text-amber-800",
  sent: "border-transparent bg-green-100 text-green-800",
};

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  sending: "Sending",
  sent: "Sent",
};

/**
 * Admin list of announcements. Reads on the service role — the table has RLS on
 * with no policies at all, so nothing is readable from a browser, drafts least
 * of all.
 */
export default async function AdminAnnouncementsPage() {
  const admin = createAdminClient();
  const { data } = await admin
    .from("announcements")
    .select("*")
    .order("created_at", { ascending: false });

  const announcements = (data ?? []) as Announcement[];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Announcements</h1>
          <p className="text-sm text-muted-foreground">
            Written here, emailed to subscribers and shown on their dashboard.
            Drafts go nowhere until you send them.
          </p>
        </div>
        <Link
          href="/admin/announcements/new"
          className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-foreground transition-opacity hover:opacity-90"
        >
          New announcement
        </Link>
      </div>

      <div className="rounded-lg border-[0.5px] border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Audience</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Sent</TableHead>
              <TableHead className="text-right">Recipients</TableHead>
              <TableHead className="text-right">Open</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {announcements.map((a) => (
              <TableRow key={a.id}>
                <TableCell>
                  <span className="font-medium">{a.title}</span>
                  <span className="block text-sm text-muted-foreground">
                    {a.subject}
                  </span>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {audienceLabel(a.audience)}
                </TableCell>
                <TableCell>
                  <Badge className={STATUS_STYLE[a.status] ?? ""}>
                    {STATUS_LABEL[a.status] ?? a.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {a.sent_at ? formatDate(a.sent_at) : "—"}
                </TableCell>
                <TableCell className="text-right text-muted-foreground">
                  {a.recipient_count ?? "—"}
                </TableCell>
                <TableCell className="text-right">
                  <Link
                    href={`/admin/announcements/${a.id}`}
                    className="text-sm text-brand hover:underline"
                  >
                    {a.status === "sent" ? "View" : "Edit"}
                  </Link>
                </TableCell>
              </TableRow>
            ))}
            {announcements.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="py-10 text-center text-muted-foreground"
                >
                  No announcements yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Card>
        <CardContent className="pt-6 text-sm text-muted-foreground">
          A sent announcement cannot be edited or unsent, and the words on the
          dashboard banner are the words that were emailed. If something needs
          correcting, write a second announcement rather than changing the
          first. Customers can turn these emails off in their settings; they
          still see the banner, because the opt-out is about their inbox rather
          than about being kept informed.
        </CardContent>
      </Card>
    </div>
  );
}
