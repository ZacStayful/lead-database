import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Set (or clear) the authenticated customer's management client goal.
 *
 * Unlike every other customer write route in this codebase, this one uses NO
 * admin client and never touches the service role. It does not need to: the
 * write goes through set_management_customer_goal (0051), a SECURITY DEFINER
 * function that takes no customer id, resolves the caller from auth.uid()
 * internally and writes exactly two named columns. Calling it through the
 * session client keeps the whole trust boundary inside the database, where it
 * cannot be widened by a mistake in this file.
 *
 * That is also why the route does no ownership check of its own — there is no
 * id here to check. And it does no management-subscription check: the function
 * raises when the caller has no active management subscription, so route and
 * function cannot drift apart (the same reasoning as reject_lead_assignment,
 * CLAUDE.md §5E).
 *
 * Body: { goal: number | null, due?: "YYYY-MM-DD" | null } — null clears the
 * goal (and its date), any integer >= 1 sets it. Zero and negatives are
 * rejected here and again by the function and the column's CHECK constraint.
 * `due` is the date the customer wants it met by (0150, §56); omitted or null
 * means no deadline.
 */
export async function POST(request: NextRequest) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { goal?: unknown; due?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const raw = body?.goal;
  let goal: number | null;

  if (raw === null) {
    goal = null;
  } else if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1) {
    goal = raw;
  } else {
    return NextResponse.json(
      { error: "goal must be a whole number of 1 or more, or null to clear it" },
      { status: 400 }
    );
  }

  let due: string | null = null;
  if (body.due !== undefined && body.due !== null) {
    if (typeof body.due !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.due) || Number.isNaN(Date.parse(body.due))) {
      return NextResponse.json({ error: "due must be a date (YYYY-MM-DD) or null" }, { status: 400 });
    }
    due = body.due;
  }

  // The two-argument signature (0150). Named parameters resolve it; the
  // one-argument form 0051 shipped is untouched and still exists beside it.
  const { data, error } = await supabase.rpc("set_management_customer_goal", {
    p_goal: goal,
    p_due: due,
  });

  if (error) {
    // The function raises for "not a customer" and "no active management
    // subscription". Both are 403 rather than 400: the request was well formed,
    // the caller simply is not entitled to this feature.
    return NextResponse.json({ error: error.message }, { status: 403 });
  }

  // returns table(...) arrives as a one-row array.
  const row = (Array.isArray(data) ? data[0] : data) as
    | { goal: number | null; goal_updated_at: string | null; goal_due: string | null }
    | undefined;

  return NextResponse.json({
    ok: true,
    management_customer_goal: row?.goal ?? null,
    management_customer_goal_updated_at: row?.goal_updated_at ?? null,
    management_customer_goal_due: row?.goal_due ?? null,
  });
}
