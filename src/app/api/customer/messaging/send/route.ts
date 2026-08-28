/**
 * Send one message to a landlord (§28).
 *
 * SESSION-ONLY. This acts with the customer's stored credential to message a
 * third party; an API key that could reach it would impersonate them outward.
 *
 * THE ORDER OF THE SEQUENCE IS THE DESIGN:
 *   1. session + ownership
 *   2. kill switch
 *   3. eligibility — ONE guard (assignmentSendable), no route-side duplicate,
 *      the §5E rule that route and function cannot disagree
 *   4. connection ready
 *   5. CLAIM BY INSERT with the client's idempotency key, THEN call the provider
 *   6. record the outcome
 *
 * Step 5 is the important one. Checking whether we already sent, then sending,
 * leaves a window; claiming by write does not. A double-clicked Send collides on
 * (customer_id, idempotency_key) with 23505 and returns the existing row rather
 * than messaging the landlord twice — the discipline credit_invoice() uses
 * against Stripe redelivery (§19.5) and the announcement send uses (§22.2).
 *
 * Unlike recordEvent's fire-and-forget telemetry, this AWAITS and reports
 * failure: a silently failed message to a landlord is the worst outcome here.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  decryptSecret,
  resendKeyAad,
  timelinesTokenAad,
} from "@/lib/crypto/secretBox";
import { assignmentSendable, messagingEnabled } from "@/lib/messaging/service";
import { sendEmail } from "@/lib/messaging/resend";
import { sendMessage as sendWhatsapp } from "@/lib/messaging/timelines";
import { toE164 } from "@/lib/messaging/whatsappIdentity";
import {
  renderOperatorHtml,
  sanitiseHeaderValue,
  sanitiseTagValue,
  buildFromAddress,
} from "@/lib/messaging/outbound";
import { mintThreadToken, threadAddressFor } from "@/lib/messaging/threadAddress";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = 20_000;

export async function POST(request: NextRequest) {
  const { user, customer } = await getCurrentCustomer();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: {
    assignment_id?: unknown;
    channel?: unknown;
    subject?: unknown;
    body?: unknown;
    client_token?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const assignmentId = typeof body.assignment_id === "string" ? body.assignment_id : "";
  const channel = body.channel === "email" || body.channel === "whatsapp" ? body.channel : null;
  const text = typeof body.body === "string" ? body.body.trim() : "";
  const clientToken = typeof body.client_token === "string" ? body.client_token : "";

  if (!assignmentId || !channel) {
    return NextResponse.json({ error: "assignment_id and channel are required." }, { status: 400 });
  }
  if (!text || text.length > MAX_BODY) {
    return NextResponse.json({ error: "Write a message first." }, { status: 400 });
  }
  if (!clientToken) {
    return NextResponse.json({ error: "Missing client_token." }, { status: 400 });
  }

  const admin = createAdminClient();

  if (!(await messagingEnabled(admin))) {
    return NextResponse.json(
      { error: "Messaging is currently switched off.", code: "disabled" },
      { status: 503 }
    );
  }

  // Ownership scoped by customer_id, so a foreign assignment id is
  // indistinguishable from a nonexistent one — the events-route rule, so this
  // cannot be used to probe which assignments exist.
  const { data: assignment } = await admin
    .from("lead_assignments")
    .select("id, status, closed_at, closed_reason, lead_id, leads(id, lead_name, email, phone, lead_type)")
    .eq("id", assignmentId)
    .eq("customer_id", customer.id)
    .maybeSingle();

  if (!assignment) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const a = assignment as unknown as {
    id: string;
    status: string | null;
    closed_at: string | null;
    closed_reason: string | null;
    lead_id: string;
    leads: { id: string; lead_name: string; email: string | null; phone: string | null };
  };

  const eligibility = assignmentSendable(a);
  if (!eligibility.sendable) {
    return NextResponse.json(
      { error: eligibility.reason, code: "not_sendable" },
      { status: 409 }
    );
  }

  const recipient = channel === "email" ? a.leads?.email : a.leads?.phone;
  if (!recipient) {
    return NextResponse.json(
      { error: `This lead has no ${channel === "email" ? "email address" : "phone number"}.` },
      { status: 409 }
    );
  }

  // ---- Connection ---------------------------------------------------------
  const table = channel === "email" ? "customer_email_domains" : "customer_whatsapp_connections";
  const cols =
    channel === "email"
      ? "id, domain, status, api_key_ciphertext, from_local_part, from_display_name, reply_local_prefix"
      : "id, status, token_ciphertext, whatsapp_account_phone, daily_send_cap";
  const { data: conn } = await admin
    .from(table)
    .select(cols)
    .eq("customer_id", customer.id)
    .maybeSingle();

  const connOk =
    channel === "email"
      ? (conn as { status?: string } | null)?.status === "verified"
      : (conn as { status?: string } | null)?.status === "connected";

  if (!conn || !connOk) {
    return NextResponse.json(
      {
        error: `Your ${channel === "email" ? "email" : "WhatsApp"} connection is not ready yet.`,
        code: "not_connected",
      },
      { status: 409 }
    );
  }

  // ---- Thread -------------------------------------------------------------
  const threadMatch =
    channel === "email"
      ? { counterparty_email: recipient.toLowerCase() }
      : { counterparty_phone: recipient };

  let threadId: string | null = null;
  {
    const q = admin
      .from("lead_message_threads")
      .select("id")
      .eq("customer_id", customer.id)
      .eq("channel", channel);
    const { data: found } = await (channel === "email"
      ? q.eq("counterparty_email", recipient.toLowerCase())
      : q.eq("counterparty_phone", recipient)
    ).maybeSingle();
    threadId = (found as { id: string } | null)?.id ?? null;
  }

  if (!threadId) {
    const { data: made, error: threadErr } = await admin
      .from("lead_message_threads")
      .insert({
        customer_id: customer.id,
        assignment_id: a.id,
        lead_id: a.lead_id,
        channel,
        ...threadMatch,
      })
      .select("id")
      .maybeSingle();
    if (threadErr || !made) {
      console.error("[messaging/send] thread create failed", threadErr);
      return NextResponse.json({ error: "Could not start the conversation." }, { status: 500 });
    }
    threadId = (made as { id: string }).id;

    // The reply-address token is minted once per thread and stored, so the
    // address a landlord replies to never changes underneath them.
    const token = mintThreadToken(threadId);
    if (token) {
      await admin.from("lead_message_threads").update({ thread_token: token }).eq("id", threadId);
    }
  }

  // ---- CLAIM BY INSERT, then send ----------------------------------------
  const subject =
    channel === "email"
      ? sanitiseHeaderValue(typeof body.subject === "string" ? body.subject : "", 200)
      : null;
  if (channel === "email" && !subject) {
    return NextResponse.json({ error: "Give the email a subject." }, { status: 400 });
  }

  const { data: claimed, error: claimErr } = await admin
    .from("lead_messages")
    .insert({
      thread_id: threadId,
      customer_id: customer.id,
      assignment_id: a.id,
      lead_id: a.lead_id,
      channel,
      direction: "outbound",
      status: "queued",
      provider: channel === "email" ? "resend" : "timelinesai",
      idempotency_key: clientToken,
      subject,
      to_address: channel === "email" ? recipient : null,
      to_phone: channel === "whatsapp" ? recipient : null,
      body_text: text,
      generated_by: "human",
      sent_by_user_id: user.id,
    })
    .select("id, status")
    .maybeSingle();

  if (claimErr) {
    // 23505: this exact Send was already claimed. Return the existing message
    // rather than sending a second one to the landlord.
    if ((claimErr as { code?: string }).code === "23505") {
      const { data: prior } = await admin
        .from("lead_messages")
        .select("id, status")
        .eq("customer_id", customer.id)
        .eq("idempotency_key", clientToken)
        .maybeSingle();
      return NextResponse.json({ ok: true, deduped: true, message: prior ?? null });
    }
    console.error("[messaging/send] claim failed", claimErr);
    return NextResponse.json({ error: "Could not send the message." }, { status: 500 });
  }

  const messageId = (claimed as { id: string }).id;

  async function fail(code: string, detail: string, httpStatus = 502) {
    await admin
      .from("lead_messages")
      .update({ status: "failed", error_code: code, error_detail: detail.slice(0, 500) })
      .eq("id", messageId);
    return NextResponse.json({ error: detail, code }, { status: httpStatus });
  }

  // ---- Provider -----------------------------------------------------------
  if (channel === "email") {
    const domain = conn as unknown as {
      domain: string;
      api_key_ciphertext: string | null;
      from_local_part: string;
      from_display_name: string | null;
      reply_local_prefix: string;
    };

    let key: string;
    try {
      key = decryptSecret(domain.api_key_ciphertext ?? "", resendKeyAad(customer.id));
    } catch {
      return fail("credential_unreadable", "Your email connection needs reconnecting.", 409);
    }

    const { data: threadRow } = await admin
      .from("lead_message_threads")
      .select("thread_token")
      .eq("id", threadId)
      .maybeSingle();
    const token = (threadRow as { thread_token: string | null } | null)?.thread_token;

    const replyTo = token
      ? threadAddressFor(
          { domain: domain.domain, reply_local_prefix: domain.reply_local_prefix },
          token
        )
      : `${domain.from_local_part}@${domain.domain}`;

    const sent = await sendEmail(key, {
      from: buildFromAddress(domain),
      to: recipient,
      subject: subject!,
      text,
      html: renderOperatorHtml(text),
      replyTo,
      // Idempotency-Key is our own row id, so a retried request after a crash
      // is deduplicated by Resend rather than double-sending.
      idempotencyKey: messageId,
      tags: [
        { name: "stayful_lead", value: sanitiseTagValue(a.lead_id) },
        { name: "stayful_customer", value: sanitiseTagValue(customer.id) },
      ],
    });

    if (!sent.ok) {
      return fail(
        sent.code,
        sent.code === "invalid_api_key"
          ? "Resend rejected your API key. Please reconnect your email."
          : `The email could not be sent (${sent.code}).`
      );
    }

    await admin
      .from("lead_messages")
      .update({
        status: "sent",
        provider_message_id: sent.data.id,
        from_address: buildFromAddress(domain),
        reply_to_address: replyTo,
        sent_at: new Date().toISOString(),
      })
      .eq("id", messageId);
  } else {
    const wa = conn as unknown as {
      token_ciphertext: string | null;
      whatsapp_account_phone: string | null;
    };

    let token: string;
    try {
      token = decryptSecret(wa.token_ciphertext ?? "", timelinesTokenAad(customer.id));
    } catch {
      return fail("credential_unreadable", "Your WhatsApp connection needs reconnecting.", 409);
    }

    const phone = toE164(recipient);
    if (!phone) {
      return fail("bad_phone", "That phone number does not look valid.", 409);
    }

    const sent = await sendWhatsapp(token, {
      phone,
      text,
      whatsappAccountPhone: wa.whatsapp_account_phone ?? undefined,
    });

    if (!sent.ok) {
      return fail(
        sent.code,
        sent.code === "invalid_token"
          ? "TimelinesAI rejected your token. Please reconnect WhatsApp."
          : `The message could not be sent (${sent.code}).`
      );
    }

    await admin
      .from("lead_messages")
      .update({
        status: "sent",
        provider_message_id: sent.data.message_uid,
        sent_at: new Date().toISOString(),
        // TimelinesAI has no delivered/read webhook, so status is polled.
        next_poll_at: new Date(Date.now() + 60_000).toISOString(),
      })
      .eq("id", messageId);
  }

  await admin
    .from("lead_message_threads")
    .update({
      last_outbound_at: new Date().toISOString(),
      last_message_at: new Date().toISOString(),
      assignment_id: a.id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", threadId);

  await admin.from("lead_message_events").insert({
    message_id: messageId,
    event_type: "sent",
    occurred_at: new Date().toISOString(),
  });

  return NextResponse.json({ ok: true, message_id: messageId });
}
