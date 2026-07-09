import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendNewLeadEmail } from "@/lib/emails";
import { extractCity } from "@/lib/utils";
import {
  resolveContactClaim,
  type ContactValidationResult,
} from "@/lib/validation/contactValidation";
import type { Customer, Lead, LeadType } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Headroom for two parallel external calls (phone + email) plus DB writes.
export const maxDuration = 15;

const LEAD_PRICE = 15.0;
const GR_LEAD_PRICE = 10.0;

// Max invalid_contact claims per customer per rolling 24h (shared across both
// lead types). Beyond this we skip the external calls and process the reject as
// normal, so a customer is never blocked — this only caps provider cost abuse.
const INVALID_CONTACT_LIMIT_24H = 10;

type RejectResponse = {
  outcome: "processed" | "denied" | "error";
  message: string;
  claimDenied: boolean;
};

const MESSAGES = {
  // invalid_contact confirmed/favoured — allocation genuinely restored + replaced.
  restored:
    "Lead rejected. Your allocation has been restored and a replacement will be assigned shortly.",
  // not_a_fit — a valid lead simply not wanted; still chargeable, not replaced.
  notAFit: "Lead rejected. It still counts toward your leads this month.",
  denied:
    "We checked the phone number and email on file — both are valid. This lead has not been rejected.",
  error: "Something went wrong. Please try again.",
} as const;

function response(res: RejectResponse, status = 200) {
  return NextResponse.json(res, { status });
}

/**
 * Reject a lead assignment with a required reason.
 *
 *  - 'not_a_fit'        -> record the reason and flip to 'rejected'. Chargeable,
 *                          no balance restore, no replacement (per 0019).
 *  - 'invalid_contact'  -> run live phone + email verification. If BOTH check
 *                          out, deny the claim (lead stays assigned). Otherwise
 *                          (a genuine failure, or unverifiable) restore the
 *                          balance, roll back the monthly counter, reopen the
 *                          slot and reassign to the next eligible customer.
 *
 * The reason capture + balance mutation commit atomically inside
 * apply_lead_rejection; the external calls and reassignment run around it.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return response(
      { outcome: "error", message: MESSAGES.error, claimDenied: false },
      401
    );
  }

  let assignment_id: string | undefined;
  let reason: unknown;
  try {
    ({ assignment_id, reason } = await req.json());
  } catch {
    return response(
      { outcome: "error", message: MESSAGES.error, claimDenied: false },
      400
    );
  }
  if (!assignment_id) {
    return response(
      { outcome: "error", message: MESSAGES.error, claimDenied: false },
      400
    );
  }
  if (reason !== "not_a_fit" && reason !== "invalid_contact") {
    return response(
      { outcome: "error", message: MESSAGES.error, claimDenied: false },
      400
    );
  }

  const admin = createAdminClient();

  // Resolve customer_id from the session user.
  const { data: customer, error: customerError } = await admin
    .from("customers")
    .select("id")
    .eq("user_id", user.id)
    .single();
  if (customerError || !customer) {
    return response(
      { outcome: "error", message: MESSAGES.error, claimDenied: false },
      404
    );
  }

  // Load the assignment (ownership-scoped). An early idempotency check lets a
  // duplicate submit return the original outcome without touching anything.
  const { data: assignment } = await admin
    .from("lead_assignments")
    .select("id, lead_id, status, rejection_reason, claim_denied")
    .eq("id", assignment_id)
    .eq("customer_id", customer.id)
    .maybeSingle();

  if (!assignment) {
    return response(
      { outcome: "error", message: MESSAGES.error, claimDenied: false },
      404
    );
  }

  if ((assignment as { rejection_reason: string | null }).rejection_reason) {
    // Already processed — return the original outcome, re-running nothing.
    return response(storedOutcome(assignment as StoredAssignment));
  }

  // Resolve the lead so validation + refund act on the correct product.
  const { data: leadRow } = await admin
    .from("leads")
    .select("id, lead_type, phone, email, assignment_count, max_assignments")
    .eq("id", (assignment as { lead_id: string }).lead_id)
    .single();
  const lead = leadRow as Pick<
    Lead,
    "id" | "lead_type" | "phone" | "email" | "assignment_count" | "max_assignments"
  > | null;
  const leadType: LeadType = lead?.lead_type ?? "management";

  try {
    if (reason === "not_a_fit") {
      const { data, error } = await admin.rpc("apply_lead_rejection", {
        p_assignment_id: assignment_id,
        p_customer_id: customer.id,
        p_lead_type: leadType,
        p_reason: "not_a_fit",
        p_validation_result: null,
        p_restore: false,
        p_claim_denied: false,
      });
      if (error) throw error;
      const applied = firstRow(data);
      // Race no-op: another request processed it first — return its outcome.
      if (applied && applied.applied === false) {
        return response(
          applied.denied
            ? { outcome: "denied", message: MESSAGES.denied, claimDenied: true }
            : {
                outcome: "processed",
                message: MESSAGES.notAFit,
                claimDenied: false,
              }
        );
      }
      return response({
        outcome: "processed",
        message: MESSAGES.notAFit,
        claimDenied: false,
      });
    }

    // reason === 'invalid_contact'
    const now = new Date().toISOString();

    // Rate limit: count this customer's invalid_contact claims in the last 24h
    // across both lead types. Over the cap -> skip external calls, favour them.
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count } = await admin
      .from("lead_assignments")
      .select("id", { count: "exact", head: true })
      .eq("customer_id", customer.id)
      .eq("rejection_reason", "invalid_contact")
      .gte("contact_validation_result->>checkedAt", since);

    let validation: ContactValidationResult & { rateLimited?: boolean };
    if ((count ?? 0) >= INVALID_CONTACT_LIMIT_24H) {
      validation = {
        outcome: "favoured_customer",
        phoneStatus: "inconclusive",
        emailStatus: "inconclusive",
        checkedAt: now,
        rateLimited: true,
      };
    } else {
      validation = await resolveContactClaim(
        lead?.phone ?? null,
        lead?.email ?? null,
        now
      );
    }

    const denied = validation.outcome === "claim_denied";
    const restore = !denied; // confirmed OR favoured -> restore + reassign

    const { data, error } = await admin.rpc("apply_lead_rejection", {
      p_assignment_id: assignment_id,
      p_customer_id: customer.id,
      p_lead_type: leadType,
      p_reason: "invalid_contact",
      p_validation_result: validation,
      p_restore: restore,
      p_claim_denied: denied,
    });
    if (error) throw error;

    const applied = firstRow(data);
    // Race no-op: another request already processed this assignment.
    if (applied && applied.applied === false) {
      return response(
        applied.denied
          ? { outcome: "denied", message: MESSAGES.denied, claimDenied: true }
          : {
              outcome: "processed",
              message: MESSAGES.restored,
              claimDenied: false,
            }
      );
    }

    if (denied) {
      return response({
        outcome: "denied",
        message: MESSAGES.denied,
        claimDenied: true,
      });
    }

    // Restored — reassign to the next eligible customer (best-effort).
    if (lead) {
      await reassignLead(admin, lead, customer.id, leadType);
    }

    return response({
      outcome: "processed",
      message: MESSAGES.restored,
      claimDenied: false,
    });
  } catch {
    return response(
      { outcome: "error", message: MESSAGES.error, claimDenied: false },
      500
    );
  }
}

type StoredAssignment = { rejection_reason: string | null; claim_denied: boolean };

function storedOutcome(a: StoredAssignment): RejectResponse {
  if (a.claim_denied) {
    return { outcome: "denied", message: MESSAGES.denied, claimDenied: true };
  }
  return {
    outcome: "processed",
    message: a.rejection_reason === "not_a_fit" ? MESSAGES.notAFit : MESSAGES.restored,
    claimDenied: false,
  };
}

function firstRow(
  data: unknown
): { applied: boolean; denied: boolean } | null {
  if (Array.isArray(data) && data.length > 0) {
    return data[0] as { applied: boolean; denied: boolean };
  }
  return null;
}

/**
 * Reassign a lead to the next eligible customer (excluding the rejector),
 * mirroring lead ingestion: assign, notify, email. Best-effort — a failure here
 * does not undo the reject, which already committed.
 */
