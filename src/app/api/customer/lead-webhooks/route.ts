/**
 * Managing the caller's own inbound lead webhooks (§48).
 *
 * ⚠️ SESSION-ONLY, AND NO CREDENTIAL MAY EVER REACH THESE ROUTES. They call
 * getCurrentCustomer() directly rather than resolveCaller(), for the reason
 * ../api-keys/route.ts already states: a credential that can mint credentials
 * can grant itself authority it was not given and outlive its own revocation.
 * A webhook token is a WRITE credential, so that argument is stronger here than
 * it is for a read-only API key, not weaker.
 *
 * Like the key routes, these ignore the `api_enabled` kill switch: a customer
 * must be able to revoke a leaked webhook while the API is switched off, which
 * is exactly when they would most want to.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { APP_URL } from "@/lib/env";
import { availableLeadTypes } from "@/lib/products";
import { MAX_LEAD_WEBHOOKS_PER_CUSTOMER } from "@/lib/api/limits";
import { generateLeadWebhookToken, leadWebhookUrl } from "@/lib/api/leadWebhooks";
import type { LeadType } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Never selects token_hash. There is no caller who should ever receive it. */
const LIST_COLUMNS = "id, name, lead_type, created_at, last_used_at, revoked_at";

export async function GET() {
  const { user, customer } = await getCurrentCustomer();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("customer_lead_webhooks")
    .select(LIST_COLUMNS)
    .eq("customer_id", customer.id)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[lead-webhooks] list failed", error);
    return NextResponse.json({ error: "Could not load your webhooks" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, webhooks: data ?? [] });
}

export async function POST(request: NextRequest) {
  const { user, customer } = await getCurrentCustomer();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: { name?: unknown; lead_type?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length < 1 || name.length > 80) {
    return NextResponse.json(
      { error: "Give the webhook a name between 1 and 80 characters." },
      { status: 400 }
    );
  }

  // The product is fixed AT CREATION rather than read from each request. A lead
  // arriving with no product would have to default to something, and a wrong
  // default puts a GR landlord into a management pipeline with management's
  // stages (invariant 6). Two products means two webhooks, which is also how
  // the customer's own automation is usually shaped anyway.
  const leadType: LeadType =
    body.lead_type === "guaranteed_rent" ? "guaranteed_rent" : "management";

  // The same gate the receiver applies, checked here so a customer cannot
  // create a webhook that would refuse every request it ever received.
  // `availableLeadTypes`, not `holdsProduct`: their own leads stay free through
  // a pause and a cancellation (§32.1).
  const available = availableLeadTypes(customer);
  if (!available.includes(leadType)) {
    return NextResponse.json(
      {
        error:
          available.length === 0
            ? "Adding your own leads is available once you hold a lead package."
            : "You do not hold that product.",
      },
      { status: 403 }
    );
  }

  const admin = createAdminClient();

  const { count, error: countError } = await admin
    .from("customer_lead_webhooks")
    .select("id", { count: "exact", head: true })
    .eq("customer_id", customer.id)
    .is("revoked_at", null);

  if (countError) {
    console.error("[lead-webhooks] count failed", countError);
    return NextResponse.json({ error: "Could not create the webhook" }, { status: 500 });
  }
  if ((count ?? 0) >= MAX_LEAD_WEBHOOKS_PER_CUSTOMER) {
    return NextResponse.json(
      {
        error: `You can hold at most ${MAX_LEAD_WEBHOOKS_PER_CUSTOMER} active webhooks. Revoke one you are not using first.`,
      },
      { status: 409 }
    );
  }

  const { raw, hash } = generateLeadWebhookToken();

  const { data, error } = await admin
    .from("customer_lead_webhooks")
    .insert({
      customer_id: customer.id,
      name,
      token_hash: hash,
      lead_type: leadType,
    })
    .select(LIST_COLUMNS)
    .maybeSingle();

  if (error || !data) {
    console.error("[lead-webhooks] insert failed", error);
    return NextResponse.json({ error: "Could not create the webhook" }, { status: 500 });
  }

  // The ONLY response that will ever contain the URL with its token in it.
  return NextResponse.json({
    ok: true,
    webhook: data,
    url: leadWebhookUrl(APP_URL, raw),
  });
}
