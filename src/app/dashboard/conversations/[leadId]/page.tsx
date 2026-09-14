import { notFound, redirect } from "next/navigation";
import { getCurrentCustomer, isAdminUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchInboxRows } from "@/lib/messaging/inbox";
import { enabledChannels } from "@/lib/messaging/service";
import { loadLeadWorkspace } from "@/lib/leadWorkspace";
import { toInboxListRows } from "@/lib/conversations/inboxRows";
import { InboxList } from "@/components/conversations/InboxList";
import { LeadWorkspace } from "@/components/lead/LeadWorkspace";

export const dynamic = "force-dynamic";

/** The inbox with a thread open (§56.7): Inbox · Thread · Contact details. */
export default async function ConversationPage({ params }: { params: { leadId: string } }) {
  const { user, customer } = await getCurrentCustomer();
  if (!user) redirect("/login");
  if (!customer) redirect("/dashboard");

  const admin = createAdminClient();
  const isAdmin = isAdminUser(user);
  const [inbox, channels, data] = await Promise.all([
    fetchInboxRows(admin, customer.id),
    enabledChannels(admin, isAdmin),
    loadLeadWorkspace(admin, customer, params.leadId, { isAdmin }),
  ]);
  if (!data) notFound();

  return (
    <LeadWorkspace
      data={data}
      userId={user.id}
      mode="conversation"
      initialPane="thread"
      list={
        <InboxList
          rows={toInboxListRows(inbox.rows)}
          selectedLeadId={params.leadId}
          emailEnabled={channels.includes("email")}
        />
      }
    />
  );
}
