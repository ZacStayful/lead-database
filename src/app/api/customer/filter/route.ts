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
import { forecastVolume } from "@/lib/filterForecast";
import {
  canSpendRefund,
  releaseCount,
  type ReleaseChoice,
} from "@/lib/filterRelease";
import type { Customer, LeadType } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The apply path already pages the whole leads table twice to derive the
// forecast, and now runs the release RPC on top. Still comfortably inside the
// Hobby 60s function cap (CLAUDE.md §2), but the route declared no budget at
// all before, which is how a route quietly starts being cut short.
export const maxDuration = 60;

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
      expectedLeads: "gr_filter_expected_leads",
      forecastEstimate: "gr_filter_forecast_estimate",
      forecastLikelihood: "gr_filter_forecast_likelihood_pct",
      forecastCostPence: "gr_filter_forecast_cost_per_lead_pence",
      forecastPricePence: "gr_filter_forecast_plan_price_pence",
      forecastAcknowledgedAt: "gr_filter_forecast_acknowledged_at",
      anchor: "gr_billing_cycle_anchor" as keyof Customer,
      balance: "gr_lead_balance" as keyof Customer,
      allocation: "gr_monthly_allocation" as keyof Customer,
      statusField: "gr_filter_status" as keyof Customer,
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
    expectedLeads: "filter_expected_leads",
    forecastEstimate: "filter_forecast_estimate",
    forecastLikelihood: "filter_forecast_likelihood_pct",
    forecastCostPence: "filter_forecast_cost_per_lead_pence",
    forecastPricePence: "filter_forecast_plan_price_pence",
    forecastAcknowledgedAt: "filter_forecast_acknowledged_at",
    anchor: "billing_cycle_anchor" as keyof Customer,
    balance: "lead_balance" as keyof Customer,
    allocation: "monthly_allocation" as keyof Customer,
    statusField: "filter_status" as keyof Customer,
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
    acknowledge_forecast?: unknown;
    quoted_expected_leads?: unknown;
    existing_leads?: unknown;
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
    // Re-derive the forecast HERE. The client sends intent; the server sends
    // the number.
    //
    // The panel computes the same forecast to render it, but a request can claim
    // anything, and this one sets a price. Recomputing from the server's own
    // normalised `areas` — the exact uppercased values about to be written to
    // filter_areas and matched by get_filtered_candidates_for_lead — also means
    // the quote and the routing cannot disagree about what was selected.
    // ---------------------------------------------------------------------
    const allocation = Number(customer[c.allocation] ?? 0);
    // Credits they can still spend. Read once, here, and used both to size the
    // give-back and to report back to the panel. The WRITE that clamps it on a
    // fresh enable happens under the row lock in the RPC, not from this value.
    const balance = Number(customer[c.balance] ?? 0);
    const [aggregate, contention] = await Promise.all([
      fetchLeadVolumeAggregate(admin),
      fetchAreaContention(admin, product, customer.id),
    ]);
    const prediction = predictMonthlyVolume(
      aggregate[product],
      { areas, minBedrooms: min, maxBedrooms: max },
      contention
    );
    const forecast = forecastVolume(prediction, allocation, product);

    // Ingest moves between the panel rendering a forecast and the customer
    // applying it. The acknowledgement is to a SPECIFIC number — the panel
    // already voids its own when the selection changes — so a figure that has
    // shifted underneath must be re-shown rather than quietly substituted.
    //
    // This check matters MORE now that nothing is credited, not less. When a
    // shortfall was made good, being applied against a number you had not seen
    // cost you nothing in the end. Now the number you were shown is the whole
    // of what you were told, so it is the only thing there is to get right.
    const quotedLeads = toIntOrNull(body.quoted_expected_leads);
    if (quotedLeads !== null && quotedLeads !== forecast.expected) {
      return NextResponse.json(
        {
          error:
            "Lead volumes moved while you were choosing. Here is the current forecast.",
          code: "forecast_changed",
          forecast,
        },
        { status: 409 }
      );
    }

    if (forecast.reducesVolume && body.acknowledge_forecast !== true) {
      return NextResponse.json(
        {
          error:
            "Confirm you've read the expected lead volume to apply this filter.",
          code: "forecast_not_acknowledged",
          forecast,
        },
        { status: 400 }
      );
    }

    // ---------------------------------------------------------------------
    // Leads they are already holding.
    //
    // Applying a filter has always been instant for FUTURE leads. It is supply
    // that is not: `(gr_)lead_balance` gates allocation, so a customer who has
    // spent this cycle's credits receives nothing — filtered or not — until
    // `invoice.paid` tops them up, which is why filtering reads as something
    // that "starts next month". Their untouched, non-matching held leads are
    // the missing credits.
    //
    // ⚠️ ORDER MATTERS AND IS FIXED (see the two refusals above): forecast
    // acknowledgement, then forecast freshness, then this. The client sends
    // `acknowledge_forecast`, `quoted_expected_leads` and `existing_leads` in
    // ONE request, so a forecast that moves while the customer is deciding
    // cannot silently discard the choice they just made.
    //
    // The question is skipped entirely — filter applies, nothing released —
    // when there is nothing to release, when no forecast could be offered (the
    // keep branch has no number to size a release with), or when the account
    // could not spend a refunded credit anyway.
    const refundable = canSpendRefund(customer, product);
    const { data: releasableRows, error: releasableError } = await admin.rpc(
      "releasable_filter_assignments",
      {
        p_customer_id: customer.id,
        p_lead_type: product,
        // The server's own normalised selection, never the body's — the same
        // values about to be written to filter_areas and matched by
        // get_filtered_candidates_for_lead.
        p_areas: areas.length > 0 ? areas : null,
        p_min_bedrooms: min,
        p_max_bedrooms: max,
      }
    );
    if (releasableError) {
      // Fail OPEN. The realistic failure is code deployed ahead of 0114, and
      // refusing every filter apply across the platform until somebody noticed
      // would be far worse than applying one without the give-back offer. Same
      // argument autoAssignLead makes for `lead_is_closed`.
      console.error("releasable_filter_assignments failed", releasableError);
    }
    const releasable = (releasableError ? [] : releasableRows ?? []) as Array<{
      assignment_id: string;
      lead_id: string;
      postcode_area: string | null;
      bedrooms: string | null;
      assigned_at: string;
    }>;

    const choice: ReleaseChoice | null =
      body.existing_leads === "keep" || body.existing_leads === "discard"
        ? body.existing_leads
        : null;

    if (
      choice === null &&
      refundable &&
      forecast.offerable &&
      releasable.length > 0
    ) {
      return NextResponse.json(
        {
          error: "Tell us what to do with the leads you already have.",
          code: "existing_leads_decision_required",
          forecast,
          balance,
          releasable: releasable.map((r) => ({
            lead_id: r.lead_id,
            area: r.postcode_area,
            bedrooms: r.bedrooms,
            assigned_at: r.assigned_at,
          })),
          count: releasable.length,
        },
        { status: 409 }
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
      // From `forecast`, never from the body. Cleared when nothing is offerable
      // so a stale figure cannot outlive the filter that produced it.
      [c.expectedLeads]: forecast.offerable ? forecast.expected : null,
      [c.forecastEstimate]: forecast.offerable ? forecast.estimate : null,
      [c.forecastLikelihood]: forecast.offerable ? forecast.likelihoodPct : null,
      [c.forecastCostPence]: forecast.offerable ? forecast.costPerLeadPence : null,
      [c.forecastPricePence]: forecast.offerable ? forecast.planPricePence : null,
      // Re-stamped on every apply, including an EDIT of a live filter: the areas
      // changed, so this is a new forecast about a new selection. That is why it
      // cannot share filter_enabled_at, which is deliberately preserved across
      // edits below.
      [c.forecastAcknowledgedAt]: forecast.offerable
        ? new Date().toISOString()
        : null,
      updated_at: new Date().toISOString(),
    };

    // A fresh enable (off -> active) stamps filter_enabled_at and immediately
    // forfeits any carried-forward credit surplus. Editing an already-active
    // filter keeps the original timestamp and balance.
    //
    // This is the plain clamp it always was. A previous version spared a
    // portion of the balance from it, because part of the balance could be
    // compensation we owed for missing a volume guarantee and confiscating that
    // would have been indefensible. Nothing is owed now — a forecast creates no
    // liability — so there is nothing to spare and the exception has gone with
    // the column that tracked it.
    //
    // ⚠️ THE CLAMP IS NO LONGER WRITTEN HERE. It moved into
    // release_unmatched_assignments (0114), under the customer row lock,
    // because doing it in this update is a blind read-modify-write: `balance`
    // was read at the top of the request, and any credit an ingest spends in
    // between is silently handed back. The RPC is called unconditionally on a
    // fresh enable — even with nothing to release — so the clamp still happens
    // exactly when it always did.
    const freshEnable = currentStatus === "off";
    if (freshEnable) {
      update[c.enabledAt] = new Date().toISOString();
    }

    const { error } = await admin
      .from("customers")
      .update(update)
      .eq("id", customer.id);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // ---------------------------------------------------------------------
    // Put the leads back.
    //
    // AFTER the update above, never before: the RPC evaluates the filter from
    // the STORED columns, so calling it first would measure the filter the
    // customer just replaced.
    //
    // This is not a lead-for-lead swap and makes no attempt to be one. The
    // released leads drop back under their max_assignments cap and are
    // redistributed by the ordinary machinery — the daily Monday sync and
    // /api/admin/leads/assign-pending (CLAUDE.md §4: "Banked leads are
    // inventory, not a backlog"). What the customer gets immediately is a
    // filter that can actually deliver, and credits to spend on it.
    let released = 0;
    const plan = releaseCount({
      choice: choice ?? "keep",
      releasableCount: releasable.length,
      // The clamp is applied inside the RPC; mirror it here so the count is
      // sized against the same number.
      balance: freshEnable ? Math.min(balance, allocation) : balance,
      forecastExpected: forecast.offerable ? forecast.expected : null,
      forecastOfferable: forecast.offerable,
      blocked: !refundable,
    });

    if (plan.count > 0 || freshEnable) {
      const { data: releasedCount, error: releaseError } = await admin.rpc(
        "release_unmatched_assignments",
        {
          p_customer_id: customer.id,
          p_lead_type: product,
          p_max: plan.count,
          p_mode: plan.mode,
          p_clamp_to_allocation: freshEnable,
        }
      );
      if (releaseError) {
        // The filter is applied and live either way. Logged and swallowed so a
        // failure to give leads back never fails the apply itself; the
        // customer can re-apply to retry the give-back.
        console.error("release_unmatched_assignments failed", releaseError);

        // ⚠️ The clamp lives inside that RPC now, so a failure here would
        // silently stop clamping a fresh enable — including for the whole
        // window where this code is deployed ahead of 0114. Fall back to the
        // write this route did before the RPC existed. It is the blind
        // read-modify-write the RPC was meant to replace, but it is exactly
        // what shipped previously, so the failure path is no worse than today.
        if (freshEnable) {
          const { error: clampError } = await admin
            .from("customers")
            .update({ [c.balance]: Math.min(balance, allocation) })
            .eq("id", customer.id);
          if (clampError) {
            console.error("filter balance clamp fallback failed", clampError);
          }
        }
      } else {
        released = Number(releasedCount ?? 0);
      }
    }

    if (released > 0) {
      const { error: notifyError } = await admin.from("notifications").insert({
        customer_id: customer.id,
        notification_type: "filter_leads_released",
        message:
          `${released} lead${released === 1 ? "" : "s"} you hadn't opened ` +
          `${released === 1 ? "has" : "have"} gone back into the pool, and ` +
          `${released === 1 ? "its credit is" : "their credits are"} back on ` +
          `your account. You'll now be matched to leads on your filter as they come in.`,
      });
      if (notifyError) {
        console.error("filter release notification failed", notifyError);
      }
    }

    // History, best-effort. "You told me four a month" is worth being able to
    // answer even though the answer now carries no liability — but a failure to
    // RECORD it must never fail the apply the customer just made, so this is
    // logged and swallowed. Nothing reads this table to decide anything.
    if (forecast.offerable) {
      const { error: auditError } = await admin
        .from("filter_forecast_acknowledgements")
        .insert({
          customer_id: customer.id,
          lead_type: product,
          expected_leads: forecast.expected,
          estimate: forecast.estimate,
          likelihood_pct: forecast.likelihoodPct,
          cost_per_lead_pence: forecast.costPerLeadPence,
          plan_price_pence: forecast.planPricePence,
          monthly_allocation: allocation,
          areas: areas.length > 0 ? areas : null,
          min_bedrooms: min,
          max_bedrooms: max,
          selection_mode: selectionMode,
          acknowledged_by_user_id: user.id,
        });
      if (auditError) {
        console.error("forecast acknowledgement audit insert failed", auditError);
      }
    }

    return NextResponse.json({
      ok: true,
      status: "active",
      forecast,
      released,
      refunded: released,
    });
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
