import { NextResponse, type NextRequest } from "next/server";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { canEditLeadBrief } from "@/lib/leadBrief/gate";
import { parseBriefBody } from "@/lib/leadBrief/briefRequest";
import { briefRowFromPreview } from "@/lib/leadBrief/briefRow";
import { computeBriefForCustomer } from "@/lib/leadBrief/briefServer";
import {
  buildEditedPriorities,
  carryEditToScheduled,
  keptForRecompute,
  parseEditBody,
  planAndTravelOf,
  readStoredPriorities,
  sameAreaAnswers,
} from "@/lib/leadBrief/editBrief";
import { BriefVersionsUnavailableError, loadBriefVersions } from "@/lib/leadBrief/briefVersions";
import { normaliseBriefInput } from "@/lib/leadBrief/input";
import { previewForClient } from "@/lib/leadBrief/preview";
import { BriefSupplyUnavailableError } from "@/lib/leadBrief/supply";
import type { EssentialKey } from "@/lib/leadBrief/types";
import { nextGrantDate } from "@/lib/quality/replacementEntitlement";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The "Your brief" editor (Lead Brief Phase 5). Session only; only a customer
 * who has confirmed a brief and holds Management (`canEditLeadBrief`). An admin
 * viewing as the customer is refused upstream by the read-only middleware (§62).
 *
 * POST takes one of two kinds, both carrying the active version the screen was
 * showing (`expectedActiveId`). 0164 checks it under a per-customer lock, so a
 * second tab, or the renewal cron, cannot be built on: the loser gets 409
 * `conflict` and is asked to reload.
 *
 *   - `priorities`: the ranking and the levels of non-essential priorities.
 *     A new active version NOW, same area; a pending area change gets the same
 *     edit (carryEditToScheduled) so it is not lost at renewal.
 *   - `area`: the Q1–Q3 answers and similar areas. Recomputed against LIVE
 *     supply, never trusted from the browser; 409 `radius_changed` with a fresh
 *     preview if the radius moved since it was shown (A8's rule); 400
 *     `nothing_changed` when it is the current brief. Saved as the ONE
 *     scheduled version, which starts at the next renewal.
 *
 * DELETE cancels the scheduled change. The current brief is untouched.
 *
 * No Monday, Stripe or email side effects. Routing is unchanged until a
 * version is active (0163 reads active rows only).
 */
export async function POST(req: NextRequest) {
  const { user, customer } = await getCurrentCustomer();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  if (!customer || !canEditLeadBrief(customer)) {
    return NextResponse.json({ error: "Not available", code: "not_brief_customer" }, { status: 403 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const body = parseEditBody(raw);
  if (!body) return NextResponse.json({ code: "invalid_body" }, { status: 400 });

  const admin = createAdminClient();

  let versions;
  try {
    versions = await loadBriefVersions(admin, customer.id);
  } catch (err) {
    if (err instanceof BriefVersionsUnavailableError) {
      console.error("[lead-brief/edit] versions unavailable", err.message);
      return NextResponse.json({ code: "supply_unavailable" }, { status: 503 });
    }
    throw err;
  }
  const active = versions.active;
  if (!active || active.id !== body.expectedActiveId) {
    return NextResponse.json({ code: "conflict" }, { status: 409 });
  }
  const stored = readStoredPriorities(active.priorities);

  if (body.kind === "priorities") {
    const { plan, travel } = planAndTravelOf(active);
    const built = buildEditedPriorities({
      stored,
      essentials: (active.essentials ?? []) as EssentialKey[],
      plan,
      travel,
      edit: body.edit,
    });
    if (!built.ok) return NextResponse.json({ code: built.code, key: built.key }, { status: 400 });
    if (!built.changed) return NextResponse.json({ code: "nothing_changed" }, { status: 400 });

    const scheduled = versions.scheduled;
    const scheduledPriorities = scheduled
      ? carryEditToScheduled({
          scheduled: readStoredPriorities(scheduled.priorities),
          scheduledEssentials: (scheduled.essentials ?? []) as EssentialKey[],
          edited: built.priorities,
        })
      : null;

    const { data, error } = await admin.rpc("promote_lead_brief", {
      p_customer_id: customer.id,
      p_expected_active_id: active.id,
      p_source_id: null,
      p_priorities: built.priorities,
      p_scheduled_priorities: scheduledPriorities,
      p_locked_until: null,
    });
    if (error) {
      console.error("[lead-brief/edit] priorities promote failed", error.code, error.message);
      return NextResponse.json({ code: "save_failed" }, { status: 500 });
    }
    const result = (data as { result?: string } | null)?.result;
    if (result === "conflict") return NextResponse.json({ code: "conflict" }, { status: 409 });
    if (result !== "promoted") {
      console.error("[lead-brief/edit] priorities promote returned", result);
      return NextResponse.json({ code: "save_failed" }, { status: 500 });
    }
    return NextResponse.json({ ok: true, appliesNow: true });
  }

  // --- an area change ------------------------------------------------------
  const parsed = parseBriefBody(body.body);
  if (parsed.shownRadiusMiles === null) {
    return NextResponse.json({ code: "radius_missing" }, { status: 400 });
  }
  const kept = keptForRecompute(stored, {
    minBedrooms: parsed.input.minBedrooms ?? null,
    minGross: parsed.input.minGross ?? null,
  });
  const input = { ...parsed.input, ranking: kept.ranking, thresholds: kept.thresholds };

  const normalised = normaliseBriefInput(input);
  if (!normalised.ok) {
    return NextResponse.json({ code: "invalid_input", issues: normalised.issues }, { status: 400 });
  }
  if (sameAreaAnswers(active, normalised.brief)) {
    return NextResponse.json({ code: "nothing_changed" }, { status: 400 });
  }

  let preview;
  try {
    const result = await computeBriefForCustomer(
      admin,
      customer,
      { ...parsed, input },
      { autoTickRecommended: false }
    );
    if (!result.ok) {
      return NextResponse.json({ code: "invalid_input", issues: result.issues }, { status: 400 });
    }
    preview = result.preview;
  } catch (err) {
    if (err instanceof BriefSupplyUnavailableError) {
      console.error("[lead-brief/edit] supply unavailable", err.message);
      return NextResponse.json({ code: "supply_unavailable" }, { status: 503 });
    }
    console.error("[lead-brief/edit] compute failed", err);
    return NextResponse.json({ code: "save_failed" }, { status: 500 });
  }

  if (preview.serviceRadiusMiles !== parsed.shownRadiusMiles) {
    return NextResponse.json(
      {
        code: "radius_changed",
        preview: previewForClient(preview),
        similarAreas: [...preview.brief.similarAreas],
      },
      { status: 409 }
    );
  }

  const row = briefRowFromPreview(preview, {
    customerId: customer.id,
    // 0164 allocates the version, decides the status and sets the lock.
    version: 1,
    lockedUntil: null,
    now: new Date(),
    status: "scheduled",
    chosenKeys: Object.keys(kept.thresholds) as (keyof typeof kept.thresholds)[],
  });
  const { data, error } = await admin.rpc("save_scheduled_lead_brief", {
    p_customer_id: customer.id,
    p_expected_active_id: active.id,
    p_row: row,
  });
  if (error) {
    console.error("[lead-brief/edit] scheduled save failed", error.code, error.message);
    return NextResponse.json({ code: "save_failed" }, { status: 500 });
  }
  const result = (data as { result?: string } | null)?.result;
  if (result === "conflict") return NextResponse.json({ code: "conflict" }, { status: 409 });
  if (result !== "saved") {
    console.error("[lead-brief/edit] scheduled save returned", result);
    return NextResponse.json({ code: "save_failed" }, { status: 500 });
  }
  return NextResponse.json({
    ok: true,
    startsOn: nextGrantDate({
      billing_cycle_anchor: customer.billing_cycle_anchor,
      gr_billing_cycle_anchor: customer.gr_billing_cycle_anchor,
      created_at: customer.created_at,
    }),
  });
}

/** Cancel the scheduled area change. The current brief stays exactly as it is. */
export async function DELETE() {
  const { user, customer } = await getCurrentCustomer();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  if (!customer || !canEditLeadBrief(customer)) {
    return NextResponse.json({ error: "Not available", code: "not_brief_customer" }, { status: 403 });
  }
  const { error } = await createAdminClient()
    .from("customer_lead_briefs")
    .delete()
    .eq("customer_id", customer.id)
    .eq("status", "scheduled");
  if (error) {
    console.error("[lead-brief/edit] cancel failed", error.code, error.message);
    return NextResponse.json({ code: "save_failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
