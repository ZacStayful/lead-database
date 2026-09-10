/**
 * Inbound customer leads (§48) — support ticket STF-0009.
 *
 * A customer's own automation posts an approved landlord here and it becomes a
 * customer-owned lead (§30), exactly as if they had typed it into
 * /dashboard/leads/add. Marcus Chong asked for his Make workflow to create a
 * lead when he approves an enquiry; this is that door.
 *
 * ⚠️ THIS IS NOT PART OF THE PUBLIC API, AND THAT IS DELIBERATE. Everything
 * under /api/v1 and /api/mcp is read-only — all five REST routes export GET and
 * nothing else — and §27.1's standing rule is that no endpoint there takes a
 * query, a table name, a column list or an arbitrary filter. Putting a write
 * beside them would make "the public API is read-only" false, and would invite
 * the next write to arrive as a scope on a key that already reads everything.
 * A separate receiver keeps both sentences true.
 *
 * ⚠️ IT NEVER CHARGES. `POST /api/customer/my-leads` has a `run_analysis`
 * branch that buys the £3 analysis (§31); this route has none, and must not
 * grow one. That branch re-fetches its own origin FORWARDING THE SESSION
 * COOKIE, so it would 401 here anyway — but the reason not to make it work is
 * the decision behind it: an unattended token that can spend a customer's money
 * is a different kind of credential from one that can create a row, and this
 * one lives in a URL path (see leadWebhooks.ts). The response says whether the
 * lead COULD be analysed and links to the page where one click does it.
 *
 * Not to be confused with /api/webhook/n8n, which ingests Stayful's own Monday
 * leads into the marketplace.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { APP_URL } from "@/lib/env";
import { availableLeadTypes } from "@/lib/products";
import { analysability } from "@/lib/leadAnalysis";
import { createOwnedLeads, hasAnyContactDetail } from "@/lib/customerLeads";
import {
  LEAD_WEBHOOK_FIELDS,
  hashLeadWebhookToken,
  toOwnedLeadInput,
} from "@/lib/api/leadWebhooks";
import {
  claimIdempotencyKey,
  releaseClaim,
  settleClaim,
  MAX_IDEMPOTENCY_KEY_LENGTH,
} from "@/lib/api/idempotency";
import {
  LEAD_WEBHOOK_PER_MINUTE,
  RATE_LIMIT_PER_DAY,
  RATE_LIMIT_WINDOW_SECONDS,
  RATE_LIMIT_DAY_SECONDS,
} from "@/lib/api/limits";
import { clientIp, logApiRequest, resolveRequestId } from "@/lib/api/log";
import type { Customer, LeadType } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** What a replay needs in order to rebuild the original answer. */
const REPLAY_COLUMNS = "id, lead_id, outcome";

/**
 * One indistinguishable 404 for every refusal that would otherwise say
 * something about which tokens exist — unknown, revoked, malformed alike. The
 * same discipline `/api/webhook/timelines/[token]` states in its own header.
 */
