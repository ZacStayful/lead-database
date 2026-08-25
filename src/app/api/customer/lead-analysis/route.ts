import { NextResponse, type NextRequest } from "next/server";
import { getStripe } from "@/lib/stripe";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  LEAD_ANALYSIS_PRICE_PENCE,
  MAX_ANALYSIS_ROWS,
  analysisQuote,
  describeIneligibility,
} from "@/lib/leadAnalysis";
import {
  ANALYSIS_TOKEN_TTL_MS,
  analysisIneligibilityReason,
  chargeClaimedAnalysis,
  generateAnalysisToken,
  type ClaimedAnalysis,
} from "@/lib/leadAnalysisCharge";
import type { Customer, LeadType } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * How recently a paid analysis job for the same customer blocks another.
 *
 * The token claim stops one job being charged twice, but a double-submitted
 * button would create two JOBS and mint a token for each. This is the
 * server-side backstop for that; the UI's arm-then-confirm is the first one.
 * Deliberately brief — buying a second batch straight after a first is a
 * perfectly ordinary thing to do.
 */
const REPEAT_GUARD_MS = 30_000;

/**
 * Buy analysis for a set of leads the customer already owns.
 *
 * ── The order, which is the whole safety story ──────────────────────
 *
 *   1. Re-derive eligibility and the price SERVER-SIDE from `leads`. The
 *      browser proposes a list of ids; it never proposes a count or an amount.
 *      This is the discipline the import commit already follows (§30.6), and
 *      here it is the difference between a price and a suggestion.
 *   2. Create the job `awaiting_payment` with its rows.
 *   3. Mint and claim a token — the claim is the single-charge guard.
 *   4. Charge.
 *   5. Only a successful charge flips the job to `running`, which is the only
 *      thing that makes its rows claimable by the worker.
 *
 * The leads themselves are NOT created here and are never at risk: they were
 * imported or typed in for free, before any of this, so a declined card costs
 * the customer nothing but the analysis.
 */