async function reassignLead(
  admin: ReturnType<typeof createAdminClient>,
  lead: Pick<Lead, "id" | "assignment_count" | "max_assignments" | "lead_type">,
  rejectorId: string,
  leadType: LeadType
) {
  // The slot was reopened by apply_lead_rejection (assignment_count - 1), so
  // there is room. Re-read is unnecessary; get_next_customers_for_lead already
  // excludes customers who hold this lead.
  const price = leadType === "guaranteed_rent" ? GR_LEAD_PRICE : LEAD_PRICE;

  const { data: nextCustomers } = await admin.rpc(
    "get_next_customers_for_lead",
    {
      p_lead_id: lead.id,
      p_max: 1,
      p_exclude_customer_ids: [rejectorId],
      p_lead_type: leadType,
    }
  );

  if (!nextCustomers || nextCustomers.length === 0) return;

  const nextCustomerId = (nextCustomers[0] as { customer_id: string }).customer_id;
  const { data: assignmentId, error: assignError } = await admin.rpc(
    "assign_lead_to_customer",
    {
      p_lead_id: lead.id,
      p_customer_id: nextCustomerId,
      p_price: price,
      p_lead_type: leadType,
    }
  );
  if (assignError || !assignmentId) return;

  // Load the full lead for the notification/email copy.
  const { data: fullLeadRow } = await admin
    .from("leads")
    .select("*")
    .eq("id", lead.id)
    .single();
  const fullLead = fullLeadRow as Lead | null;
  if (!fullLead) return;

  const { data: nextCustomer } = await admin
    .from("customers")
    .select("*")
    .eq("id", nextCustomerId)
    .single();

  const city = extractCity(fullLead.address);
  const { data: notification } = await admin
    .from("notifications")
    .insert({
      customer_id: nextCustomerId,
      lead_assignment_id: assignmentId,
      notification_type: "new_lead",
      message: `New lead: ${fullLead.lead_name}${city ? ` in ${city}` : ""}`,
    })
    .select("id")
    .single();

  let emailError: unknown = null;
  if (nextCustomer) {
    const { error } = await sendNewLeadEmail({
      to: (nextCustomer as Customer).email,
      lead: fullLead,
    });
    emailError = error;
  }

  await admin
    .from("lead_assignments")
    .update({ notification_sent: true, email_sent: !emailError })
    .eq("id", assignmentId);

  if (notification) {
    await admin
      .from("notifications")
      .update({ email_sent: !emailError })
      .eq("id", notification.id);
  }
}
