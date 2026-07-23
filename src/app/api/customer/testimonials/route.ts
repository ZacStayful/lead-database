import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = 500;

/**
 * Store a testimonial left by the authenticated customer — typically captured
 * at the moment they mark a lead as signed. Writes go through the service role
 * after an auth + ownership check; the browser never inserts directly.
 */
export async function POST(request: NextRequest) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    body?: string;
    lead_assignment_id?: string | null;
    rating?: number | null;
    consent_to_publish?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const text = (body.body ?? "").trim();
  if (!text) {
    return NextResponse.json({ error: "A testimonial is required" }, { status: 400 });
  }
  if (text.length > MAX_BODY) {
    return NextResponse.json(
      { error: `Testimonial must be ${MAX_BODY} characters or fewer` },
      { status: 400 }
    );
  }
  if (
    body.rating !== undefined &&
    body.rating !== null &&
    !(Number.isInteger(body.rating) && body.rating >= 1 && body.rating <= 5)
  ) {
    return NextResponse.json(
      { error: "rating must be an integer 1–5" },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  // Resolve the caller's customer row.
  const { data: customer } = await admin
    .from("customers")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!customer) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const customerId = (customer as { id: string }).id;

  // If a lead is referenced, confirm it belongs to this customer before linking.
  let assignmentId: string | null = null;
  if (body.lead_assignment_id) {
    const { data: assignment } = await admin
      .from("lead_assignments")
      .select("id, customer_id")
      .eq("id", body.lead_assignment_id)
      .maybeSingle();
    if (
      assignment &&
      (assignment as { customer_id: string }).customer_id === customerId
    ) {
      assignmentId = (assignment as { id: string }).id;
    }
  }

  const { data, error } = await admin
    .from("testimonials")
    .insert({
      customer_id: customerId,
      lead_assignment_id: assignmentId,
      body: text,
      rating: body.rating ?? null,
      consent_to_publish: body.consent_to_publish === true,
    })
    .select("id")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true, id: data.id });
}
