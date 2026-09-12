import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { viewerScopedLead } from "@/lib/customerLeads";
import { availableLeadTypes } from "@/lib/products";
import {
  CLAIM_WINDOW_DAYS,
  claimBudget,
  reasonAvailability,
  type ClaimCustomer,
} from "@/lib/quality/deadLeadPolicy";
import {
  REPLACEMENT_PAGE_HEADING,
  REPLACEMENT_PAGE_INTRO,
  nextResetDate,
  remainingOf,
} from "@/lib/quality/replacementEntitlement";
import {
  ReplacementList,
  type ReplacementItem,
} from "@/components/dashboard/ReplacementList";
import type { Lead } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Leads the customer rang where the landlord had already gone, and a swap for
 * each (§53).
 *
 * Built on the expired-pool page's shape: server component, two redirects,
 * service role, a client list underneath. The eligibility read is
 * `claimable_dead_lead_assignments` — the one predicate (§51.7), so this page
 * can never offer something the swap would then refuse.
 */
export default async function ReplacementsPage() {
  const { user, customer } = await getCurrentCustomer();
  if (!user) redirect("/login");
  if (!customer) redirect("/dashboard");

  const admin = createAdminClient();

  const { data: rows, error } = await admin.rpc(
    "claimable_dead_lead_assignments",
    { p_customer_id: customer.id, p_window_days: CLAIM_WINDOW_DAYS }
  );
  if (error) console.error("[replacements] shortlist failed", error);

  const claimable = (rows ?? []) as {
    assignment_id: string;
    lead_id: string;
    assigned_at: string;
  }[];

  const leadIds = claimable.map((r) => r.lead_id);
  const { data: leadRows } = leadIds.length
    ? await admin.from("leads").select("*").in("id", leadIds)
    : { data: [] as Lead[] };

  const leads = new Map(
    ((leadRows ?? []) as Lead[]).map((l) => [l.id, viewerScopedLead(l, customer.id)])
  );

  const items: ReplacementItem[] = claimable
    .map((r) => {
      const lead = leads.get(r.lead_id);
      if (!lead) return null;
      const ageDays = Math.floor(
        (Date.now() - new Date(r.assigned_at).getTime()) / 86_400_000
      );
      return {
        assignmentId: r.assignment_id,
        leadId: r.lead_id,
        leadName: lead.lead_name,
        address: lead.address,
        bedrooms: lead.bedrooms,
        leadType: lead.lead_type,
        grossAnnualIncome: lead.gross_annual_income,
        ageDays,
        reasons: reasonAvailability({ claimable: true, claimStatus: null, ageDays }),
      };
    })
    .filter((x): x is ReplacementItem => x !== null);

  const entitlement = claimBudget(customer as unknown as ClaimCustomer);
  const used = Math.max(0, Math.trunc(customer.quality_claims_this_cycle ?? 0));

  // Shown so a customer who has never held a product understands why the page
  // is empty, rather than reading it as a fault (§18A's end state).
  const holdsAnything = availableLeadTypes(customer).length > 0;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link
          href="/dashboard/leads"
          className="text-sm text-[#6b706a] hover:text-[#1a1a19]"
        >
          ← Back to leads
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-[#1a1a19]">
          {REPLACEMENT_PAGE_HEADING}
        </h1>
        <p className="mt-1 text-sm text-[#55564f]">{REPLACEMENT_PAGE_INTRO}</p>
      </div>

      {holdsAnything ? (
        <ReplacementList
          items={items}
          entitlement={{
            entitlement,
            used,
            remaining: remainingOf(entitlement, used),
            resetsOn: nextResetDate(customer),
          }}
        />
      ) : (
        <p className="rounded-lg border border-[#e4e6e0] bg-white p-6 text-sm text-[#55564f]">
          Replacements are for leads we have delivered to you. Once you are set
          up on a package, anything you ring where the landlord has already gone
          will show up here.
        </p>
      )}
    </div>
  );
}
