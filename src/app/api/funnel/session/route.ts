import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { entryPointToWrite, isAlreadySetUp, parseSessionRequest } from "@/lib/funnel/session";
import { customersByEmail, readFunnelEnabled } from "@/lib/funnel/server";
import {
  alreadySetUpLoginUrl,
  deriveFunnelToken,
  funnelTokenSecret,
  funnelUrl,
  hashFunnelToken,
} from "@/lib/funnel/token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/funnel/session — n8n asks for an enquirer's funnel link
 * (batch 02 Phase 2). Body: { monday_item_id, name, email, phone,
 * entry_point?, offer_order? }.
 *
 * entry_point and offer_order are batch 03's (0166): which message brought the
 * enquirer in, and which option the instant message put first. Both are
 * optional, so a caller from before 03 keeps working.
 *
 * Bearer N8N_WEBHOOK_SECRET, the /api/webhook/n8n check. n8n branches on
 * `status`, so every outcome a caller can act on is a 200:
 *
 *   created          a new session; `url` is the funnel link
 *   existing         this email already has an unpaid session; same `url` back
 *   already_customer the email holds Management; `loginUrl` instead (02 Phase 2)
 *   funnel_disabled  funnel_enabled is off; send the call route instead
 *
 * ⚠️ THE SAME URL EVERY TIME FOR ONE EMAIL. The token is derived from the
 * session id (funnel/token.ts), and 0165's one-open-session-per-email index
 * makes the session the same row, so n8n asking twice, or a retry after a
 * timeout, sends the enquirer one link, not two.
 *
 * ⚠️ FAILS CLOSED on everything that decides who gets a link: no secret, an
 * unreadable switch, or an unreadable customer list is a refusal, never a link
 * sent to somebody who may already be paying.
 */
export async function POST(request: NextRequest) {
  const auth = request.headers.get("authorization");
  const expected = `Bearer ${process.env.N8N_WEBHOOK_SECRET}`;
  if (!process.env.N8N_WEBHOOK_SECRET || auth !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const secret = funnelTokenSecret();
  if (!secret) {
    console.error("[funnel/session] MESSAGING_TOKEN_SECRET is not set; no link can be minted");
    return NextResponse.json({ code: "not_configured" }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = parseSessionRequest(body);
  if (!parsed.ok) return NextResponse.json({ code: parsed.error }, { status: 400 });
  const req = parsed.value;

  const admin = createAdminClient();
  if (!(await readFunnelEnabled(admin))) {
    return NextResponse.json({ status: "funnel_disabled" });
  }

  const customers = await customersByEmail(admin, req.email);
  if (!customers.ok) {
    console.error("[funnel/session] customer lookup failed", customers.message);
    return NextResponse.json({ code: "lookup_failed" }, { status: 503 });
  }
  if (customers.customers.some(isAlreadySetUp)) {
    return NextResponse.json({ status: "already_customer", loginUrl: alreadySetUpLoginUrl() });
  }

  const existing = await openSessionFor(admin, req.email);
  if (!existing.ok) return NextResponse.json({ code: "lookup_failed" }, { status: 503 });
  if (existing.session) {
    await fillMissing(admin, existing.session, req);
    await recordEntryPoint(admin, existing.session, req);
    return linkResponse("existing", existing.session.id, secret);
  }

  const id = randomUUID();
  const token = deriveFunnelToken(id, secret)!;
  const { error } = await admin.from("funnel_sessions").insert({
    id,
    token_hash: hashFunnelToken(token),
    name: req.name,
    email: req.email,
    phone: req.phone,
    monday_item_id: req.mondayItemId,
    entry_point: req.entryPoint,
    offer_order: req.offerOrder,
  });
  if (error) {
    // 23505 is a second request for the same email landing between our read
    // and our insert: the one-open-per-email index kept it to one row, so
    // return that row's link rather than an error.
    if (error.code === "23505") {
      const raced = await openSessionFor(admin, req.email);
      if (raced.ok && raced.session) return linkResponse("existing", raced.session.id, secret);
    }
    console.error("[funnel/session] insert failed", error.message);
    return NextResponse.json({ code: "insert_failed" }, { status: 500 });
  }
  return linkResponse("created", id, secret);
}

type OpenSession = {
  id: string;
  phone: string | null;
  monday_item_id: string | null;
  entry_point: string | null;
  first_answered_at: string | null;
  answers: Record<string, unknown> | null;
};

async function openSessionFor(
  admin: ReturnType<typeof createAdminClient>,
  email: string
): Promise<{ ok: true; session: OpenSession | null } | { ok: false }> {
  const { data, error } = await admin
    .from("funnel_sessions")
    .select("id, phone, monday_item_id, entry_point, first_answered_at, answers")
    .eq("email", email)
    .neq("step", "paid")
    .maybeSingle();
  if (error) {
    console.error("[funnel/session] session lookup failed", error.message);
    return { ok: false };
  }
  return { ok: true, session: (data as OpenSession | null) ?? null };
}

/**
 * A later request may know what an earlier one did not (the Monday item
 * arrives after the enquiry, or the phone does). Only blanks are filled: a
 * value already stored is never overwritten by a second request, so the link
 * cannot be repointed at a different board item by whoever calls next.
 */
async function fillMissing(
  admin: ReturnType<typeof createAdminClient>,
  session: OpenSession,
  req: { mondayItemId: string | null; phone: string | null }
): Promise<void> {
  const patch: Record<string, string> = {};
  if (!session.monday_item_id && req.mondayItemId) patch.monday_item_id = req.mondayItemId;
  if (!session.phone && req.phone) patch.phone = req.phone;
  if (Object.keys(patch).length === 0) return;
  const { error } = await admin.from("funnel_sessions").update(patch).eq("id", session.id);
  if (error) console.error("[funnel/session] could not fill missing fields", error.message);
}

/**
 * E1 (docs/build/03-phase0-report.md): a later n8n call moves the entry point
 * only while the enquirer has answered nothing (entryPointToWrite), and the
 * write repeats that test in its own WHERE, so an answer saved between our
 * read and this write keeps the entry point it was given.
 *
 * ⚠️ offer_order is never written here. It is set once, by the call that
 * creates the session, because it is the alternate-week test's cohort.
 *
 * Best effort: a failed write costs a reporting label, never the link.
 */
async function recordEntryPoint(
  admin: ReturnType<typeof createAdminClient>,
  session: OpenSession,
  req: { entryPoint: Parameters<typeof entryPointToWrite>[1] }
): Promise<void> {
  const next = entryPointToWrite(session, req.entryPoint);
  if (!next) return;
  const { error } = await admin
    .from("funnel_sessions")
    .update({ entry_point: next })
    .eq("id", session.id)
    .is("first_answered_at", null)
    .neq("step", "paid");
  if (error) console.error("[funnel/session] could not record the entry point", error.message);
}

function linkResponse(status: "created" | "existing", sessionId: string, secret: string) {
  const token = deriveFunnelToken(sessionId, secret)!;
  return NextResponse.json({ status, url: funnelUrl(token) });
}
