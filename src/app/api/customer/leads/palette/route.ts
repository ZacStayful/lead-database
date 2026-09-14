/**
 * The ⌘K lead list (§56.7): the customer's own leads as {id, name, address},
 * fetched by the palette on its FIRST open rather than by the layout on every
 * dashboard request — a 500-row join was riding along with every page load
 * for a control most visits never touch.
 *
 * A fixed-shape named operation: it takes NO query parameter and NO body.
 * Filtering happens in the browser over this list, so §27.1's rule (no
 * free-form search surface anywhere) is untouched. Session-only, scoped by
 * customer_id, and deliberately not on /api/v1.
 */
import { NextResponse } from "next/server";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The newest leads a palette is worth filtering over. */
const PALETTE_LIMIT = 500;

const NO_STORE = { "Cache-Control": "no-store, private" };

export async function GET() {
  const { user, customer } = await getCurrentCustomer();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  if (!customer) return NextResponse.json({ ok: true, leads: [] }, { headers: NO_STORE });

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("lead_assignments")
    .select("lead_id, lead:leads(lead_name, address)")
    .eq("customer_id", customer.id)
    .order("assigned_at", { ascending: false })
    .limit(PALETTE_LIMIT);

  if (error) {
    console.error("[leads/palette] load failed", error);
    return NextResponse.json({ error: "Could not load your leads." }, { status: 500, headers: NO_STORE });
  }

  const leads = ((data ?? []) as unknown as {
    lead_id: string;
    lead: { lead_name: string | null; address: string | null } | null;
  }[]).map((r) => ({
    id: r.lead_id,
    name: r.lead?.lead_name ?? "Lead",
    address: r.lead?.address ?? null,
  }));

  return NextResponse.json({ ok: true, leads }, { headers: NO_STORE });
}
