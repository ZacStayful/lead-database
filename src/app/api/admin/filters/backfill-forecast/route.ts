import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminUser } from "@/lib/auth";
import {
  fetchAreaContention,
  fetchLeadVolumeAggregate,
  type LeadVolumeAggregate,
} from "@/lib/filterPrediction";
import { forecastBackfillFor } from "@/lib/forecastBackfill";
import { activeLeadFilters } from "@/lib/leadFilter";
import type { Customer, LeadType } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Fill in the stored forecast for every active filter that has none (§58).
 *
 * The decision per customer and product is `forecastBackfillFor` — pure, and
 * built on the same `forecastVolume()` the apply route uses, so the figure
 * written here is the figure the panel would have quoted. It only ever ADDS:
 * a filter that already carries a figure is skipped, and the acknowledgement
 * timestamp is never touched, because nobody acknowledged anything.
 *
 * DRY RUN BY DEFAULT (`?apply=1` on a POST to write), the monday-lead-interest
 * route's shape: GET is the dry run and nothing else, so no prefetch can start
 * a write. And it REFUSES when the lead book cannot be read (503): writing a
 * forecast off an empty aggregate is exactly the failure §58 exists to close.
 */

async function isAdminRequest(req: NextRequest): Promise<boolean> {
  const key = req.headers.get("x-admin-key");
  if (key && process.env.ADMIN_SECRET_KEY && key === process.env.ADMIN_SECRET_KEY) {
    return true;
  }
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return isAdminUser(user);
}

async function handle(req: NextRequest) {
  if (!(await isAdminRequest(req))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const apply =
    req.method === "POST" && req.nextUrl.searchParams.get("apply") === "1";

  const admin = createAdminClient();

  let aggregate: LeadVolumeAggregate;
  try {
    aggregate = await fetchLeadVolumeAggregate(admin);
  } catch (err) {
    console.error("[admin/filters/backfill-forecast] volume read failed", err);
    return NextResponse.json(
      { error: "Lead volumes could not be read; nothing was written." },
      { status: 503 }
    );
  }

  const { data, error } = await admin
    .from("customers")
    .select("*")
    .eq("is_active", true)
    .or("filter_status.in.(active,pending_lift),gr_filter_status.in.(active,pending_lift)")
    .order("created_at", { ascending: true });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const rows = (data ?? []) as Customer[];

  const wouldWrite: {
    email: string;
    product: LeadType;
    expected: number;
    likelihood_pct: number | null;
    cost_per_lead_pence: number | null;
  }[] = [];
  const written: { email: string; product: LeadType; expected: number }[] = [];
  const skipped: { email: string; product: LeadType; reason: string }[] = [];
  const failed: { email: string; product: LeadType; reason: string }[] = [];

  for (const row of rows) {
    for (const filter of activeLeadFilters(row)) {
      const product = filter.leadType;
      if (filter.expectedLeads != null) {
        skipped.push({ email: row.email, product, reason: "already_stored" });
        continue;
      }
      // Per product and excluding the customer themselves, exactly as the apply
      // route quotes it (§28.5). Fails open to the unshared figure, as there.
      const contention = await fetchAreaContention(admin, product, row.id);
      const decision = forecastBackfillFor(row, product, aggregate, contention);
      if (decision.outcome === "skip") {
        skipped.push({ email: row.email, product, reason: decision.reason });
        continue;
      }
      if (!apply) {
        wouldWrite.push({
          email: row.email,
          product,
          expected: decision.forecast.expected,
          likelihood_pct: decision.forecast.likelihoodPct,
          cost_per_lead_pence: decision.forecast.costPerLeadPence,
        });
        continue;
      }
      // Guarded on the column still being null, so a concurrent apply by the
      // customer — which stores the figure THEY were shown — always wins.
      const nullColumn = Object.keys(decision.columns)[0];
      const { error: writeError, data: updated } = await admin
        .from("customers")
        .update({ ...decision.columns, updated_at: new Date().toISOString() })
        .eq("id", row.id)
        .is(nullColumn, null)
        .select("id");
      if (writeError) {
        failed.push({ email: row.email, product, reason: writeError.message });
      } else if (!updated || updated.length === 0) {
        skipped.push({ email: row.email, product, reason: "stored_meanwhile" });
      } else {
        written.push({ email: row.email, product, expected: decision.forecast.expected });
      }
    }
  }

  return NextResponse.json({
    mode: apply ? "applied" : "dry-run",
    customers: rows.length,
    would_write: wouldWrite,
    written,
    failed,
    skipped,
  });
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
