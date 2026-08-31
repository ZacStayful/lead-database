/**
 * Where a landlord's answers land (§41).
 *
 * ⚠️ UNAUTHENTICATED BY DESIGN. The caller is a member of the public holding an
 * HMAC token from an email we sent them. `middleware.ts` matches only
 * /dashboard and /admin, so this is public with no matcher change — which means
 * every guard has to be here.
 *
 * WHAT THE TOKEN PERMITS, AND NOTHING MORE: writing four preference columns on
 * ONE lead. It reads nothing back, reveals no operator, and cannot reach
 * another lead. A forged, expired or truncated token is indistinguishable from
 * a valid one pointing at a lead that does not exist — both 404.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { verifyReferralToken } from "@/lib/landlordReferralToken";
import { validateAnswers } from "@/lib/landlordQuestions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Best-effort, per instance. The token is unguessable so the surface is small;
 * this is here to stop one tab hammering, not a determined attacker — the same
 * position /api/auth/forgot-password takes about its own throttle (§15).
 */
const HITS = new Map<string, { n: number; until: number }>();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;

function throttled(key: string): boolean {
  const now = Date.now();
  const hit = HITS.get(key);
  if (!hit || hit.until < now) {
    HITS.set(key, { n: 1, until: now + WINDOW_MS });
    return false;
  }
  hit.n += 1;
  return hit.n > MAX_PER_WINDOW;
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const token =
    typeof (body as { token?: unknown })?.token === "string"
      ? ((body as { token: string }).token)
      : "";

  const leadId = verifyReferralToken(token);
  if (!leadId) {
    // Byte-identical to the not-found case below, so the endpoint cannot be
    // used to learn which leads exist.
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (throttled(token)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const verdict = validateAnswers(body);
  if (!verdict.ok) {
    // An empty submit is a no-op, not an error the landlord has to solve.
    if (verdict.reason === "empty") return NextResponse.json({ ok: true, saved: false });
    return NextResponse.json({ error: "Invalid submission" }, { status: 400 });
  }

  const admin = createAdminClient();

  // The lead must exist and must actually have been referred. A token for a
  // lead nobody was ever introduced to is not a route into the table.
  const { data: lead } = await admin
    .from("leads")
    .select("id, landlord_referral_first_sent_at, landlord_prefs_step")
    .eq("id", leadId)
    .maybeSingle();

  const row = lead as
    | { id: string; landlord_referral_first_sent_at: string | null; landlord_prefs_step: number }
    | null;

  if (!row || !row.landlord_referral_first_sent_at) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { answers } = verdict;
  const step =
    typeof (body as { step?: unknown })?.step === "number"
      ? Math.max(0, Math.min(10, Math.floor((body as { step: number }).step)))
      : row.landlord_prefs_step;

  // Only write what this submission actually carried. Each card posts as the
  // landlord answers it, so a later step must never null an earlier answer.
  const patch: Record<string, unknown> = {
    // Never goes backwards: a re-submitted earlier card should not rewind the
    // progress figure the drop-off measurement reads.
    landlord_prefs_step: Math.max(step, row.landlord_prefs_step ?? 0),
    landlord_prefs_submitted_at: new Date().toISOString(),
  };
  if (answers.contactMethod) patch.landlord_contact_method = answers.contactMethod;
  if (answers.contactTime) patch.landlord_contact_time = answers.contactTime;
  if (answers.wants) patch.landlord_wants = answers.wants;
  if (answers.note) patch.landlord_note = answers.note;

  const { error } = await admin.from("leads").update(patch).eq("id", leadId);
  if (error) {
    return NextResponse.json({ error: "Could not save" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, saved: true });
}
