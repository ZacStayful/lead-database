/**
 * Connecting a customer's own TimelinesAI workspace (§40).
 *
 * SESSION-ONLY. This stores a credential that can send WhatsApp messages from
 * the customer's own number; an API key able to reach it would impersonate them
 * to third parties.
 *
 * THE TOKEN IS VERIFIED BEFORE IT IS STORED. A token that does not authenticate
 * is rejected, never saved — a stored dead credential looks connected and then
 * fails silently at the worst moment.
 *
 * ⚠️ THE BAN-RISK ACKNOWLEDGEMENT IS REQUIRED, NOT COSMETIC. TimelinesAI is a
 * QR-linked device, so automated sending puts the operator's OWN WhatsApp number
 * at risk of being restricted. risk_acknowledged_at records that we said so.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentCustomer, isAdminUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { holdsProduct } from "@/lib/products";
import { APP_URL } from "@/lib/env";
import {
  cryptoConfigured,
  encryptSecret,
  decryptSecret,
  timelinesTokenAad,
  secretFingerprint,
  secretLast4,
  mintWebhookToken,
} from "@/lib/crypto/secretBox";
import {
  listWhatsappAccounts,
  getWorkspaceQuotas,
  listWebhooks,
  createWebhook,
  deleteWebhook,
  WEBHOOK_EVENTS,
} from "@/lib/messaging/timelines";
import { WHATSAPP_PUBLIC_COLUMNS } from "@/lib/messaging/types";
import { messagingConfigError } from "@/lib/messaging/service";
import { threadTokensConfigured } from "@/lib/messaging/threadAddress";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const { user, customer } = await getCurrentCustomer();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const admin = createAdminClient();
  const { data } = await admin
    .from("customer_whatsapp_connections")
    .select(WHATSAPP_PUBLIC_COLUMNS)
    .eq("customer_id", customer.id)
    .maybeSingle();

  return NextResponse.json({ ok: true, connection: data ?? null });
}

export async function PUT(request: NextRequest) {
  const { user, customer } = await getCurrentCustomer();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const holdsAny =
    holdsProduct(customer, "management") || holdsProduct(customer, "guaranteed_rent");
  if (!holdsAny) {
    return NextResponse.json(
      { error: "Messaging is available once you hold a lead package." },
      { status: 403 }
    );
  }

  // Inert until configured (the sms.ts posture) — but legible to whoever can
  // actually fix it. An admin is told which variable is missing; a customer is
  // pointed at support.
  if (!cryptoConfigured() || !threadTokensConfigured()) {
    return NextResponse.json(messagingConfigError(isAdminUser(user)), { status: 503 });
  }

  let body: {
    token?: unknown;
    whatsapp_account_phone?: unknown;
    risk_acknowledged?: unknown;
    daily_send_cap?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (token.length < 10) {
    return NextResponse.json(
      { error: "Paste your TimelinesAI Public API token.", code: "bad_token_format" },
      { status: 400 }
    );
  }

  if (body.risk_acknowledged !== true) {
    return NextResponse.json(
      {
        error:
          "Please confirm you understand WhatsApp may restrict the connected number.",
        code: "risk_not_acknowledged",
      },
      { status: 400 }
    );
  }

  // Verify BEFORE storing.
  const accounts = await listWhatsappAccounts(token);
  if (!accounts.ok) {
    return NextResponse.json(
      {
        error:
          accounts.code === "invalid_token"
            ? "TimelinesAI rejected that token. Check you copied it from Integrations → Public API."
            : `We could not reach TimelinesAI (${accounts.code}). Try again in a moment.`,
        code: accounts.code,
      },
      { status: 400 }
    );
  }

  const found = accounts.data?.whatsapp_accounts ?? [];
  if (found.length === 0) {
    return NextResponse.json(
      {
        error:
          "That workspace has no connected WhatsApp number yet. Scan the QR code in TimelinesAI first, then come back.",
        code: "no_whatsapp_account",
      },
      { status: 400 }
    );
  }

  const wanted =
    typeof body.whatsapp_account_phone === "string" ? body.whatsapp_account_phone : null;
  const account = wanted ? found.find((a) => a.phone === wanted) ?? found[0] : found[0];

  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("customer_whatsapp_connections")
    .select("id, webhook_token, webhook_ids")
    .eq("customer_id", customer.id)
    .maybeSingle();

  const webhookToken =
    (existing as { webhook_token?: string } | null)?.webhook_token ?? mintWebhookToken();

  // Register the four webhooks through their token, so they never touch webhook
  // config. ONE EVENT TYPE PER WEBHOOK; idempotent by listing first, because a
  // re-paste must not stack duplicates against their 10-webhook allowance.
  const url = `${APP_URL}/api/webhook/timelines/${webhookToken}`;
  const existingHooks = await listWebhooks(token);
  const already = new Set(
    (existingHooks.ok ? existingHooks.data?.webhooks ?? [] : [])
      .filter((h) => h.url === url)
      .map((h) => h.event_type)
  );

  const hookIds: { event_type: string; id: string }[] = [];
  for (const eventType of WEBHOOK_EVENTS) {
    if (already.has(eventType)) continue;
    const made = await createWebhook(token, { eventType, url });
    if (made.ok && made.data?.id) hookIds.push({ event_type: eventType, id: made.data.id });
  }

  const quotas = await getWorkspaceQuotas(token);
  const enc = encryptSecret(token, timelinesTokenAad(customer.id));

  const { data, error } = await admin
    .from("customer_whatsapp_connections")
    .upsert(
      {
        customer_id: customer.id,
        token_ciphertext: enc.ciphertext,
        token_version: enc.version,
        token_fingerprint: secretFingerprint(token),
        token_last4: secretLast4(token),
        status: "connected",
        workspace_label: quotas.ok ? quotas.data?.display_name ?? null : null,
        whatsapp_account_id: account?.id ?? null,
        whatsapp_account_phone: account?.phone ?? null,
        webhook_token: webhookToken,
        webhook_ids: hookIds,
        daily_send_cap:
          typeof body.daily_send_cap === "number" &&
          Number.isInteger(body.daily_send_cap) &&
          body.daily_send_cap >= 1 &&
          body.daily_send_cap <= 200
            ? body.daily_send_cap
            : 40,
        risk_acknowledged_at: new Date().toISOString(),
        messaging_quota_total: quotas.ok
          ? quotas.data?.messaging_quota?.total ?? null
          : null,
        messaging_quota_used: quotas.ok
          ? quotas.data?.messaging_quota?.used ?? null
          : null,
        quota_checked_at: quotas.ok ? new Date().toISOString() : null,
        connected_at: new Date().toISOString(),
        last_verified_at: new Date().toISOString(),
        last_error: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "customer_id" }
    )
    .select(WHATSAPP_PUBLIC_COLUMNS)
    .maybeSingle();

  if (error || !data) {
    console.error("[messaging/whatsapp] upsert failed", error);
    return NextResponse.json(
      { error: "Could not save the connection. Please try again." },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    connection: data,
    accounts: found.map((a) => ({ phone: a.phone, name: a.account_name })),
  });
}

export async function DELETE() {
  const { user, customer } = await getCurrentCustomer();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const admin = createAdminClient();
  const { data: row } = await admin
    .from("customer_whatsapp_connections")
    .select("id, token_ciphertext, webhook_ids")
    .eq("customer_id", customer.id)
    .maybeSingle();

  if (row) {
    const r = row as {
      id: string;
      token_ciphertext: string | null;
      webhook_ids: { id: string }[] | null;
    };
    if (r.token_ciphertext) {
      try {
        const token = decryptSecret(r.token_ciphertext, timelinesTokenAad(customer.id));
        for (const h of r.webhook_ids ?? []) {
          await deleteWebhook(token, h.id).catch(() => {});
        }
      } catch {
        /* unreadable credential: nothing to deregister with */
      }
    }
    // The token is DESTROYED, not archived. There is no argument for holding a
    // live credential to somebody's WhatsApp after they disconnect.
    await admin
      .from("customer_whatsapp_connections")
      .update({
        token_ciphertext: null,
        token_fingerprint: null,
        token_last4: null,
        status: "revoked",
        webhook_ids: [],
        updated_at: new Date().toISOString(),
      })
      .eq("id", r.id);
  }

  return NextResponse.json({ ok: true });
}
