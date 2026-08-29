import { redirect } from "next/navigation";
import { Info } from "lucide-react";
import { viewerScopedLead } from "@/lib/customerLeads";
import { getCurrentCustomer, isAdminUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { getWhatsappConnection, messagingActiveFor } from "@/lib/messaging/service";
import { LeadsList } from "@/components/dashboard/LeadsList";
import { ExportButton } from "@/components/dashboard/ExportButton";
import { AddLeadsButton } from "@/components/dashboard/AddLeadsButton";
import type { AssignmentWithLead } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function LeadsPage() {
  const { user, customer } = await getCurrentCustomer();
  if (!user) redirect("/login");
  if (!customer) redirect("/dashboard");

  const admin = createAdminClient();
  const { data } = await admin
    .from("lead_assignments")
    .select("*, lead:leads(*)")
    .eq("customer_id", customer.id)
    .order("assigned_at", { ascending: false });

  // Bulk follow-up is offered only to somebody who can actually message. An
  // operator with no WhatsApp connection would select forty leads and be told
  // to go and set one up, which reads as the feature being broken (§18E).
  //
  // messagingActiveFor, not messagingEnabled: preview means live for THIS
  // viewer, so an admin rehearsing on production sees it with the switch off.
  const canSequence =
    (await messagingActiveFor(admin, isAdminUser(user))) &&
    (await getWhatsappConnection(admin, customer.id))?.status === "connected";

  // See the note on /dashboard: another operator's customer id never reaches
  // the browser.
  const assignments = ((data ?? []) as AssignmentWithLead[]).map((a) => ({
    ...a,
    lead: viewerScopedLead(a.lead, customer.id),
  })) as AssignmentWithLead[];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">All leads</h1>
          <p className="text-sm text-muted-foreground">
            {assignments.length} lead{assignments.length === 1 ? "" : "s"} received
          </p>
        </div>
        <div className="flex items-center gap-2">
          <AddLeadsButton />
          <ExportButton />
        </div>
      </div>

      {/* Why keeping records current matters, stated once where the leads are.
          Framed as what the customer gets back rather than as an instruction —
          the status and notes they keep are the only view we have of what
          happens after a lead is delivered, so they are also the only basis for
          telling them anything useful about their own conversion. */}
      <div className="flex items-start gap-3 rounded-lg border-[0.5px] border-border bg-muted/50 px-4 py-3">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="text-sm">
          <p className="font-medium">Keep your lead records up to date</p>
          <p className="mt-1 text-muted-foreground">
            Updating a lead&apos;s status and adding notes as you go keeps your
            pipeline organised, and it&apos;s how we measure how well the lead
            database is working for you. The more we can see of what happens
            after a lead lands, the more specific the advice we can give on
            improving your sales results.
          </p>
        </div>
      </div>

      <LeadsList assignments={assignments} canSequence={canSequence} />
    </div>
  );
}
