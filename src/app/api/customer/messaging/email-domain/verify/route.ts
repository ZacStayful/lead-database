/**
 * Re-check DNS verification for the customer's sending domain (§28).
 *
 * Session-only, like every route that acts with a stored credential.
 *
 * On the FIRST transition to verified we also enable open and click tracking —
 * which is only possible because the key is full-access, and is the whole reason
 * the wizard asks for one.
 *
 * Throttled per customer: a wizard left open on a browser tab overnight must not
 * sit polling Resend. The UI backs off too, but the server is what enforces it.
 */
import { NextResponse } from "next/server";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptSecret, resendKeyAad } from "@/lib/crypto/secretBox";
import {
  getSendingDomain,
  triggerVerification,
  enableTracking,
  groupRecords,
} from "@/lib/messaging/resend";
import { EMAIL_DOMAIN_PUBLIC_COLUMNS } from "@/lib/messaging/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIN_SECONDS_BETWEEN_CHECKS = 10;

export async function POST() {
  const { user, customer } = await getCurrentCustomer();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const admin = createAdminClient();
  const { data: row } = await admin
    .from("customer_email_domains")
    .select(
      "id, api_key_ciphertext, resend_domain_id, status, last_checked_at, check_attempts, tracking_configured"
    )
    .eq("customer_id", customer.id)
    .maybeSingle();

  if (!row) {
    return NextResponse.json({ error: "No domain connected." }, { status: 404 });
  }

  const r = row as {
    id: string;
    api_key_ciphertext: string | null;
    resend_domain_id: string | null;
    status: string;
    last_checked_at: string | null;
    check_attempts: number;
    tracking_configured: boolean;
  };

  if (r.last_checked_at) {
    const since = (Date.now() - new Date(r.last_checked_at).getTime()) / 1000;
    if (since < MIN_SECONDS_BETWEEN_CHECKS) {
      return NextResponse.json({
        ok: true,
        throttled: true,
        retry_after_seconds: Math.ceil(MIN_SECONDS_BETWEEN_CHECKS - since),
      });
    }
  }

  if (!r.api_key_ciphertext || !r.resend_domain_id) {
    return NextResponse.json({ error: "Connection is incomplete." }, { status: 409 });
  }

  let key: string;
  try {
    key = decryptSecret(r.api_key_ciphertext, resendKeyAad(customer.id));
  } catch {
    await admin
      .from("customer_email_domains")
      .update({ status: "failed", last_error: "credential_unreadable" })
      .eq("id", r.id);
    return NextResponse.json(
      { error: "Stored credential could not be read. Please reconnect." },
      { status: 409 }
    );
  }

  // Ask Resend to re-check, then read the result. Verification is asynchronous,
  // so the read may still say pending — that is normal, not a failure.
  await triggerVerification(key, r.resend_domain_id).catch(() => {});
  const fetched = await getSendingDomain(key, r.resend_domain_id);

  if (!fetched.ok) {
    await admin
      .from("customer_email_domains")
      .update({
        last_checked_at: new Date().toISOString(),
        check_attempts: (r.check_attempts ?? 0) + 1,
        last_error: `${fetched.code}: ${fetched.detail ?? ""}`.slice(0, 300),
      })
      .eq("id", r.id);
    return NextResponse.json(
      { error: `Could not reach Resend (${fetched.code}).`, code: fetched.code },
      { status: 502 }
    );
  }

  const verified = (fetched.data.status ?? "").toLowerCase() === "verified";

  // First time it goes green, turn tracking on. Off by default per domain.
  let trackingConfigured = r.tracking_configured;
  if (verified && !trackingConfigured) {
    const tracked = await enableTracking(key, r.resend_domain_id);
    trackingConfigured = tracked.ok;
  }

  const { data } = await admin
    .from("customer_email_domains")
    .update({
      status: verified ? "verified" : "verifying",
      verified_at: verified ? new Date().toISOString() : null,
      dns_records: groupRecords(fetched.data.records ?? []),
      tracking_configured: trackingConfigured,
      receiving_configured: verified,
      last_checked_at: new Date().toISOString(),
      check_attempts: (r.check_attempts ?? 0) + 1,
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", r.id)
    .select(EMAIL_DOMAIN_PUBLIC_COLUMNS)
    .maybeSingle();

  return NextResponse.json({ ok: true, verified, domain: data ?? null });
}
