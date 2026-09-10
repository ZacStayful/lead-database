import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { assignReplacementLead } from "@/lib/quality/replace";
import { sendQualityClaimReviewEmail } from "@/lib/emails";
import {
  decideClaim,
  ineligibleMessage,
  isDeadLeadReason,
  type ClaimCustomer,
  type DeadLeadReason,
  type IneligibleCode,
  type PeerAssignment,
} from "@/lib/quality/claimPolicy";
import {
  resolveContactClaim,
  type ContactValidationResult,
} from "@/lib/validation/contactValidation";
import type { Customer, Lead, LeadType } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Headroom for two parallel external calls (phone + email) plus DB writes.
export const maxDuration = 15;

// Max invalid_contact claims per customer per rolling 24h (shared across both
// lead types). Beyond this we skip the external calls and process the reject as
// normal, so a customer is never blocked — this only caps provider cost abuse.
const INVALID_CONTACT_LIMIT_24H = 10;

type RejectOutcome =
  | "processed" // acted on: rejected, and any credit/replacement is done
  | "pending" // recorded, awaiting a human decision
  | "ineligible" // not actionable yet; the message says what is missing
  | "denied" // invalid_contact claim disproved by live verification
  | "error";

type RejectResponse = {
  outcome: RejectOutcome;
  message: string;
  claimDenied: boolean;
};

const MESSAGES = {
  // invalid_contact confirmed/favoured — allocation genuinely restored.
  restored:
    "Lead rejected. Your allocation has been restored and a replacement will be assigned shortly.",
  restoredWithReplacement:
    "Lead rejected. We've sent you a replacement lead to make up for it.",
  // not_a_fit — a valid lead simply not wanted; still chargeable, not replaced.
  notAFit: "Lead rejected. It still counts toward your leads this month.",
  denied:
    "We checked the phone number and email on file — both are valid. This lead has not been rejected.",
  // Dead-lead claims. None of these ever mention the allowance.
  claimReplaced:
    "Thanks for telling us. We've reviewed this one and sent you a replacement lead.",
  claimCredited:
    "Thanks for telling us. We've reviewed this one and credited it back to your balance.",
  claimUnderReview:
    "Thanks for telling us. The Stayful team is reviewing this one and will be in touch.",
  error: "Something went wrong. Please try again.",
} as const;

function response(res: RejectResponse, status = 200) {
  return NextResponse.json(res, { status });
}

function errorResponse(status: number) {
  return response(
    { outcome: "error", message: MESSAGES.error, claimDenied: false },
    status
  );
}

