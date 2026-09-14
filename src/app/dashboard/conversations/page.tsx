import { redirect } from "next/navigation";
import { MessageCircle } from "lucide-react";
import { getCurrentCustomer, isAdminUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchInboxRows } from "@/lib/messaging/inbox";
import { enabledChannels } from "@/lib/messaging/service";
import { toInboxListRows } from "@/lib/conversations/inboxRows";
import { InboxList } from "@/components/conversations/InboxList";

export const dynamic = "force-dynamic";

/**
 * The inbox with nothing selected (§56.7). The rows come from
 * `fetchInboxRows` on the server — the full assignment never reaches the
 * browser, only the list shape.
 */
export default async function ConversationsPage() {
  const { user, customer } = await getCurrentCustomer();
  if (!user) redirect("/login");
  if (!customer) redirect("/dashboard");

  const admin = createAdminClient();
  const [inbox, channels] = await Promise.all([
    fetchInboxRows(admin, customer.id),
    enabledChannels(admin, isAdminUser(user)),
  ]);
  const rows = toInboxListRows(inbox.rows);

  return (
    <>
      <div className="flex min-h-0 w-full flex-shrink-0 flex-col lg:w-[clamp(260px,32%,360px)]">
        <InboxList rows={rows} selectedLeadId={null} emailEnabled={channels.includes("email")} />
      </div>
      <div className="hidden min-h-0 min-w-0 flex-1 items-center justify-center rounded-xl border border-line bg-white lg:flex">
        <div className="max-w-xs text-center">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-brand-light text-brand-dark">
            <MessageCircle className="h-6 w-6" />
          </div>
          <p className="font-display text-[22px] font-semibold">
            {rows.length === 0 ? "No conversations yet" : "Pick a conversation"}
          </p>
          <p className="mt-1.5 text-ink-2">
            {rows.length === 0
              ? "Ring, WhatsApp or email a landlord from a lead and it appears here."
              : "Every landlord you have approached is on the left."}
          </p>
          {inbox.error && <p className="mt-3 text-xs text-destructive">Could not load the inbox: {inbox.error}</p>}
        </div>
      </div>
    </>
  );
}
