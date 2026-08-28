/**
 * Connecting a customer's own Resend account and sending subdomain (§28).
 *
 * SESSION-ONLY, AND AN API KEY MUST NEVER REACH THIS ROUTE. It calls
 * getCurrentCustomer() directly rather than resolveCaller(), for a stronger
 * reason than the one api-keys/route.ts gives about key-minting: this route
 * stores a credential that can send mail from the customer's own domain. A key
 * that could reach it would be a key that impersonates the customer to third
 * parties.
 *
 * ⚠️ The apex defence lives here as well as in domainRules: the POST body takes
 * a WEBSITE domain and a prefix, never a finished subdomain, so the customer
 * cannot supply an apex even deliberately.
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
  resendKeyAad,
  resendWebhookAad,
  secretLast4,
  mintWebhookToken,
} from "@/lib/crypto/secretBox";
import { buildSendingDomain, preflightDns } from "@/lib/messaging/domainRules";
import {
  verifyApiKey,
  createSendingDomain,
  createWebhook,
  deleteSendingDomain,
  deleteWebhook,
  groupRecords,
  WEBHOOK_EVENTS,
} from "@/lib/messaging/resend";
import { EMAIL_DOMAIN_PUBLIC_COLUMNS } from "@/lib/messaging/types";
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
    .from("customer_email_domains")
    .select(EMAIL_DOMAIN_PUBLIC_COLUMNS)
    .eq("customer_id", customer.id)
    .maybeSingle();

  return NextResponse.json({
    ok: true,
    domain: data ?? null,
    configured: Boolean(data && (data as { verified_at?: string }).verified_at),
  });
}

export async function POST(request: NextRequest) {
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
    website_domain?: unknown;
    prefix?: unknown;
    api_key?: unknown;
    from_local_part?: unknown;
    from_display_name?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const apiKey = typeof body.api_key === "string" ? body.api_key.trim() : "";
  if (!apiKey.startsWith("re_") || apiKey.length < 16) {
    return NextResponse.json(
      {
        error:
          "That does not look like a Resend API key. It should begin with \"re_\".",
        code: "bad_key_format",
      },
      { status: 400 }
    );
  }

  // Defence #1: we CONSTRUCT the subdomain. The customer supplies a website
  // domain and a prefix, never a finished name.
  const built = buildSendingDomain(
    typeof body.website_domain === "string" ? body.website_domain : "",
    typeof body.prefix === "string" && body.prefix ? body.prefix : "leads"
  );
  if (!built.ok) {
    return NextResponse.json(
      { error: built.message, code: built.code },
      { status: 400 }
    );
  }

  // Defence #4: the real world. Refuses a target that already receives mail,
  // which is what stops us taking over a live mailbox.
  const preflight = await preflightDns(built.domain);
  if (!preflight.ok) {
    return NextResponse.json(
      { error: preflight.message, code: preflight.code },
      { status: 400 }
    );
  }

  // Verify the key does something BEFORE we store it. A stored dead credential
  // looks connected and fails silently later.
  const keyCheck = await verifyApiKey(apiKey);
  if (!keyCheck.ok) {
    return NextResponse.json(
      {
        error:
          keyCheck.code === "invalid_api_key"
            ? "Resend rejected that API key. Check you copied it in full, and that it has full access."
            : `We could not reach Resend (${keyCheck.code}). Try again in a moment.`,
        code: keyCheck.code,
      },
      { status: 400 }
    );
  }

  const created = await createSendingDomain(apiKey, { domain: built.domain });
  if (!created.ok) {
    return NextResponse.json(
      {
        error:
          created.code === "invalid_api_key"
            ? "That key cannot create domains. It needs FULL ACCESS, not sending access."
            : `Resend could not create the domain (${created.code}). ${created.detail ?? ""}`.trim(),
        code: created.code,
      },
      { status: 400 }
    );
  }

  const admin = createAdminClient();
  const webhookToken = mintWebhookToken();

  // Their webhook, created through their key, pointing at a URL only they use.
  // Resend payloads carry no tenant identifier, so the URL is how we know whose
  // mail an event describes.
  const hook = await createWebhook(apiKey, {
    endpoint: `${APP_URL}/api/webhook/resend/${webhookToken}`,
    events: WEBHOOK_EVENTS,
  });

  const encKey = encryptSecret(apiKey, resendKeyAad(customer.id));
  const encHook =
    hook.ok && hook.data?.signing_secret
      ? encryptSecret(hook.data.signing_secret, resendWebhookAad(customer.id))
      : null;

  const { data, error } = await admin
    .from("customer_email_domains")
    .upsert(
      {
        customer_id: customer.id,
        domain: built.domain,
        parent_domain: built.parent,
        api_key_ciphertext: encKey.ciphertext,
        api_key_version: encKey.version,
        api_key_last4: secretLast4(apiKey),
        resend_domain_id: created.data.id,
        region: created.data.region ?? "eu-west-1",
        webhook_id: hook.ok ? hook.data?.id : null,
        webhook_secret_ciphertext: encHook?.ciphertext ?? null,
        webhook_secret_version: encHook?.version ?? 1,
        webhook_token: webhookToken,
        dns_records: groupRecords(created.data.records ?? []),
        status: "verifying",
        from_local_part:
          typeof body.from_local_part === "string" && body.from_local_part
            ? body.from_local_part.toLowerCase()
            : "hello",
        from_display_name:
          typeof body.from_display_name === "string"
            ? body.from_display_name.slice(0, 80)
            : customer.business_name ?? customer.contact_name ?? null,
        last_error: hook.ok ? null : `webhook_setup_failed: ${hook.code}`,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "customer_id" }
    )
    .select(EMAIL_DOMAIN_PUBLIC_COLUMNS)
    .maybeSingle();

  if (error || !data) {
    // Roll back what we made in THEIR account, so a failed connect does not
    // leave an orphan domain and webhook behind.
    await deleteSendingDomain(apiKey, created.data.id).catch(() => {});
    if (hook.ok && hook.data?.id) await deleteWebhook(apiKey, hook.data.id).catch(() => {});
    console.error("[messaging/email-domain] upsert failed", error);
    return NextResponse.json(
      { error: "Could not save the connection. Please try again." },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    domain: data,
    warning: preflight.ok ? preflight.warning ?? null : null,
  });
}

export async function DELETE() {
  const { user, customer } = await getCurrentCustomer();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const admin = createAdminClient();
  const { data: row } = await admin
    .from("customer_email_domains")
    .select("id, api_key_ciphertext, resend_domain_id, webhook_id")
    .eq("customer_id", customer.id)
    .maybeSingle();

  if (row) {
    const r = row as {
      id: string;
      api_key_ciphertext: string | null;
      resend_domain_id: string | null;
      webhook_id: string | null;
    };
    // Best-effort tidy-up in their account. Their domain, their key — we remove
    // what we created and hold nothing afterwards.
    if (r.api_key_ciphertext) {
      try {
        const key = decryptSecret(r.api_key_ciphertext, resendKeyAad(customer.id));
        if (r.webhook_id) await deleteWebhook(key, r.webhook_id).catch(() => {});
        if (r.resend_domain_id)
          await deleteSendingDomain(key, r.resend_domain_id).catch(() => {});
      } catch {
        /* a credential we can no longer read is one we can no longer use */
      }
    }
    await admin.from("customer_email_domains").delete().eq("id", r.id);
  }

  return NextResponse.json({ ok: true });
}
