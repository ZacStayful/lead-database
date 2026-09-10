import { createAdminClient } from "@/lib/supabase/admin";
import { completeAssignment } from "@/lib/ingest";
import { leadPriceFor } from "@/lib/plans";
import type { Lead, LeadType } from "@/lib/types";

/**
 * Making a customer whole after an upheld quality claim.
 *
 * The credit is always restored first, inside the claim RPC. This then tries to
 * spend it immediately on a DIFFERENT lead from the pool of leads that still
 * have an open slot. When the pool has nothing suitable, the credit simply
 * stays on the balance and the next lead arrives through normal pacing — and
 * because the claim also rolled back leads_received_this_month, the customer's
 * pacing deficit rises, so get_next_customers_for_lead moves them up the queue
 * on its own.
 *
 * What this deliberately does NOT do is hand the claimed lead to somebody else.
 * That lead keeps its slot and stays with the operators who did not reject it.
 */

export type ClaimResolution = "replacement" | "credit";

export interface ResolutionResult {
  resolution: ClaimResolution;
  assignmentId: string | null;
  leadId: string | null;
}

const CREDIT_ONLY: ResolutionResult = {
  resolution: "credit",
  assignmentId: null,
  leadId: null,
};

/**
 * Find a replacement lead for the customer and assign it, mirroring the ingest
 * path exactly (assign → notify → email) by reusing completeAssignment.
 *
 * Best-effort: the claim has already committed, so any failure here degrades to
 * a credit rather than unwinding anything.
 */
export async function assignReplacementLead(
  admin: ReturnType<typeof createAdminClient>,
  customerId: string,
  leadType: LeadType,
  replacementFilter: unknown
): Promise<ResolutionResult> {
  try {
    const { data: leadId, error: findError } = await admin.rpc(
      "find_replacement_lead",
      {
        p_customer_id: customerId,
        p_lead_type: leadType,
        p_filter: replacementFilter ?? null,
      }
    );
    if (findError || !leadId) return CREDIT_ONLY;

    const { data: assignmentId, error: assignError } = await admin.rpc(
      "assign_lead_to_customer",
      {
        p_lead_id: leadId as string,
        p_customer_id: customerId,
        p_price: leadPriceFor(leadType),
        p_lead_type: leadType,
      }
    );
    if (assignError || !assignmentId) return CREDIT_ONLY;

    const { data: leadRow } = await admin
      .from("leads")
      .select("*")
      .eq("id", leadId as string)
      .single();

    const lead = leadRow as Lead | null;
    if (lead) {
      await completeAssignment(
        admin,
        lead,
        customerId,
        assignmentId as string
      );
    }

    return {
      resolution: "replacement",
      assignmentId: assignmentId as string,
      leadId: leadId as string,
    };
  } catch {
    // The credit is already back on the balance; that is the fallback.
    return CREDIT_ONLY;
  }
}