/**
 * Reject a lead assignment with a required reason.
 *
 *  - 'not_a_fit'        -> record the reason and flip to 'rejected'. Chargeable,
 *                          no balance restore, no replacement (per 0019).
 *  - 'invalid_contact'  -> run live phone + email verification. If BOTH check
 *                          out, deny the claim (lead stays assigned). Otherwise
 *                          restore the balance and offer a replacement lead.
 *  - dead-lead reasons  -> 'already_with_operator' | 'no_longer_interested' |
 *                          'unreachable'. Adjudicated by decideClaim: upheld
 *                          within a hidden, earned allowance, otherwise sent to
 *                          admin review. Never silently declined.
 *
 * In every refunding case the claimed lead KEEPS its slot — it is never passed
 * on to another operator. The claimant is made whole with a different lead.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return errorResponse(401);

  let assignment_id: string | undefined;
  let reason: unknown;
  let detail: unknown;
  let contacted_on: unknown;
  let attempts: unknown;
  try {
    ({ assignment_id, reason, detail, contacted_on, attempts } =
      await req.json());
  } catch {
    return errorResponse(400);
  }
  if (!assignment_id) return errorResponse(400);

  const isDeadLead = isDeadLeadReason(reason);
  if (reason !== "not_a_fit" && reason !== "invalid_contact" && !isDeadLead) {
    return errorResponse(400);
  }

  const admin = createAdminClient();

  // Resolve the customer from the session user, with the allowance state the
  // claim policy needs. Nothing here is ever sent back to the browser.
  const { data: customerRow, error: customerError } = await admin
    .from("customers")
    .select(
      "id, monthly_allocation, quality_allowance_pct, quality_claims_this_cycle, clean_leads_streak, quality_review_required, replacement_filter"
    )
    .eq("user_id", user.id)
    .single();
  if (customerError || !customerRow) return errorResponse(404);
  const customer = customerRow as ClaimCustomer & {
    id: string;
    replacement_filter: unknown;
  };

  // Load the assignment (ownership-scoped). An early idempotency check lets a
  // duplicate submit return the original outcome without touching anything.
  const { data: assignment } = await admin
    .from("lead_assignments")
    .select(
      "id, lead_id, status, pipeline_stage, assigned_at, rejection_reason, claim_denied, quality_claim_id"
    )
    .eq("id", assignment_id)
    .eq("customer_id", customer.id)
    .maybeSingle();

  if (!assignment) return errorResponse(404);

  const stored = assignment as StoredAssignment;
  // A denied invalid_contact claim leaves the lead 'new' and chargeable with a
  // reason on file; allow the customer to still reject it as not_a_fit. Every
  // other already-processed case returns the original outcome, re-running nothing.
  const canSupersedeDenied =
    stored.claim_denied && stored.status === "new" && reason === "not_a_fit";
  if (stored.rejection_reason && !canSupersedeDenied) {
    return response(await storedOutcome(admin, stored));
  }

  // Resolve the lead so validation + refund act on the correct product.
  const { data: leadRow } = await admin
    .from("leads")
    .select("id, lead_type, phone, email, assignment_count, max_assignments")
    .eq("id", stored.lead_id)
    .single();
  const lead = leadRow as Pick<
    Lead,
    "id" | "lead_type" | "phone" | "email" | "assignment_count" | "max_assignments"
  > | null;
  const leadType: LeadType = lead?.lead_type ?? "management";

  try {
    if (isDeadLead) {
      return await handleDeadLeadClaim({
        admin,
        assignmentId: assignment_id,
        assignment: stored,
        customer,
        leadType,
        reason: reason as DeadLeadReason,
        detail: typeof detail === "string" ? detail : "",
        contactedOn: typeof contacted_on === "string" ? contacted_on : null,
        attempts: typeof attempts === "number" ? attempts : null,
      });
    }

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
      if (applied && applied.applied === false && applied.denied) {
        return response({
          outcome: "denied",
          message: MESSAGES.denied,
          claimDenied: true,
        });
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
    const restore = !denied; // confirmed OR favoured -> restore the credit

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

    // Restored. A lead whose phone AND email failed verification is the last
    // lead that should reach another operator, so it keeps its slot and stays
    // put; the customer gets a different lead instead where one is available.
    const resolved = await assignReplacementLead(
      admin,
      customer.id,
      leadType,
      customer.replacement_filter
    );

    return response({
      outcome: "processed",
      message:
        resolved.resolution === "replacement"
          ? MESSAGES.restoredWithReplacement
          : MESSAGES.restored,
      claimDenied: false,
    });
  } catch {
    return errorResponse(500);
  }
}

type StoredAssignment = {
  id: string;
  lead_id: string;
  status: string;
  pipeline_stage: string;
  assigned_at: string;
  rejection_reason: string | null;
  claim_denied: boolean;
  quality_claim_id: string | null;
};

/**
 * A dead-lead claim: the landlord had already gone when the lead arrived.
 *
 * There is no external verifier for this, so the guards are a claim window, a
 * requirement that the lead was actually worked, and the hidden allowance —
 * plus the co-assigned operators, who act as a natural control group.
 */
async function handleDeadLeadClaim({
  admin,
  assignmentId,
  assignment,
  customer,
  leadType,
  reason,
  detail,
  contactedOn,
  attempts,
}: {
  admin: ReturnType<typeof createAdminClient>;
  assignmentId: string;
  assignment: StoredAssignment;
  customer: ClaimCustomer & { id: string; replacement_filter: unknown };
  leadType: LeadType;
  reason: DeadLeadReason;
  detail: string;
  contactedOn: string | null;
  attempts: number | null;
}) {
  const [peers, noteCount] = await Promise.all([
    loadPeers(admin, assignment.lead_id, customer.id),
    countNotes(admin, assignmentId),
  ]);

  const decision = decideClaim({
    assignment: {
      assigned_at: assignment.assigned_at,
      status: assignment.status,
      pipeline_stage: assignment.pipeline_stage,
      rejection_reason: assignment.rejection_reason,
    },
    customer,
    peers,
    noteCount,
    reason,
    detail,
    contactedOn,
  });

  const { data, error } = await admin.rpc("apply_quality_claim", {
    p_assignment_id: assignmentId,
    p_customer_id: customer.id,
    p_reason: reason,
    p_detail: detail,
    p_contacted_on: contactedOn,
    p_attempts: attempts,
    p_decision: decision.decision,
    p_consumes_allowance: decision.consumesAllowance,
    p_corroboration: decision.corroboration,
  });
  if (error) throw error;

  if (decision.decision === "ineligible") {
    return response({
      outcome: "ineligible",
      message: ineligibleMessage(decision.code as IneligibleCode),
      claimDenied: false,
    });
  }

  const applied = data as
    | { applied: boolean; claim_id: string; claim_status: string; upheld: boolean }[]
    | null;
  const row = Array.isArray(applied) && applied.length > 0 ? applied[0] : null;

  // Race no-op: another request got here first. Report what it decided.
  if (row && row.applied === false) {
    return response(
      row.upheld
        ? {
            outcome: "processed",
            message: MESSAGES.claimCredited,
            claimDenied: false,
          }
        : {
            outcome: "pending",
            message: MESSAGES.claimUnderReview,
            claimDenied: false,
          }
    );
  }

  if (decision.decision === "review") {
    // Best-effort nudge to the team; the claim is already queued either way.
    await notifyReviewQueue(admin, {
      customerId: customer.id,
      leadId: assignment.lead_id,
      reason,
      detail,
      corroboration: decision.corroboration,
    });
    return response({
      outcome: "pending",
      message: MESSAGES.claimUnderReview,
      claimDenied: false,
    });
  }

  // Upheld. Flag the lead (dead once every operator agrees, suspect before
  // that) and make the customer whole.
  await admin.rpc("flag_lead_dead_if_unanimous", {
    p_lead_id: assignment.lead_id,
  });

  const resolved = await assignReplacementLead(
    admin,
    customer.id,
    leadType,
    customer.replacement_filter
  );

  if (row?.claim_id) {
    await admin
      .from("lead_quality_claims")
      .update({
        resolution: resolved.resolution,
        replacement_assignment_id: resolved.assignmentId,
      })
      .eq("id", row.claim_id);
  }

  return response({
    outcome: "processed",
    message:
      resolved.resolution === "replacement"
        ? MESSAGES.claimReplaced
        : MESSAGES.claimCredited,
    claimDenied: false,
  });
}

