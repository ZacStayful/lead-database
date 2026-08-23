import { NextResponse, type NextRequest } from "next/server";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendFilterLiftScheduledEmail } from "@/lib/emails";
import { formatDate } from "@/lib/utils";
import {
  fetchLeadVolumeAggregate,
  fetchAreaContention,
  predictMonthlyVolume,
} from "@/lib/filterPrediction";
import { quoteGuarantee } from "@/lib/filterGuarantee";
import type { Customer, LeadType } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Action = "apply" | "lift" | "cancel_lift";

/** Column names differ per product; resolve them from the lead type. */
function cols(product: LeadType) {
  if (product === "guaranteed_rent") {
    return {
      status: "gr_filter_status",
      areas: "gr_filter_areas",
      min: "gr_filter_min_bedrooms",
      max: "gr_filter_max_bedrooms",
      enabledAt: "gr_filter_enabled_at",
      liftDate: "gr_filter_lift_effective_date",
      selectionMode: "gr_filter_selection_mode",
      radiusOutcode: "gr_filter_radius_outcode",
      radiusMiles: "gr_filter_radius_miles",
      guaranteedLeads: "gr_filter_guaranteed_leads",
      guaranteeEstimate: "gr_filter_guarantee_estimate",
      guaranteeLikelihood: "gr_filter_guarantee_likelihood_pct",
      guaranteeCostPence: "gr_filter_guarantee_cost_per_lead_pence",
      guaranteePricePence: "gr_filter_guarantee_plan_price_pence",
      guaranteeAcceptedAt: "gr_filter_guarantee_accepted_at",
      anchor: "gr_billing_cycle_anchor" as keyof Customer,
      balance: "gr_lead_balance" as keyof Customer,
      allocation: "gr_monthly_allocation" as keyof Customer,
      statusField: "gr_filter_status" as keyof Customer,
      guaranteeCredit: "gr_filter_guarantee_credit" as keyof Customer,
    };
  }
  return {
    status: "filter_status",
    areas: "filter_areas",
    min: "filter_min_bedrooms",
    max: "filter_max_bedrooms",
    enabledAt: "filter_enabled_at",
    liftDate: "filter_lift_effective_date",
    selectionMode: "filter_selection_mode",
    radiusOutcode: "filter_radius_outcode",
    radiusMiles: "filter_radius_miles",
    guaranteedLeads: "filter_guaranteed_leads",
    guaranteeEstimate: "filter_guarantee_estimate",
    guaranteeLikelihood: "filter_guarantee_likelihood_pct",
    guaranteeCostPence: "filter_guarantee_cost_per_lead_pence",
    guaranteePricePence: "filter_guarantee_plan_price_pence",
    guaranteeAcceptedAt: "filter_guarantee_accepted_at",
    anchor: "billing_cycle_anchor" as keyof Customer,
    balance: "lead_balance" as keyof Customer,
    allocation: "monthly_allocation" as keyof Customer,
    statusField: "filter_status" as keyof Customer,
    guaranteeCredit: "filter_guarantee_credit" as keyof Customer,
  };
}

/** The customer's next billing renewal date for a product (anchor + 1 month). */
function nextBillingDate(anchor: string | null): Date {
  if (anchor) {
    const a = new Date(anchor);
    if (!isNaN(a.getTime())) {
      const next = new Date(a);
      next.setMonth(next.getMonth() + 1);
      return next;
    }
  }
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 1);
}

function isProduct(v: unknown): v is LeadType {
  return v === "management" || v === "guaranteed_rent";
}

