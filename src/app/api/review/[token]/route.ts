/**
 * Submit a monthly batch review from the one-tap email link (§73).
 *
 * No session, by design: the token is the authorisation, and it opens exactly
 * one review. What may be written is decided in src/lib/batchReview/review.ts,
 * which checks every row against that review's own customer. A token proves
 * which batch this is, never anything about another one.
 *
 * Every refusal for a bad or expired token is the same 404, so the endpoint
 * cannot be used to tell which tokens once existed.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { reviewByToken, submitReview } from "@/lib/batchReview/review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, { params }: { params: { token: string } }) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const admin = createAdminClient();
  const lookup = await reviewByToken(admin, params.token);
  if (lookup.status !== "valid") {
    return NextResponse.json(
      { error: "This link has expired. Sign in to see your leads." },
      { status: 404 }
    );
  }

  const result = await submitReview(admin, lookup.review, body);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true });
}
