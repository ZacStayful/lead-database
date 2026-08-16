import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AdminAnnouncementForm } from "@/components/admin/AdminAnnouncementForm";
import {
  audienceCounts,
  fetchAnnouncementCandidates,
} from "@/lib/announcements";

export const dynamic = "force-dynamic";

/**
 * The recipient counts are resolved here, server-side, from one query — the
 * same resolver the send route uses. Passing three real numbers into the form
 * is what lets each audience button carry its own count without an endpoint for
 * the browser to poll, and guarantees the number beside the button is the
 * number that would actually be emailed.
 */
export default async function NewAnnouncementPage() {
  const admin = createAdminClient();
  const { rows } = await fetchAnnouncementCandidates(admin);
  const counts = audienceCounts(rows);

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/announcements"
          className="text-sm text-muted-foreground hover:underline"
        >
          ← Back to announcements
        </Link>
        <h1 className="mt-2 text-2xl font-bold">New announcement</h1>
        <p className="text-sm text-muted-foreground">
          Saved as a draft. Nothing is sent until you open it and confirm.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Write it</CardTitle>
        </CardHeader>
        <CardContent>
          <AdminAnnouncementForm counts={counts} />
        </CardContent>
      </Card>
    </div>
  );
}
