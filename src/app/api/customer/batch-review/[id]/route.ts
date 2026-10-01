/**
 * Submit a monthly batch review from the dashboard (§73), behind the session.
 *
 * The same submit path the one-tap link uses (src/lib/batchReview/review.ts).
 * Identity comes from the session through getCurrentCustomer(), never the
 * body, and a review that is not this customer's is the same 404 as one that
 * does not exist.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentCustomer } from "@/lib/auth";
import { reviewForCustomer, submitReview } from "@/lib/batchReview/review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const { customer } = await getCurrentCustomer();
  if (!customer) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const admin = createAdminClient();
  const review = await reviewForCustomer(admin, params.id, customer.id);
  if (!review) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const result = await submitReview(admin, review, body);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true });
}
