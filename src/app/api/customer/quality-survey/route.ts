import { NextResponse, type NextRequest } from "next/server";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { currentCycle } from "@/lib/quality/cycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATING_FIELDS = [
  "overall_rating",
  "contactability_rating",
  "fit_rating",
] as const;

/**
 * POST /api/customer/quality-survey
 *
 * Records the authenticated customer's cycle-end view of lead quality.
 *
 * This is deliberately separate from the dead-lead claim flow and carries no
 * credit of any kind, so nothing a customer says here can win or lose them
 * anything. That is what makes it usable as a quality signal: the answers are
 * not shaped by an incentive. One row per customer per cycle, keyed on the
 * cycle start date, upserted so a customer can revise their answers.
 */
export async function POST(request: NextRequest) {
  const { user, customer } = await getCurrentCustomer();
  if (!user || !customer) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const ratings: Record<string, number | null> = {};
  for (const field of RATING_FIELDS) {
    const value = body[field];
    if (value === undefined || value === null || value === "") {
      ratings[field] = null;
      continue;
    }
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 5) {
      return NextResponse.json(
        { error: `${field} must be a whole number from 1 to 5` },
        { status: 400 }
      );
    }
    ratings[field] = n;
  }

  if (ratings.overall_rating === null) {
    return NextResponse.json(
      { error: "Please give an overall rating" },
      { status: 400 }
    );
  }

  const improve =
    typeof body.what_would_improve === "string"
      ? body.what_would_improve.trim().slice(0, 4000)
      : null;

  const admin = createAdminClient();
  const cycle = currentCycle(customer);

  const { count } = await admin
    .from("lead_assignments")
    .select("id", { count: "exact", head: true })
    .eq("customer_id", customer.id)
    .gte("assigned_at", cycle.start.toISOString())
    .lt("assigned_at", cycle.end.toISOString());

  const { error } = await admin.from("cycle_quality_surveys").upsert(
    {
      customer_id: customer.id,
      cycle_start: cycle.startDate,
      cycle_end: cycle.endDate,
      leads_in_cycle: count ?? 0,
      ...ratings,
      what_would_improve: improve || null,
      submitted_at: new Date().toISOString(),
    },
    { onConflict: "customer_id,cycle_start" }
  );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
