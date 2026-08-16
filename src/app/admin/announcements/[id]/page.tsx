import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { getUser } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AdminAnnouncementForm } from "@/components/admin/AdminAnnouncementForm";
import { AnnouncementSendPanel } from "@/components/admin/AnnouncementSendPanel";
import {
  audienceCounts,
  audienceLabel,
  fetchAnnouncementCandidates,
  splitRecipients,
} from "@/lib/announcements";
import { formatDate } from "@/lib/utils";
import type { Announcement, AnnouncementDelivery } from "@/lib/types";

export const dynamic = "force-dynamic";

type DeliveryRow = AnnouncementDelivery & {
  customer: { business_name: string | null } | null;
};

export default async function AnnouncementPage({
  params,
}: {
  params: { id: string };
}) {
  const admin = createAdminClient();

  const { data } = await admin
    .from("announcements")
    .select("*")
    .eq("id", params.id)
    .maybeSingle();

  const announcement = data as Announcement | null;
  if (!announcement) notFound();

  const [{ rows: candidates }, user, { data: deliveryRows }] = await Promise.all(
    [
      fetchAnnouncementCandidates(admin),
      getUser(),
      admin
        .from("announcement_deliveries")
        .select("*, customer:customers(business_name)")
        .eq("announcement_id", params.id)
        .order("sent_at", { ascending: true }),
    ]
  );

  const counts = audienceCounts(candidates);
  const { emailable, optedOut } = splitRecipients(
    announcement.audience,
    candidates
  );
  const deliveries = (deliveryRows ?? []) as DeliveryRow[];
  const failures = deliveries.filter((d) => d.error);

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/announcements"
          className="text-sm text-muted-foreground hover:underline"
        >
          ← Back to announcements
        </Link>
        <h1 className="mt-2 text-2xl font-bold">{announcement.title}</h1>
        <p className="text-sm text-muted-foreground">
          {audienceLabel(announcement.audience)} ·{" "}
          {announcement.status === "sent"
            ? `sent ${announcement.sent_at ? formatDate(announcement.sent_at) : ""}`
            : "draft"}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {announcement.status === "sent" ? "What was sent" : "Write it"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <AdminAnnouncementForm announcement={announcement} counts={counts} />
        </CardContent>
      </Card>

      <AnnouncementSendPanel
        announcement={announcement}
        recipientCount={emailable.length}
        optedOutCount={optedOut.length}
        adminEmail={user?.email ?? null}
      />

      {deliveries.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-medium">
            Delivery log
            {failures.length > 0 && (
              <span className="ml-2 text-red-700">
                {failures.length} failed
              </span>
            )}
          </h2>
          <div className="rounded-lg border-[0.5px] border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Customer</TableHead>
                  <TableHead>Address</TableHead>
                  <TableHead>Sent</TableHead>
                  <TableHead>Result</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {deliveries.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="font-medium">
                      {d.customer?.business_name ?? "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {d.email}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(d.sent_at)}
                    </TableCell>
                    <TableCell
                      className={
                        d.error ? "text-red-700" : "text-muted-foreground"
                      }
                    >
                      {d.error ?? "Delivered"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <p className="text-xs text-muted-foreground">
            A row exists for everyone this announcement was attempted for, which
            is what stops a second send reaching them twice. A failed row is
            worth chasing by hand; it will not be retried automatically.
          </p>
        </div>
      )}
    </div>
  );
}
