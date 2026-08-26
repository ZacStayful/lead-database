import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminUser } from "@/lib/auth";
import { completeAssignment } from "@/lib/ingest";
import type { Lead } from "@/lib/types";

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
 * Eligibility is resolved here rather than in the picker so the list can never
 * offer something the swap would then refuse: same product, room left, not
 * already held by this customer, and not previously withdrawn.
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

  // The product is fetched separately rather than through an embedded
  // `leads!inner(lead_type)` select. PostgREST returns an embedded row as
  // either an object or an array depending on how it infers the relationship,
  // and reading `.lead_type` off the array form yields undefined — which
  // becomes `lead_type=eq.undefined`, matches nothing, and renders as an empty
  // dropdown indistinguishable from "no eligible leads". Two plain queries
  // cannot go wrong that way.
  const { data: currentLead } = await admin
    .from("leads")
    .select("lead_type")
    .eq("id", assignment.lead_id as string)
    .maybeSingle();

  const leadType = currentLead?.lead_type as string | undefined;

  // Fail loudly. An empty list is a legitimate answer, so a lookup that cannot
  // determine the product must not be allowed to masquerade as one.
  if (!leadType) {
    console.error("swap candidates: could not resolve lead_type", {
      assignmentId: params.id,
      leadId: assignment.lead_id,
    });
    return NextResponse.json(
      { error: "Could not determine this lead's product." },
      { status: 500 }
    );
  }

  // Everything this customer already holds, so the picker cannot offer a
  // duplicate the function would reject.
  const { data: held } = await admin
    .from("lead_assignments")
    .select("lead_id")
    .eq("customer_id", assignment.customer_id);

  const heldIds = new Set((held ?? []).map((r) => r.lead_id as string));

  const search = req.nextUrl.searchParams.get("q")?.trim() ?? "";

  let query = admin
    .from("leads")
    .select(
      "id, lead_name, postcode, lead_type, assignment_count, max_assignments, created_at"
    )
    .eq("lead_type", leadType)
    // A customer's own lead is never swapped in — it belongs to whoever added
    // it, and admin_swap_lead_assignment refuses one (0107). Filtered here as
    // well, because an offered control that 400s reads as a bug (§18E).
    .is("owner_customer_id", null)
    .is("withdrawn_at", null)
    .order("created_at", { ascending: false })
    .limit(200);

  if (search) {
    query = query.or(`lead_name.ilike.%${search}%,postcode.ilike.%${search}%`);
  }

  const { data: leads, error } = await query;

  if (error) {
    console.error("swap candidates lookup failed", error);
    return NextResponse.json({ error: "Could not load leads." }, { status: 500 });
  }

  // Capacity is filtered here rather than in the query: PostgREST cannot
  // compare two columns, so `assignment_count < max_assignments` has to happen
  // after the fetch.
  const candidates = (leads ?? [])
    .filter(
      (l) =>
        !heldIds.has(l.id as string) &&
        (l.assignment_count as number) < (l.max_assignments as number)
    )
    .slice(0, 50);

  return NextResponse.json({ ok: true, candidates });
}

/**
 * Swap a lead out of a customer's pipeline and put another in its place.
 *
 * Every rule lives in admin_swap_lead_assignment, not here, so the route and
 * the function cannot disagree — the same reasoning as the reject route, which
 * deliberately runs no pre-flight check of its own (CLAUDE.md §5E).
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

  let body: { new_lead_id?: unknown };
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

  const admin = createAdminClient();

  const { data, error } = await admin.rpc("admin_swap_lead_assignment", {
    p_assignment_id: params.id,
    p_new_lead_id: newLeadId,
  });

  if (error) {
    console.error("swap lead assignment failed", error);
    // The function raises in plain language for every rule it enforces — won,
    // duplicate, capacity, paused, product mismatch — so the message is worth
    // passing through rather than replacing with something generic.
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