/** Email the team about a claim that needs a human decision. Never throws. */
async function notifyReviewQueue(
  admin: ReturnType<typeof createAdminClient>,
  params: {
    customerId: string;
    leadId: string;
    reason: DeadLeadReason;
    detail: string;
    corroboration: string;
  }
) {
  try {
    const [{ data: customerRow }, { data: leadRow }] = await Promise.all([
      admin
        .from("customers")
        .select("business_name")
        .eq("id", params.customerId)
        .maybeSingle(),
      admin
        .from("leads")
        .select("lead_name")
        .eq("id", params.leadId)
        .maybeSingle(),
    ]);

    await sendQualityClaimReviewEmail({
      businessName:
        (customerRow as { business_name?: string } | null)?.business_name ??
        "A customer",
      leadName: (leadRow as { lead_name?: string } | null)?.lead_name ?? "a lead",
      reason: params.reason,
      detail: params.detail,
      corroboration: params.corroboration,
    });
  } catch {
    /* the claim is queued regardless; the email is a convenience */
  }
}

/** The other operators holding this lead, with their own claim state. */
async function loadPeers(
  admin: ReturnType<typeof createAdminClient>,
  leadId: string,
  customerId: string
): Promise<PeerAssignment[]> {
  const { data: rows } = await admin
    .from("lead_assignments")
    .select("id, status, pipeline_stage, rejection_reason")
    .eq("lead_id", leadId)
    .neq("customer_id", customerId);

  const assignments = (rows ?? []) as {
    id: string;
    status: string;
    pipeline_stage: string;
    rejection_reason: string | null;
  }[];
  if (assignments.length === 0) return [];

  const { data: claimRows } = await admin
    .from("lead_quality_claims")
    .select("lead_assignment_id, status")
    .in(
      "lead_assignment_id",
      assignments.map((a) => a.id)
    );

  const claimStatus = new Map<string, string>();
  for (const c of (claimRows ?? []) as {
    lead_assignment_id: string;
    status: string;
  }[]) {
    claimStatus.set(c.lead_assignment_id, c.status);
  }

  return assignments.map((a) => ({
    status: a.status,
    pipeline_stage: a.pipeline_stage,
    rejection_reason: a.rejection_reason,
    claim_status: claimStatus.get(a.id) ?? null,
  }));
}

async function countNotes(
  admin: ReturnType<typeof createAdminClient>,
  assignmentId: string
): Promise<number> {
  const { count } = await admin
    .from("lead_notes")
    .select("id", { count: "exact", head: true })
    .eq("lead_assignment_id", assignmentId);
  return count ?? 0;
}

/** Replay the outcome of an assignment that already carries a rejection. */
async function storedOutcome(
  admin: ReturnType<typeof createAdminClient>,
  a: StoredAssignment
): Promise<RejectResponse> {
  if (a.claim_denied) {
    return { outcome: "denied", message: MESSAGES.denied, claimDenied: true };
  }

  if (isDeadLeadReason(a.rejection_reason)) {
    let status: string | null = null;
    if (a.quality_claim_id) {
      const { data } = await admin
        .from("lead_quality_claims")
        .select("status")
        .eq("id", a.quality_claim_id)
        .maybeSingle();
      status = (data as { status: string } | null)?.status ?? null;
    }
    const upheld = status === "auto_upheld" || status === "upheld";
    return {
      outcome: upheld ? "processed" : "pending",
      message: upheld ? MESSAGES.claimCredited : MESSAGES.claimUnderReview,
      claimDenied: false,
    };
  }

  return {
    outcome: "processed",
    message:
      a.rejection_reason === "not_a_fit" ? MESSAGES.notAFit : MESSAGES.restored,
    claimDenied: false,
  };
}

function firstRow(data: unknown): { applied: boolean; denied: boolean } | null {
  if (Array.isArray(data) && data.length > 0) {
    return data[0] as { applied: boolean; denied: boolean };
  }
  return null;
}