export async function POST(req: NextRequest) {
  const { user, customer } = await getCurrentCustomer();
  if (!user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  if (!customer) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }

  let body: {
    action?: Action;
    product?: unknown;
    areas?: unknown;
    min_bedrooms?: unknown;
    max_bedrooms?: unknown;
    selection_mode?: unknown;
    radius_outcode?: unknown;
    radius_miles?: unknown;
    accept_guarantee?: unknown;
    quoted_guaranteed_leads?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const product: LeadType = isProduct(body.product) ? body.product : "management";
  const c = cols(product);
  const admin = createAdminClient();
  const currentStatus = String(customer[c.statusField] ?? "off");

  if (body.action === "apply") {
    // Normalise + validate the selections.
    const areas = Array.isArray(body.areas)
      ? Array.from(
          new Set(
            body.areas
              .filter((a): a is string => typeof a === "string")
              .map((a) => a.trim().toUpperCase())
              .filter(Boolean)
          )
        )
      : [];
    const min = toIntOrNull(body.min_bedrooms);
    const max = toIntOrNull(body.max_bedrooms);

    if (min !== null && min < 0) {
      return NextResponse.json(
        { error: "Minimum bedrooms cannot be negative." },
        { status: 400 }
      );
    }
    if (min !== null && max !== null && max < min) {
      return NextResponse.json(
        { error: "Maximum bedrooms cannot be less than minimum bedrooms." },
        { status: 400 }
      );
    }
    if (areas.length === 0 && min === null && max === null) {
      return NextResponse.json(
        { error: "Choose at least one area or a bedroom range." },
        { status: 400 }
      );
    }

    // How the selection was made — metadata for admin (0094). Routing reads
    // only the areas; an unrecognised or absent mode is stored as hand-picked
    // and the radius details are kept only when the mode really was radius.
    const selectionMode =
      body.selection_mode === "radius" ? "radius" : "areas";
    const radiusOutcode =
      selectionMode === "radius" &&
      typeof body.radius_outcode === "string" &&
      /^[A-Z]{1,2}\d[A-Z0-9]?$/.test(body.radius_outcode.trim().toUpperCase())
        ? body.radius_outcode.trim().toUpperCase()
        : null;
    const radiusMiles =
      selectionMode === "radius" ? toIntOrNull(body.radius_miles) : null;

    // ---------------------------------------------------------------------
    // Re-derive the guarantee HERE. The client sends intent; the server sends
    // the number.
    //
    // The panel computes the same quote to render it, but a request can claim
    // anything, and this one sets a price. Recomputing from the server's own
    // normalised `areas` — the exact uppercased values about to be written to
    // filter_areas and matched by get_filtered_candidates_for_lead — also means
    // the quote and the routing cannot disagree about what was selected.
    // ---------------------------------------------------------------------
    const allocation = Number(customer[c.allocation] ?? 0);
    const [aggregate, contention] = await Promise.all([
      fetchLeadVolumeAggregate(admin),
      fetchAreaContention(admin, product, customer.id),
    ]);
    const prediction = predictMonthlyVolume(
      aggregate[product],
      { areas, minBedrooms: min, maxBedrooms: max },
      contention
    );
    const quote = quoteGuarantee(prediction, allocation, product);

    // Ingest moves between the panel rendering a quote and the customer
    // accepting it. Consent is to a SPECIFIC number — the panel already voids
    // its own acceptance when the selection changes — so a guarantee that has
    // shifted underneath must be re-shown rather than quietly substituted.
    const quotedLeads = toIntOrNull(body.quoted_guaranteed_leads);
    if (quotedLeads !== null && quotedLeads !== quote.guaranteed) {
      return NextResponse.json(
        {
          error:
            "Lead volumes moved while you were choosing. Here is the current guarantee.",
          code: "guarantee_changed",
          guarantee: quote,
        },
        { status: 409 }
      );
    }

    if (quote.reducesGuarantee && body.accept_guarantee !== true) {
      return NextResponse.json(
        {
          error: "Accept the reduced volume guarantee to apply this filter.",
          code: "guarantee_not_accepted",
          guarantee: quote,
        },
        { status: 400 }
      );
    }

    const update: Record<string, unknown> = {
      [c.status]: "active",
      [c.areas]: areas.length > 0 ? areas : null,
      [c.min]: min,
      [c.max]: max,
      [c.liftDate]: null, // applying/editing cancels any scheduled lift
      [c.selectionMode]: selectionMode,
      [c.radiusOutcode]: radiusOutcode,
      [c.radiusMiles]:
        radiusMiles !== null && radiusMiles > 0 && radiusMiles <= 200
          ? radiusMiles
          : null,
      // From `quote`, never from the body. Cleared when nothing is offerable so
      // a stale guarantee cannot outlive the filter that earned it.
      [c.guaranteedLeads]: quote.offerable ? quote.guaranteed : null,
      [c.guaranteeEstimate]: quote.offerable ? quote.estimate : null,
      [c.guaranteeLikelihood]: quote.offerable ? quote.likelihoodPct : null,
      [c.guaranteeCostPence]: quote.offerable ? quote.costPerLeadPence : null,
      [c.guaranteePricePence]: quote.offerable ? quote.planPricePence : null,
      // Re-stamped on every apply, including an EDIT of a live filter: the
      // areas changed, so the guarantee is a new promise about a new selection.
      // This is why it cannot share filter_enabled_at, which is deliberately
      // preserved across edits below.
      [c.guaranteeAcceptedAt]: quote.offerable
        ? new Date().toISOString()
        : null,
      updated_at: new Date().toISOString(),
    };

    // A fresh enable (off -> active) stamps filter_enabled_at and immediately
    // forfeits any carried-forward credit surplus. Editing an already-active
    // filter keeps the original timestamp and balance.
    if (currentStatus === "off") {
      update[c.enabledAt] = new Date().toISOString();
      const balance = Number(customer[c.balance] ?? 0);
      // Carried plan surplus is forfeited by choice. Compensation we OWED for
      // missing a guarantee is not the customer's choice to forfeit, and
      // confiscating it for an action that looks unrelated would be
      // indefensible — so the clamp spares it.
      //
      // Only the EXCESS above the allocation is ever at risk, so only that has
      // to be protected, and protecting at most the excess means this can never
      // hand back more than the customer already had. That matters because
      // filter_guarantee_credit is CUMULATIVE and never decrements as credits
      // are spent: after a year it can exceed the whole balance, and treating
      // it as "how much of today's balance is owed" would invent leads.
      //
      // The imprecision that remains runs in the customer's favour. A customer
      // credited leads long ago and since spent them keeps a little plan
      // surplus they would otherwise forfeit. Tracking it exactly would mean
      // decrementing the counter inside assign_lead_to_customer — a privileged
      // function whose ACL a create-or-replace would discard (§11) — which is a
      // poor trade for a rounding error that never costs the customer.
      const owed = Number(customer[c.guaranteeCredit] ?? 0);
      const excess = Math.max(balance - allocation, 0);
      const spared = Math.min(owed, excess);
      update[c.balance] = Math.min(balance, allocation) + spared;
    }

    const { error } = await admin
      .from("customers")
      .update(update)
      .eq("id", customer.id);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // History, best-effort. A guarantee disputed in six months should be
    // traceable to what was actually shown and agreed — but a failure to
    // RECORD that must never fail the apply the customer just made, so this is
    // logged and swallowed. Nothing reads this table to decide anything.
    if (quote.offerable) {
      const { error: auditError } = await admin
        .from("filter_guarantee_acceptances")
        .insert({
          customer_id: customer.id,
          lead_type: product,
          guaranteed_leads: quote.guaranteed,
          estimate: quote.estimate,
          likelihood_pct: quote.likelihoodPct,
          cost_per_lead_pence: quote.costPerLeadPence,
          plan_price_pence: quote.planPricePence,
          monthly_allocation: allocation,
          areas: areas.length > 0 ? areas : null,
          min_bedrooms: min,
          max_bedrooms: max,
          selection_mode: selectionMode,
          accepted_by_user_id: user.id,
        });
      if (auditError) {
        console.error("guarantee acceptance audit insert failed", auditError);
      }
    }

    return NextResponse.json({ ok: true, status: "active", guarantee: quote });
  }

  if (body.action === "lift") {
    if (currentStatus !== "active") {
      return NextResponse.json(
        { error: "No active filter to lift." },
        { status: 400 }
      );
    }
    const effective = nextBillingDate(
      (customer[c.anchor] as string | null) ?? null
    );
    const effectiveIso = effective.toISOString().slice(0, 10);

    const { error } = await admin
      .from("customers")
      .update({
        [c.status]: "pending_lift",
        [c.liftDate]: effectiveIso,
        updated_at: new Date().toISOString(),
      })
      .eq("id", customer.id);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const friendly = formatDate(effectiveIso);
    await admin.from("notifications").insert({
      customer_id: customer.id,
      notification_type: "filter_lift_scheduled",
      message: `Your filter will lift at the start of your next billing cycle on ${friendly}. Until then, you'll continue to receive only leads matching your current filter. You can cancel this request anytime before then.`,
    });
    await sendFilterLiftScheduledEmail({
      to: customer.email,
      effectiveDate: friendly,
    });

    return NextResponse.json({
      ok: true,
      status: "pending_lift",
      effective_date: effectiveIso,
    });
  }

  if (body.action === "cancel_lift") {
    if (currentStatus !== "pending_lift") {
      return NextResponse.json(
        { error: "No pending lift to cancel." },
        { status: 400 }
      );
    }
    const { error } = await admin
      .from("customers")
      .update({
        [c.status]: "active",
        [c.liftDate]: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", customer.id);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, status: "active" });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

function toIntOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}
