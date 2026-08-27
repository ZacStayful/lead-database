import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminUser } from "@/lib/auth";
import { assessLeadQuality, type LeadQualityCode } from "@/lib/leadQuality";
import type { Lead } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Action = "override" | "clear" | "recheck";

/**
 * Act on a lead's contact-quality verdict (0111). Admin only.
 *
 *   override  sell it anyway — records who decided and, optionally, why
 *   clear     withdraw the override, restoring the block
 *   recheck   re-run the rules against the row as it stands now
 *
 * An override is essential rather than a convenience. The rules are syntactic
 * and will be wrong sometimes; without a way to say "this one is fine" a false
 * positive is a lead nobody can ever sell.
 *
 * `recheck` deliberately does NOT touch the override. An admin who has decided
 * to sell a lead should not have that decision quietly undone by pressing a
 * button labelled "check again" — clearing is its own action, with its own name.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!isAdminUser(user)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { action?: Action; note?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const action = body.action;
  if (action !== "override" && action !== "clear" && action !== "recheck") {
    return NextResponse.json(
      { error: "action must be one of: override, clear, recheck" },
      { status: 400 }
    );
  }

  const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : "";

  const admin = createAdminClient();

  const { data, error } = await admin
    .from("leads")
    .select("id, lead_name, phone, email, owner_customer_id")
    .eq("id", params.id)
    .maybeSingle();

  if (error) {
    console.error("lead quality: lookup failed", params.id, error);
    return NextResponse.json(
      { error: "Could not read this lead. Please try again." },
      { status: 500 }
    );
  }
  if (!data) {
    return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  }

  const lead = data as Pick<
    Lead,
    "id" | "lead_name" | "phone" | "email" | "owner_customer_id"
  >;

  // A customer's own lead is never judged by us and never blocked by us, so
  // there is nothing here to override. Refused rather than silently no-op'd,
  // because a control that reports success while doing nothing is worse than
  // one that is absent.
  if (lead.owner_customer_id) {
    return NextResponse.json(
      {
        error:
          "This lead was added by a customer. The contact-quality gate does not " +
          "apply to it, so there is nothing to override.",
      },
      { status: 400 }
    );
  }

  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {};

  if (action === "override") {
    patch.lead_quality_override_at = now;
    patch.lead_quality_override_by = user?.email ?? "admin";
    patch.lead_quality_override_note = note || null;
  } else if (action === "clear") {
    patch.lead_quality_override_at = null;
    patch.lead_quality_override_by = null;
    patch.lead_quality_override_note = null;
  } else {
    const verdict = assessLeadQuality(lead);
    patch.lead_quality_status = verdict.ok ? "passed" : "failed";
    patch.lead_quality_codes = verdict.codes as LeadQualityCode[];
    patch.lead_quality_checked_at = now;
  }

  const { data: updated, error: writeError } = await admin
    .from("leads")
    .update(patch)
    .eq("id", params.id)
    .select(
      "id, lead_quality_status, lead_quality_codes, lead_quality_checked_at, " +
        "lead_quality_override_at, lead_quality_override_by, lead_quality_override_note"
    )
    .single();

  if (writeError) {
    return NextResponse.json({ error: writeError.message }, { status: 400 });
  }

  return NextResponse.json({ status: "ok", lead: updated });
}