function notFound() {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export async function POST(
  request: NextRequest,
  { params }: { params: { token: string } }
) {
  const started = Date.now();
  const requestId = resolveRequestId(request);
  const admin = createAdminClient();

  const log = (
    statusCode: number,
    errorCode: string | null,
    customerId: string | null
  ) =>
    logApiRequest(
      {
        requestId,
        surface: "webhook",
        operation: "POST /api/webhook/customer-leads",
        statusCode,
        errorCode,
        // api_request_log.key_id is an FK to customer_api_keys and cannot hold a
        // webhook id, so it stays null — exactly as an OAuth request does
        // (§45.10). The request id is what ties this row to anything.
        keyId: null,
        tokenId: null,
        customerId,
        durationMs: Date.now() - started,
        ip: clientIp(request),
        userAgent: request.headers.get("user-agent"),
      },
      admin
    );

  // ---- Who is this? -------------------------------------------------------
  // The token is matched by HASH, so the raw value exists only in the URL and
  // never in the database.
  const { data: hookRow } = await admin
    .from("customer_lead_webhooks")
    .select("id, customer_id, lead_type, revoked_at")
    .eq("token_hash", hashLeadWebhookToken(params.token))
    .maybeSingle();

  const hook = hookRow as {
    id: string;
    customer_id: string;
    lead_type: LeadType;
    revoked_at: string | null;
  } | null;

  if (!hook || hook.revoked_at) {
    await log(404, "not_found", null);
    return notFound();
  }

  const { data: customerRow } = await admin
    .from("customers")
    .select("*")
    .eq("id", hook.customer_id)
    .maybeSingle();

  const customer = customerRow as Customer | null;
  if (!customer) {
    await log(404, "no_customer", null);
    return notFound();
  }

  // ---- Rate limit, before any work ---------------------------------------
  // Increment then compare, never check then increment — the claim-by-write
  // discipline the whole codebase uses. FAILS CLOSED, as the read surface's
  // limiter does: the moment the limiter breaks is the moment it is under load.
  const { data: limit, error: limitError } = await admin.rpc("consume_api_rate_limit", {
    p_subject_id: hook.id,
    p_customer_id: customer.id,
    p_subject_kind: "webhook",
    p_minute_seconds: RATE_LIMIT_WINDOW_SECONDS,
    p_day_seconds: RATE_LIMIT_DAY_SECONDS,
  });

  if (limitError) {
    console.error("[webhook/customer-leads] rate limiter failed", limitError);
    await log(429, "rate_limited", customer.id);
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const counts = (limit ?? {}) as { minute_count?: number; day_count?: number };
  if (
    (counts.minute_count ?? 0) > LEAD_WEBHOOK_PER_MINUTE ||
    (counts.day_count ?? 0) > RATE_LIMIT_PER_DAY
  ) {
    await log(429, "rate_limited", customer.id);
    return NextResponse.json(
      { error: "Too many requests. Slow down and retry." },
      { status: 429, headers: { "Retry-After": "60" } }
    );
  }

  // ---- May this customer hold a lead of this product? ---------------------
  // `availableLeadTypes` (§32.1), not `holdsProduct`: their own leads stay free
  // through a pause and a cancellation, because the database side is not part
  // of what a subscription buys. What is still required is that they have
  // actually run this pipeline — a GR lead gets GR's stages (invariant 6).
  if (!availableLeadTypes(customer).includes(hook.lead_type)) {
    await log(403, "product_not_held", customer.id);
    return NextResponse.json(
      {
        error:
          "This webhook is for a product this account does not hold. Create a new one for a product you do.",
      },
      { status: 403 }
    );
  }

  // ---- The body -----------------------------------------------------------
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    await log(400, "invalid_json", customer.id);
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const input = toOwnedLeadInput(raw);
  if (!hasAnyContactDetail(input)) {
    await log(400, "no_contact_detail", customer.id);
    return NextResponse.json(
      {
        error:
          "Send at least one of name, email, phone or address. A row with none of them identifies nobody and would be stored as nothing.",
      },
      { status: 400 }
    );
  }

  // ---- The key ------------------------------------------------------------
  // ⚠️ REQUIRED, not optional. `create_customer_leads` dedupes on content, but
  // its identity key needs all three of name, email and phone (§30.3) — so a
  // partial row does not dedupe at all, and a retry after a timeout creates a
  // second landlord. That timeout is precisely what a retrying automation hits,
  // which is the case content-dedupe cannot cover.
  const key = (request.headers.get("idempotency-key") ?? "").trim();
  if (!key) {
    await log(400, "no_idempotency_key", customer.id);
    return NextResponse.json(
      {
        error:
          "Send an Idempotency-Key header — the record id from your own system is the natural value. It is what stops a retry creating the lead twice.",
        code: "idempotency_key_required",
      },
      { status: 400 }
    );
  }
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    await log(400, "idempotency_key_too_long", customer.id);
    return NextResponse.json(
      { error: `Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.` },
      { status: 400 }
    );
  }

  const claim = await claimIdempotencyKey<{
    id: string;
    lead_id: string | null;
    outcome: string | null;
  }>(admin, {
    surface: "customer_leads",
    customerId: customer.id,
    key,
    extra: { webhook_id: hook.id },
    replayColumns: REPLAY_COLUMNS,
  });

  if (claim.status === "error") {
    console.error("[webhook/customer-leads] claim failed", claim.message);
    await log(503, "claim_failed", customer.id);
    return NextResponse.json(
      { error: "Could not accept the lead right now. Retry with the same Idempotency-Key." },
      { status: 503 }
    );
  }

  if (claim.status === "replay") {
    // Rebuilt from the mapping, never from a stored response body — a stored
    // body goes stale the moment anything about the lead changes.
    await log(200, null, customer.id);
    return NextResponse.json(
      await describe(admin, claim.row.lead_id, claim.row.outcome ?? "duplicate", true)
    );
  }

  // ---- Create -------------------------------------------------------------
  // Straight into the path the app's own form uses. It trims, normalises the
  // phone through `normaliseUkMobile` (§40.9A), prefers an explicit postcode
  // over one dug out of the address, derives `postcode_area`, and inserts the
  // lead with its assignment atomically. NO CREATION LOGIC LIVES HERE.
  const { result, error } = await createOwnedLeads(admin, {
    customerId: customer.id,
    leadType: hook.lead_type,
    source: "webhook",
    rows: [input],
  });

  if (error || !result) {
    // ⚠️ THE CLAIM GOES BACK. Left behind, the key is poisoned for ever: every
    // retry finds it and replays a success that created nothing.
    await releaseClaim(admin, "customer_leads", claim.claimId);
    console.error("[webhook/customer-leads] create failed", error);
    await log(400, "create_failed", customer.id);
    return NextResponse.json(
      { error: error ?? "Could not create the lead" },
      { status: 400 }
    );
  }

  const outcome =
    result.created > 0 ? "created" : result.duplicates > 0 ? "duplicate" : "empty";
  const leadId = result.leadIds[0] ?? null;

  await settleClaim(admin, "customer_leads", claim.claimId, {
    lead_id: leadId,
    outcome,
  });

  // Best-effort, after the lead exists. Stamping it first would report a
  // request that then failed.
  void admin
    .from("customer_lead_webhooks")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", hook.id)
    .then(({ error: stampError }) => {
      if (stampError) console.error("[webhook/customer-leads] stamp failed", stampError);
    });

  await log(200, null, customer.id);
  return NextResponse.json(await describe(admin, leadId, outcome, false));
}

/**
 * The answer, with the one field that makes this endpoint worth having.
 *
 * ⚠️ CREATION AND ANALYSIS HAVE DIFFERENT BARS. A lead is created on a name
 * alone; the analyser needs an address, an unambiguous postcode and a bedroom
 * count (§32.5). So a lead can be perfectly real and not analysable, and a
 * caller who does not know that finds out by clicking Analyse on forty leads
 * and having eleven refused. `analysability()` is pure and free, so saying it
 * in the response costs nothing and turns a surprise into a field they can
 * branch on.
 */
async function describe(
  admin: ReturnType<typeof createAdminClient>,
  leadId: string | null,
  outcome: string,
  replayed: boolean
): Promise<Record<string, unknown>> {
  const base: Record<string, unknown> = {
    ok: true,
    outcome,
    replayed,
    lead_id: leadId,
  };
  if (!leadId) return base;

  base.url = `${APP_URL.replace(/\/+$/, "")}/dashboard/leads/${leadId}`;

  const { data } = await admin
    .from("leads")
    .select("lead_type, address, postcode, bedrooms, gross_annual_income")
    .eq("id", leadId)
    .maybeSingle();

  if (data) {
    const verdict = analysability(data as Parameters<typeof analysability>[0]);
    base.analysable = { ok: verdict.ok, code: verdict.code };
  }

  return base;
}

/**
 * A GET is how somebody checks they pasted the URL correctly, and how an
 * automation platform probes an endpoint before saving it. It confirms the
 * token is live and says nothing else — no customer name, no lead counts.
 * An unknown token gets the same 404 as a POST.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: { token: string } }
) {
  const admin = createAdminClient();
  const { data } = await admin
    .from("customer_lead_webhooks")
    .select("id, lead_type, revoked_at")
    .eq("token_hash", hashLeadWebhookToken(params.token))
    .maybeSingle();

  const hook = data as { lead_type: LeadType; revoked_at: string | null } | null;
  if (!hook || hook.revoked_at) return notFound();

  return NextResponse.json({
    ok: true,
    ready: true,
    lead_type: hook.lead_type,
    expects: {
      method: "POST",
      headers: { "Idempotency-Key": "a stable id from your own system" },
      // Named explicitly rather than derived from `toRpcRow`, which also emits
      // the fields we DERIVE (postcode_area). Advertising one of those as an
      // input invites somebody to send it, and it would be ignored.
      body: LEAD_WEBHOOK_FIELDS,
    },
  });
}
