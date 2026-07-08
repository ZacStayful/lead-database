import { NextResponse, type NextRequest } from "next/server";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendFilterLiftScheduledEmail } from "@/lib/emails";
import { formatDate } from "@/lib/utils";
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

    const update: Record<string, unknown> = {
      [c.status]: "active",
      [c.areas]: areas.length > 0 ? areas : null,
      [c.min]: min,
      [c.max]: max,
      [c.liftDate]: null, // applying/editing cancels any scheduled lift
      updated_at: new Date().toISOString(),
    };

    // A fresh enable (off -> active) stamps filter_enabled_at and immediately
    // forfeits any carried-forward credit surplus. Editing an already-active
    // filter keeps the original timestamp and balance.
    if (currentStatus === "off") {
      update[c.enabledAt] = new Date().toISOString();
      const balance = Number(customer[c.balance] ?? 0);
      const allocation = Number(customer[c.allocation] ?? 0);
      update[c.balance] = Math.min(balance, allocation);
    }

    const { error } = await admin
      .from("customers")
      .update(update)
      .eq("id", customer.id);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, status: "active" });
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
