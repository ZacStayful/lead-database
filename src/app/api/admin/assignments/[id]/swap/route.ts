import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminUser } from "@/lib/auth";

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
    .select("id, customer_id, lead_id, leads!inner(lead_type)")
    .eq("id", params.id)
    .maybeSingle();

  if (!assignment) {
    return NextResponse.json({ error: "Assignment not found" }, { status: 404 });
  }

  const leadType = (assignment.leads as unknown as { lead_type: string }).lead_type;

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

  return NextResponse.json({ ok: true, assignment_id: data });
}
