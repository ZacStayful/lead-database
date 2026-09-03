/**
 * Inbound from Resend (§40.8) — delivery events and landlord replies.
 *
 * ⚠️ THIS ROUTE DID NOT EXIST FOR SIX DAYS, AND RESEND DISABLED THE ENDPOINT.
 *
 * `POST /api/customer/messaging/email-domain` has always registered a webhook
 * here — nine event types, pointed at `${APP_URL}/api/webhook/resend/<token>` —
 * and nothing was ever listening. Every delivery got a 404, Resend retried, and
 * on 29 Aug 2026 it disabled the endpoint and emailed us about it.
 *
 * That is the SECOND time in this feature. §40.8 records the same shape on the
 * TimelinesAI side: "this route was registered in phase 1 and did not exist…
 * the live workspace was POSTing to a 404 for a day." That half was fixed in
 * phase 2; this half was not, because §40.4 hides the email channel behind
 * `messaging_email_enabled = false`, so the only account that could reach the
 * connect flow was an admin using the bypass and nothing ever exercised it.
 * The lesson is the one this file keeps relearning: the two pieces were fine
 * and the seam between them was never tested.
 *
 * ⚠️ IT DOES NOT GATE ON `messaging_email_enabled`. That switch governs SENDING.
 * Refusing events while it is off would throw away delivery state for mail that
 * has already gone out, and would put the endpoint straight back into the 4xx
 * loop that got it disabled. A receiver that only works when the feature is
 * turned on is a receiver that gets disabled every time it is turned off.
 *
 * THE LAYERS, and how they differ from the TimelinesAI receiver:
 *
 *   1. An unguessable token in the PATH identifies the customer. An unknown
 *      token returns a 404 byte-identical to every other refusal, so this
 *      cannot enumerate customers or tokens.
 *   2. ⚠️ THE SVIX SIGNATURE, checked against THAT customer's own signing
 *      secret. This is the real authentication boundary, and it is why there is
 *      no read-back here: TimelinesAI cannot sign anything, so that route has
 *      to call the API back before believing a payload. Resend can, so a
 *      verified payload is evidence.
 *   3. Claim by INSERT into message_webhook_events, deduped on the svix id.
 *   4. Match-or-discard, scoped to this customer, in `ingestResendEvent`.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptSecret, resendWebhookAad } from "@/lib/crypto/secretBox";
import { verifySvixSignature } from "@/lib/messaging/svixSignature";
import { ingestResendEvent } from "@/lib/messaging/ingestResendEvent";
import type { ResendWebhookPayload } from "@/lib/messaging/resendEvents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** One refusal for everything we decline, so nothing here is a probe. */
function notFound() {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export async function POST(
  request: NextRequest,
  { params }: { params: { token: string } }
) {
  const admin = createAdminClient();

  // ---- Layer 1: who is this? ----------------------------------------------
  const { data: domainRow } = await admin
    .from("customer_email_domains")
    .select("id, customer_id, domain, reply_local_prefix, webhook_secret_ciphertext")
    .eq("webhook_token", params.token)
    .maybeSingle();

  if (!domainRow) return notFound();

  const domain = domainRow as {
    id: string;
    customer_id: string;
    domain: string;
    reply_local_prefix: string;
    webhook_secret_ciphertext: string | null;
  };

  // ---- Layer 2: the signature ---------------------------------------------
  //
  // ⚠️ READ THE BODY ONCE, AS TEXT, AND PARSE FROM THAT SAME STRING. The
  // signature covers bytes, so `await request.json()` followed by a
  // re-serialisation would verify a different payload from the one that
  // arrived — and would fail in a way indistinguishable from a forgery.
  const raw = await request.text();

  // ⚠️ FAILS CLOSED. No secret means no way to tell a real event from a forged
  // one, and a forged delivery event can mark a message the landlord never got
  // as delivered. A 401 here is loud on purpose: if our stored secret has
  // drifted from the webhook's, we want to be told, not to accept everything.
  if (!domain.webhook_secret_ciphertext) {
    console.error("[webhook/resend] no signing secret stored", {
      customerId: domain.customer_id,
    });
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let secret: string;
  try {
    secret = decryptSecret(domain.webhook_secret_ciphertext, resendWebhookAad(domain.customer_id));
  } catch {
    console.error("[webhook/resend] signing secret unreadable", {
      customerId: domain.customer_id,
    });
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const svixId = request.headers.get("svix-id");
  const verdict = verifySvixSignature({
    id: svixId,
    timestamp: request.headers.get("svix-timestamp"),
    signature: request.headers.get("svix-signature"),
    body: raw,
    secret,
  });

  if (!verdict.ok) {
    console.warn("[webhook/resend] signature rejected", {
      customerId: domain.customer_id,
      reason: verdict.reason,
    });
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let payload: ResendWebhookPayload;
  try {
    payload = JSON.parse(raw) as ResendWebhookPayload;
  } catch {
    // Signed, so it really came from Resend, and still not JSON. Nothing to
    // retry — acknowledge rather than making them redeliver it for two days.
    console.warn("[webhook/resend] signed body was not JSON", {
      customerId: domain.customer_id,
    });
    return NextResponse.json({ received: true, ignored: "bad_json" });
  }

  const eventType = payload.type ?? "";

  // ---- Layer 3: claim by INSERT -------------------------------------------
  //
  // The svix id is stable across the vendor's retries and unique per delivery,
  // so it is the right idempotency key. `verified: true` because the signature
  // is what this column means on a Resend row — and the recovery pass in
  // poll-whatsapp-status filters on provider = 'timelinesai' anyway, so these
  // rows can never be handed to a read-back that would use the wrong credential.
  const claimId = `resend:${svixId}`;
  const { error: claimErr } = await admin.from("message_webhook_events").insert({
    id: claimId,
    provider: "resend",
    event_type: eventType,
    customer_id: domain.customer_id,
    // Stored on EVERY event, not just the ones that go wrong. Twenty
    // TimelinesAI events were once claimed and discarded with nothing kept of
    // what was actually sent, and diagnosing it needed a round trip to the
    // vendor. It costs a jsonb column. It matters more here: `email.received`
    // has no published payload at all, so the first real landlord reply is the
    // only specification of it we will ever get.
    payload: payload as unknown as Record<string, unknown>,
    verified: true,
  });

  if (claimErr) {
    if ((claimErr as { code?: string }).code === "23505") {
      return NextResponse.json({ received: true, deduped: true });
    }
    console.error("[webhook/resend] claim failed", claimErr.message);
    // Could not even record it, so let Resend bring it back.
    return NextResponse.json({ received: false }, { status: 500 });
  }

  try {
    // ---- Layer 4 -----------------------------------------------------------
    const result = await ingestResendEvent(admin, {
      customerId: domain.customer_id,
      domain: { domain: domain.domain, reply_local_prefix: domain.reply_local_prefix },
      payload,
      claimId,
    });

    if (result.outcome === "deferred") {
      // ⚠️ RELEASE THE CLAIM SO THE VENDOR'S OWN RETRY ACTUALLY RUNS.
      //
      // This is where the two receivers diverge again, and it is a difference
      // in the vendors rather than in us. TimelinesAI retries twice inside a
      // few seconds, which is no use for a read-back that just timed out — so
      // that side had to build its own recovery pass (0119). Svix retries out
      // to ten hours, which is ample, and our claim is the only thing standing
      // in the way: leave it and every retry short-circuits on 23505 and does
      // nothing, exactly as §40.8 records.
      //
      // Safe because a deferred outcome means nothing was written that a re-run
      // would duplicate: the lead_message_events insert dedupes on
      // provider_event_id and the inbound insert on (provider, message id).
      await admin.from("message_webhook_events").delete().eq("id", claimId);
      console.warn("[webhook/resend] deferred", { claimId, reason: result.reason });
      return NextResponse.json({ received: false }, { status: 500 });
    }

    if (result.outcome === "dropped") {
      // Genuinely not ours. Settled — a redelivery would reach the same verdict,
      // so it is acknowledged rather than retried. Logged, because a silent 200
      // is what let twenty discarded events look healthy.
      return NextResponse.json({ received: true, ignored: result.reason });
    }

    return NextResponse.json({ received: true, stored: result.kind });
  } catch (e) {
    // The stripe_events discipline: delete the claim on a throw so the sender
    // retries, rather than leaving an event marked seen and never processed.
    await admin.from("message_webhook_events").delete().eq("id", claimId);
    console.error("[webhook/resend] failed", e instanceof Error ? e.message : e);
    return NextResponse.json({ received: false }, { status: 500 });
  }
}
