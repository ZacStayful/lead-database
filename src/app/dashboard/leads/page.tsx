import { redirect } from "next/navigation";
import { Info } from "lucide-react";
import { viewerScopedLead } from "@/lib/customerLeads";
import { getCurrentCustomer, isAdminUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { getWhatsappConnection, messagingActiveFor } from "@/lib/messaging/service";
import { LeadsList } from "@/components/dashboard/LeadsList";
import { ExportButton } from "@/components/dashboard/ExportButton";
import { AddLeadsButton } from "@/components/dashboard/AddLeadsButton";
import { BriefSummaryBar } from "@/components/leadBrief/BriefSummaryBar";
import { briefPlanFor, canEditLeadBrief } from "@/lib/leadBrief/gate";
import { BriefVersionsUnavailableError, loadBriefVersions } from "@/lib/leadBrief/briefVersions";
import { readStoredPriorities } from "@/lib/leadBrief/editBrief";
import { EDIT_COPY, pendingLine, summaryLine } from "@/lib/leadBrief/editCopy";
import { nextGrantDate } from "@/lib/quality/replacementEntitlement";
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

  // "Your brief" bar (Lead Brief Phase 5), for a customer who has confirmed a
  // brief and nobody else. A failed read hides the bar: the leads below matter
  // more than a summary of how they are matched.
  let briefBar: { summary: string; pending: string | null } | null = null;
  if (canEditLeadBrief(customer)) {
    try {
      const versions = await loadBriefVersions(admin, customer.id);
      const a = versions.active;
      if (a) {
        briefBar = {
          summary: summaryLine({
            radiusMiles: a.service_radius_miles,
            basePostcode: a.base_postcode,
            otherAreas: (a.priority_outcodes ?? []).length,
            minBedrooms: a.min_bedrooms,
            minGross: a.min_gross,
            ranking: readStoredPriorities(a.priorities).map((p) => p.key),
          }),
          pending: !versions.scheduled
            ? null
            : briefPlanFor(customer) !== versions.scheduled.allocation
              ? EDIT_COPY.pendingReview
              : pendingLine(
                  nextGrantDate({
                    billing_cycle_anchor: customer.billing_cycle_anchor,
                    gr_billing_cycle_anchor: customer.gr_billing_cycle_anchor,
                    created_at: customer.created_at,
                  })
                ),
        };
      }
    } catch (err) {
      if (!(err instanceof BriefVersionsUnavailableError)) throw err;
      console.error("[dashboard/leads] brief versions unavailable", err.message);
    }
  }

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

      {briefBar && <BriefSummaryBar summary={briefBar.summary} pending={briefBar.pending} />}

      <LeadsList assignments={assignments} canSequence={canSequence} />
    </div>
  );
}