export async function POST(request: NextRequest) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { lead_ids?: unknown; lead_type?: unknown; source?: unknown; import_id?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const leadIds = Array.isArray(body.lead_ids)
    ? Array.from(new Set(body.lead_ids.filter((v): v is string => typeof v === "string")))
    : [];
  if (!leadIds.length) {
    return NextResponse.json({ status: "failed", message: "No leads selected." }, { status: 400 });
  }
  if (leadIds.length > MAX_ANALYSIS_ROWS) {
    // Rejected rather than truncated, like the import cap it sits behind:
    // quietly analysing the first 200 of somebody's 500 is a loss nobody
    // notices until they go looking for a property that was never run.
    return NextResponse.json(
      {
        status: "failed",
        message: `That is more than ${MAX_ANALYSIS_ROWS} leads at once. Run them in smaller batches.`,
      },
      { status: 400 }
    );
  }

  const leadType: LeadType = body.lead_type === "guaranteed_rent" ? "guaranteed_rent" : "management";
  const source =
    body.source === "manual" || body.source === "detail" ? (body.source as string) : "import";

  const admin = createAdminClient();
  const { data: customerRow } = await admin
    .from("customers")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  const customer = customerRow as Customer | null;
  if (!customer) {
    return NextResponse.json(
      { status: "failed", message: "We couldn't find your customer record." },
      { status: 404 }
    );
  }

  const reason = analysisIneligibilityReason(customer, leadType);
  if (reason) {
    return NextResponse.json({ status: "failed", message: reason }, { status: 409 });
  }

  if (!customer.stripe_customer_id) {
    return NextResponse.json(
      {
        status: "failed",
        message: "We couldn't find a billing account on file. Please contact support.",
      },
      { status: 402 }
    );
  }

  // ── 1. Re-derive from the leads themselves ────────────────────────
  // Scoped to this owner and this product: `owner_customer_id` is what makes a
  // lead theirs, and asking for somebody else's id simply returns nothing.
  const { data: leadRows, error: leadError } = await admin
    .from("leads")
    .select("id, lead_type, address, postcode, bedrooms, gross_annual_income")
    .in("id", leadIds)
    .eq("owner_customer_id", customer.id)
    .eq("lead_type", leadType);

  if (leadError) {
    console.error("lead-analysis: lead lookup failed", leadError);
    return NextResponse.json(
      { status: "failed", message: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }

  const leads = (leadRows ?? []) as Array<{
    id: string;
    lead_type: LeadType;
    address: string | null;
    postcode: string | null;
    bedrooms: string | null;
    gross_annual_income: number | null;
  }>;

  // Anything already queued is excluded up front rather than charged and
  // refunded — we never refund by exclusion.
  const { data: openRows } = await admin
    .from("lead_analysis_rows")
    .select("lead_id")
    .in("lead_id", leads.map((l) => l.id))
    .in("status", ["pending", "claimed", "running"]);
  const alreadyQueued = new Set((openRows ?? []).map((r) => (r as { lead_id: string }).lead_id));

  const quote = analysisQuote(leads.filter((l) => !alreadyQueued.has(l.id)));

  if (!quote.eligible.length) {
    return NextResponse.json(
      {
        status: "failed",
        message: "None of those leads can be analysed yet.",
        ineligible: quote.ineligible.map((x) => ({
          lead_id: x.lead.id,
          code: x.code,
          reason: describeIneligibility(x.code),
        })),
      },
      { status: 400 }
    );
  }

  // ── Double-submit backstop (see REPEAT_GUARD_MS) ──────────────────
  const since = new Date(Date.now() - REPEAT_GUARD_MS).toISOString();
  const { data: recent } = await admin
    .from("payments")
    .select("id")
    .eq("customer_id", customer.id)
    .eq("payment_type", "lead_analysis")
    .eq("status", "paid")
    .gte("created_at", since)
    .limit(1);
  if (recent && recent.length > 0) {
    return NextResponse.json(
      {
        status: "failed",
        message: "You've just bought analysis — those leads are already running.",
      },
      { status: 429 }
    );
  }

  // ── 2. The job, awaiting payment ──────────────────────────────────
  const amountPence = quote.eligible.length * LEAD_ANALYSIS_PRICE_PENCE;
  const { data: jobRow, error: jobError } = await admin
    .from("lead_analysis_jobs")
    .insert({
      customer_id: customer.id,
      lead_type: leadType,
      source,
      import_id: typeof body.import_id === "string" ? body.import_id : null,
      status: "awaiting_payment",
      row_count: quote.eligible.length,
      amount_pence: amountPence,
    })
    .select("id")
    .single();

  if (jobError || !jobRow) {
    console.error("lead-analysis: job insert failed", jobError);
    return NextResponse.json(
      { status: "failed", message: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }

  const jobId = (jobRow as { id: string }).id;

  const { error: rowsError } = await admin
    .from("lead_analysis_rows")
    .insert(quote.eligible.map((lead) => ({ job_id: jobId, lead_id: lead.id })));

  if (rowsError) {
    console.error("lead-analysis: rows insert failed", rowsError);
    // Nothing has been charged; drop the empty job rather than leave it.
    await admin.from("lead_analysis_jobs").delete().eq("id", jobId);
    return NextResponse.json(
      { status: "failed", message: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }

  // ── 3. Mint and claim ─────────────────────────────────────────────
  const { raw, hash } = generateAnalysisToken();
  const { error: tokenError } = await admin.from("lead_analysis_tokens").insert({
    customer_id: customer.id,
    job_id: jobId,
    lead_type: leadType,
    token_hash: hash,
    row_count: quote.eligible.length,
    amount_pence: amountPence,
    expires_at: new Date(Date.now() + ANALYSIS_TOKEN_TTL_MS).toISOString(),
  });
  if (tokenError) {
    console.error("lead-analysis: token insert failed", tokenError);
    await admin.from("lead_analysis_jobs").delete().eq("id", jobId);
    return NextResponse.json(
      { status: "failed", message: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }
  // `raw` is never sent anywhere: this token exists only so the claim below can
  // be the single-charge guard.
  void raw;

  const { data: claimed, error: claimError } = await admin.rpc("claim_lead_analysis_token", {
    p_token_hash: hash,
  });
  if (claimError) {
    console.error("claim_lead_analysis_token failed", claimError);
    return NextResponse.json(
      { status: "failed", message: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }

  const claim = (Array.isArray(claimed) ? claimed[0] : claimed) as ClaimedAnalysis | undefined;
  if (!claim) {
    return NextResponse.json(
      { status: "failed", message: "That purchase is already being processed. Please refresh." },
      { status: 409 }
    );
  }

  // ── 4/5. Charge, and let the work start ───────────────────────────
  const outcome = await chargeClaimedAnalysis(admin, getStripe(), claim);

  const shared = {
    job_id: jobId,
    lead_count: quote.eligible.length,
    amount_pence: amountPence,
    ineligible: quote.ineligible.map((x) => ({
      lead_id: x.lead.id,
      code: x.code,
      reason: describeIneligibility(x.code),
    })),
  };

  switch (outcome.kind) {
    case "success":
      // Best-effort kick so the queue starts draining now rather than at the
      // next five-minute cron. Nothing depends on it landing.
      void kickWorker(request);
      return NextResponse.json({ status: "success", ...shared });
    case "redirect":
      return NextResponse.json({ status: "redirect", url: outcome.url, ...shared });
    case "pending":
      return NextResponse.json({ status: "pending", message: outcome.message, ...shared }, { status: 202 });
    case "failed":
      return NextResponse.json({ status: "failed", message: outcome.message, ...shared }, { status: 402 });
  }
}

/**
 * Nudge the worker.
 *
 * Fire-and-forget, and deliberately un-awaited: the purchase has already
 * succeeded and must not be held up, nor failed, by a kick that does not land.
 * The five-minute cron is what guarantees the queue drains.
 */
function kickWorker(request: NextRequest): void {
  const secret = process.env.CRON_SECRET;
  if (!secret) return;
  const base = process.env.NEXT_PUBLIC_APP_URL ?? request.nextUrl.origin;
  void fetch(`${base}/api/cron/run-lead-analysis`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
    cache: "no-store",
  }).catch(() => {
    /* the cron is the guarantee; this is only a head start */
  });
}
