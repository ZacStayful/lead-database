import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminUser } from "@/lib/auth";
import { completeAssignment } from "@/lib/ingest";
import { activeLeadFilters, filterSummary, filterTooltip } from "@/lib/leadFilter";
import type { Customer, Lead } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function isAdminRequest(req: NextRequest): Promise<boolean> {
  const key = req.headers.get("x-admin-key");
  if (key && process.env.ADMIN_SECRET_KEY && key === process.env.ADMIN_SECRET_KEY) {
    return true;
  }
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return isAdminUser(user);
}

/**
 * Leads eligible to replace this one.
 *
 * Eligibility is resolved in SQL rather than here, and here rather than in the
 * picker, so the list can never offer something the swap would then refuse:
 * same product, room left, not already held by this customer, not previously
 * withdrawn, not a customer's own lead.
 *
 * The customer's lead FILTER is the one rule that is reported rather than
 * applied. get_swap_candidates_for_assignment (0109) flags each candidate with
 * `matches_filter` — from lead_matches_customer_filter, the same predicate
 * allocation and the expired pool use — and a mismatch is still returned. A
 * swap is a support action, and a customer with a narrow filter may have no
 * matching lead in stock at the moment they are owed a replacement. The
 * override is the admin's to take, deliberately and per swap; see the POST.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!(await isAdminRequest(req))) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const admin = createAdminClient();

  const { data: assignment } = await admin
    .from("lead_assignments")
    .select("id, customer_id, lead_id")
    .eq("id", params.id)
    .maybeSingle();

  if (!assignment) {
    return NextResponse.json({ error: "Assignment not found" }, { status: 404 });
  }

  const search = req.nextUrl.searchParams.get("q")?.trim() ?? "";

  // The product, the capacity comparison and the filter verdict are all
  // resolved inside the function. It returns matching leads first.
  const { data: candidates, error } = await admin.rpc(
    "get_swap_candidates_for_assignment",
    {
      p_assignment_id: params.id,
      p_search: search || null,
      p_limit: 50,
    }
  );

  if (error) {
    console.error("swap candidates lookup failed", error);
    return NextResponse.json({ error: "Could not load leads." }, { status: 500 });
  }

  // What the filter actually IS, so the picker can name it rather than just
  // marking leads good and bad. activeLeadFilters is the existing admin-side
  // reader (it already knows pending_lift counts as filtered, and that an
  // empty area list means anywhere).
  const { data: customer } = await admin
    .from("customers")
    .select("*")
    .eq("id", assignment.customer_id as string)
    .maybeSingle();

  const { data: currentLead } = await admin
    .from("leads")
    .select("lead_type")
    .eq("id", assignment.lead_id as string)
    .maybeSingle();

  const view = customer
    ? activeLeadFilters(customer as Customer).find(
        (f) => f.leadType === currentLead?.lead_type
      )
    : undefined;

  // null for a customer with no active filter on this product — which is what
  // lets the picker fall back to its pre-0109 rendering with no extra branch.
  const filter = view
    ? {
        label: view.label,
        status: view.status,
        summary: filterSummary(view),
        tooltip: filterTooltip(view),
        liftDate: view.liftDate,
      }
    : null;

  return NextResponse.json({ ok: true, candidates: candidates ?? [], filter });
}

/**
 * Swap a lead out of a customer's pipeline and put another in its place.
 *
 * Every rule lives in admin_swap_lead_assignment, not here, so the route and
 * the function cannot disagree — the same reasoning as the reject route, which
 * deliberately runs no pre-flight check of its own (CLAUDE.md §5E).
 *
 * That includes the filter. `allow_filter_mismatch` is passed straight through
 * and is the ONLY thing that lets an off-filter lead in; absent or false, the
 * function refuses. The flag has to be sent, so the picker cannot forget to
 * opt in — it has to opt in.
 *
 * No money moves. The replacement inherits the removed assignment's
 * price_paid, no credit is spent, and no counter changes.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!(await isAdminRequest(req))) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let body: { new_lead_id?: unknown; allow_filter_mismatch?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const newLeadId =
    typeof body.new_lead_id === "string" ? body.new_lead_id.trim() : "";
  if (!newLeadId) {
    return NextResponse.json(
      { error: "Choose a replacement lead." },
      { status: 400 }
    );
  }

  // Strict true. A truthy string or a 1 from some future caller must not be
  // enough to place a lead the customer asked not to receive.
  const allowFilterMismatch = body.allow_filter_mismatch === true;

  const admin = createAdminClient();

  const { data, error } = await admin.rpc("admin_swap_lead_assignment", {
    p_assignment_id: params.id,
    p_new_lead_id: newLeadId,
    p_allow_filter_mismatch: allowFilterMismatch,
  });

  if (error) {
    console.error("swap lead assignment failed", error);
    // The function raises in plain language for every rule it enforces — won,
    // duplicate, capacity, paused, product mismatch, filter mismatch — so the
    // message is worth passing through rather than replacing with something
    // generic.
    return NextResponse.json(
      { error: error.message || "Could not swap this lead." },
      { status: 400 }
    );
  }

  const newAssignmentId = data as string;

  // Notify exactly as an ordinary delivery does — in-portal notification,
  // Resend email and the instant SMS — by calling the same completeAssignment
  // that ingest and the admin force-assign route use. A replacement is a
  // delivery from the customer's point of view: they have a new lead to work
  // and no reason to know it arrived by a different route, so a second
  // notification path written just for swaps would be a second thing to keep
  // in step with their preferences and opt-outs.
  //
  // It is also the reason the filter has to be honoured above: the customer
  // cannot tell a replacement from a lead the engine chose for them.
  //
  // sendThresholdWarnings is FALSE. A swap spends no credit, so the balance has
  // not moved; the low-credits and top-up-offer branches key on exact balance
  // values and would either misfire or re-fire on every swap. Same reasoning
  // the admin override already uses.
  let notified = false;
  try {
    const { data: created } = await admin
      .from("lead_assignments")
      .select("id, customer_id, lead_id")
      .eq("id", newAssignmentId)
      .maybeSingle();

    if (created) {
      const { data: lead } = await admin
        .from("leads")
        .select("*")
        .eq("id", created.lead_id as string)
        .maybeSingle();

      if (lead) {
        await completeAssignment(
          admin,
          lead as Lead,
          created.customer_id as string,
          newAssignmentId,
          false
        );
        notified = true;
      }
    }
  } catch (err) {
    // The swap itself is already committed and correct. A failed send must not
    // be reported as a failed swap — that would invite a retry that then hits
    // "customer already has the replacement lead". Surfaced in the response so
    // the admin knows to tell them by hand.
    console.error("swap: replacement placed but notification failed", err);
  }

  return NextResponse.json({
    ok: true,
    assignment_id: newAssignmentId,
    notified,
  });
}
