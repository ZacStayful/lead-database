/**
 * Write me a first message for this lead (§40).
 *
 * SESSION-ONLY, like every route here that acts on a customer's behalf.
 *
 * ⚠️ IT WRITES NOTHING TO lead_messages. A draft is not a message. The button
 * badge on the lead page counts messages, and a badge counting drafts would be
 * a lie. What it does write is a row to message_draft_requests — which is both
 * the rate-limit ledger and the only record of how often the validator refused
 * the model, split by whether the lead had figures. Without that, "does the
 * draft degrade honestly on the half of the book with no analysis" is
 * unanswerable after launch.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentCustomer, isAdminUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { viewerScopedLead } from "@/lib/customerLeads";
import { resolveOperatorNames } from "@/lib/referralIdentity";
import {
  assignmentSendable,
  messagingActiveFor,
} from "@/lib/messaging/service";
import { buildDraftContext } from "@/lib/messaging/draftContext";
import {
  draftWhatsappMessage,
  isDraftingConfigured,
} from "@/lib/messaging/draftMessage";
import { rejectionMessage, type DraftRejection } from "@/lib/messaging/validateDraft";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Regenerating a few times is normal; regenerating forty times is a bill. */
const MAX_PER_ASSIGNMENT_PER_DAY = 3;
const MAX_PER_CUSTOMER_PER_DAY = 50;

export async function POST(request: NextRequest) {
  const { user, customer } = await getCurrentCustomer();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: { assignment_id?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const assignmentId =
    typeof body.assignment_id === "string" ? body.assignment_id : "";
  if (!assignmentId) {
    return NextResponse.json({ error: "assignment_id required" }, { status: 400 });
  }

  const admin = createAdminClient();

  if (!(await messagingActiveFor(admin, isAdminUser(user)))) {
    return NextResponse.json(
      { error: "Messaging is currently switched off.", code: "disabled" },
      { status: 503 }
    );
  }

  if (!isDraftingConfigured()) {
    return NextResponse.json(
      {
        error: isAdminUser(user)
          ? "ANTHROPIC_API_KEY is not set on this deployment. Add it in Vercel and REDEPLOY — env vars are baked in at build time."
          : "Drafting is not available on your account yet.",
        code: "not_configured",
      },
      { status: 503 }
    );
  }

  // Scoped by customer_id: a foreign assignment id is indistinguishable from a
  // nonexistent one.
  const { data: row } = await admin
    .from("lead_assignments")
    .select(
      "id, status, closed_at, closed_reason, lead_id, lead:leads(id, lead_name, address, bedrooms, lead_profile, phone, owner_customer_id, gross_annual_income, avg_nightly_rate, occupancy_rate)"
    )
    .eq("id", assignmentId)
    .eq("customer_id", customer.id)
    .maybeSingle();

  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const assignment = row as unknown as {
    id: string;
    status: string | null;
    closed_at: string | null;
    closed_reason: string | null;
    lead: Record<string, unknown>;
  };

  // Drafting a message to a landlord you closed as "not interested" is the
  // outcome closing exists to prevent, one step earlier.
  const eligibility = assignmentSendable(assignment);
  if (!eligibility.sendable) {
    return NextResponse.json(
      { error: eligibility.reason, code: "not_sendable" },
      { status: 409 }
    );
  }

  // ---- Rate limits ---------------------------------------------------------
  //
  // ⚠️ BOTH COUNT origin = 'operator' ONLY (0121 §5). These caps exist to bound
  // a person clicking Generate, and one operator's workable backlog is 37 leads
  // against a customer cap of 50 — so counting the scheduler's drafts here would
  // let a single enrolment lock them out of the button for a day, or, read the
  // other way, let clicking Generate starve their own sequence. Two loads, two
  // ceilings; the scheduler's lives in system_settings.
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const [{ count: perAssignment }, { count: perCustomer }] = await Promise.all([
    admin
      .from("message_draft_requests")
      .select("id", { count: "exact", head: true })
      .eq("assignment_id", assignmentId)
      .eq("origin", "operator")
      .gte("created_at", dayAgo),
    admin
      .from("message_draft_requests")
      .select("id", { count: "exact", head: true })
      .eq("customer_id", customer.id)
      .eq("origin", "operator")
      .gte("created_at", dayAgo),
  ]);

  if ((perAssignment ?? 0) >= MAX_PER_ASSIGNMENT_PER_DAY) {
    return NextResponse.json(
      {
        error: `You've generated ${MAX_PER_ASSIGNMENT_PER_DAY} drafts for this lead today. Have a go at it yourself — the ones that work are usually the ones in your own words.`,
        code: "assignment_cap",
      },
      { status: 429 }
    );
  }
  if ((perCustomer ?? 0) >= MAX_PER_CUSTOMER_PER_DAY) {
    return NextResponse.json(
      { error: "You've reached today's limit for generated drafts.", code: "daily_cap" },
      { status: 429 }
    );
  }

  // ⚠️ viewerScopedLead FIRST. On a resold imported lead, lead_profile holds the
  // UPLOADING operator's private working notes — margins, "will take 12%, spoke
  // to Dave". Passing it through unscoped would have the model paraphrase
  // another operator's commercial notes into a message to the landlord.
  const scoped = viewerScopedLead(
    assignment.lead as never,
    customer.id
  ) as unknown as Record<string, unknown>;

  const ctx = buildDraftContext({
    lead: scoped,
    customer: {
      // §41/0131. Resolved so a draft introduces the operator under the same
      // name the referral email did — see resolveOperatorNames.
      ...resolveOperatorNames(customer),
      // §41. getCurrentCustomer() reads the row with select("*"), so this is
      // already loaded; omitting it here would silently drop the operator's own
      // introduction from every draft.
      operator_intro: customer.operator_intro,
    },
  });

  const result = await draftWhatsappMessage(ctx);

  // Best-effort ledger: it must never fail the request it is recording.
  const record = async (
    outcome: string,
    rejectReason: string | null,
    text: string | null,
    modelId: string | null,
    promptVersion: string | null
  ) => {
    const { data } = await admin
      .from("message_draft_requests")
      .insert({
        customer_id: customer.id,
        assignment_id: assignmentId,
        channel: "whatsapp",
        outcome,
        reject_reason: rejectReason,
        draft_text: text,
        model_id: modelId,
        prompt_version: promptVersion,
        had_figures: ctx.figures !== null,
      })
      .select("id")
      .maybeSingle();
    return (data as { id: string } | null)?.id ?? null;
  };

  if (!result.ok) {
    const isConfig = result.code === "not_configured";
    const isModel = result.code === "model_error";
    await record(
      isConfig || isModel ? "error" : "rejected",
      result.code,
      null,
      null,
      null
    ).catch(() => null);

    return NextResponse.json(
      {
        error: isModel || isConfig
          ? "We couldn't write a draft just now. The message is yours to write."
          : rejectionMessage(result.code as DraftRejection),
        code: result.code,
      },
      { status: 502 }
    );
  }

  const draftId = await record(
    "drafted",
    null,
    result.text,
    result.modelId,
    result.promptVersion
  ).catch(() => null);

  return NextResponse.json({
    ok: true,
    draft_id: draftId,
    text: result.text,
    had_figures: ctx.figures !== null,
  });
}
