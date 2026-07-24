import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminUser } from "@/lib/auth";
import { autoAssignLead } from "@/lib/ingest";
import type { Lead, LeadType } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Top up every under-assigned lead (assignment_count < max_assignments) with the
 * next eligible customers. Clears the backlog of leads left stranded at 0/2 or
 * 1/2 — leads only get an assignment attempt at ingest time, so any that missed
 * out (no customer had capacity then, or only some slots filled) sit unassigned
 * until this runs. Credit-gated (uses the same eligibility as fresh ingest), so
 * it never gives paid leads away.
 *
 * Authorised by an admin session OR a CRON_SECRET bearer, so an external
 * scheduler (e.g. n8n) can drive it through the day. Optional JSON body
 * { lead_type } limits the pass to one product.
 */
async function handle(request: NextRequest) {
  const auth = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  const viaCron = Boolean(cronSecret) && auth === `Bearer ${cronSecret}`;

  if (!viaCron) {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!isAdminUser(user)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  let leadType: LeadType | undefined;
  try {
    const body = (await request.json()) as { lead_type?: LeadType };
    if (
      body?.lead_type === "management" ||
      body?.lead_type === "guaranteed_rent"
    ) {
      leadType = body.lead_type;
    }
  } catch {
    // No body / invalid JSON — process all lead types.
  }

  const admin = createAdminClient();

  // Column-vs-column comparisons aren't expressible in PostgREST, so pull the
  // leads and filter the shortfall in JS (open leads are a few hundred at most).
  let query = admin
    .from("leads")
    .select("*")
    .order("created_at", { ascending: true });
  if (leadType) query = query.eq("lead_type", leadType);

  const { data: leadsRaw, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const pending = ((leadsRaw ?? []) as Lead[]).filter(
    (l) => (l.assignment_count ?? 0) < (l.max_assignments ?? 2)
  );

  let assignments = 0;
  let filled = 0;
  for (const lead of pending) {
    const made = await autoAssignLead(admin, lead);
    assignments += made;
    if (made > 0) filled += 1;
  }

  return NextResponse.json({
    status: "ok",
    pending: pending.length,
    leads_topped_up: filled,
    assignments,
  });
}

export async function POST(request: NextRequest) {
  return handle(request);
}

export async function GET(request: NextRequest) {
  return handle(request);
}
