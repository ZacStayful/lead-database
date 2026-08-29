/**
 * Send one message to a landlord (§40).
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
import { getCurrentCustomer, isAdminUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  decryptSecret,
  resendKeyAad,
  timelinesTokenAad,
} from "@/lib/crypto/secretBox";
import {
  assignmentSendable,
  messagingActiveFor,
  enabledChannels,
} from "@/lib/messaging/service";
import { sendEmail } from "@/lib/messaging/resend";
import { sendMessage as sendWhatsapp } from "@/lib/messaging/timelines";
import { toE164, normalisePhone } from "@/lib/messaging/whatsappIdentity";
import { normaliseUkMobile } from "@/lib/leadQuality";
import { findOrCreateWhatsappThread } from "@/lib/messaging/threads";
import {
  DEFAULT_QUIET_END_HOUR,
  DEFAULT_QUIET_START_HOUR,
  describeNextWindow,
  withinSendingHours,
} from "@/lib/messaging/sendWindow";
import {
  DEFAULT_LEAD_COOLDOWN_HOURS,
  LEAD_COOLDOWN_MESSAGE,
  otherOperatorMessagedRecently,
} from "@/lib/messaging/contactLimits";
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
    draft_id?: unknown;
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
  const draftId = typeof body.draft_id === "string" ? body.draft_id : null;

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

  // messagingActiveFor, not messagingEnabled: an admin rehearsing on production
  // with the switch off must be able to send, or the composer opens correctly
  // and then 503s — which is the same bug one screen later.
  if (!(await messagingActiveFor(admin, isAdminUser(user)))) {
    return NextResponse.json(
      { error: "Messaging is currently switched off.", code: "disabled" },
      { status: 503 }
    );
  }

  // The UI hides email, but hiding is presentation. This is what stops a
  // hand-rolled POST reaching the dormant email path.
  const allowedChannels = await enabledChannels(admin, isAdminUser(user));
  if (!allowedChannels.includes(channel)) {
    return NextResponse.json(
      {
        error: "That channel is not available on your account.",
        code: "channel_disabled",
      },
      { status: 409 }
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
      : "id, status, token_ciphertext, whatsapp_account_phone, daily_send_cap, min_send_interval_secs";
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

  // The landlord's identity key, resolved ONCE. The cross-operator cooldown
  // needs it before the caps block and the thread lookup needs it after, and
  // two calls to normalisePhone on the same number is how the two eventually
  // disagree — §40.8 records that exact bug costing every reply we had.
  const whatsappPhoneKey = channel === "whatsapp" ? normalisePhone(recipient) : null;
  if (channel === "whatsapp" && !whatsappPhoneKey) {
    return NextResponse.json(
      { error: "That lead has no usable phone number." },
      { status: 409 }
    );
  }

  // One clock for the whole request, so the quiet-hours check and the cooldown
  // window cannot straddle a minute boundary and disagree.
  const now = new Date();

  // ---- Send limits, which the setup panel PROMISES --------------------------
  //
  // ⚠️ These columns were stored, shown to the operator as "Sending is limited
  // to N a day to protect your number", and then never read. A stated safety
  // limit that does nothing is worse than no limit, and the risk here lands on
  // the customer's own WhatsApp number, not ours.
  //
  // Counts only messages that actually went out — a failed send consumed no
  // WhatsApp quota and must not consume the operator's allowance either.
  if (channel === "whatsapp") {
    const wa = conn as unknown as {
      daily_send_cap?: number | null;
      min_send_interval_secs?: number | null;
    };
    const cap = wa.daily_send_cap ?? 40;
    const interval = wa.min_send_interval_secs ?? 45;

    // Quiet hours and the cooldown are PLATFORM rules, not per-customer knobs,
    // so they come from system_settings (the messaging_whatsapp_ceiling_per_second
    // precedent) rather than from the connection row.
    //
    // ⚠️ A missing or unreadable row means the DEFAULT WINDOW — not fail-open
    // and not fail-closed. Both precedents in this codebase point opposite ways
    // (messagingEnabled fails closed, fetchUkBankHolidays fails open) and
    // neither fits a restriction: failing closed would refuse every send to
    // avoid sending at the wrong hour, and failing open would lift the rule
    // exactly when we cannot confirm it. The default IS the rule; these rows
    // only move it.
    const { data: limitRows } = await admin
      .from("system_settings")
      .select("key, value")
      .in("key", [
        "messaging_quiet_start_hour",
        "messaging_quiet_end_hour",
        "messaging_lead_cooldown_hours",
      ]);
    const limits = new Map(
      (limitRows ?? []).map((r) => [
        (r as { key: string }).key,
        Number((r as { value: string }).value),
      ])
    );
    const setting = (key: string, fallback: number) => {
      const v = limits.get(key);
      return Number.isFinite(v) ? (v as number) : fallback;
    };
    const quietStart = setting("messaging_quiet_start_hour", DEFAULT_QUIET_START_HOUR);
    const quietEnd = setting("messaging_quiet_end_hour", DEFAULT_QUIET_END_HOUR);
    const cooldownHours = setting(
      "messaging_lead_cooldown_hours",
      DEFAULT_LEAD_COOLDOWN_HOURS
    );

    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const { count: sentToday } = await admin
      .from("lead_messages")
      .select("id", { count: "exact", head: true })
      .eq("customer_id", customer.id)
      .eq("channel", "whatsapp")
      .eq("direction", "outbound")
      .neq("status", "failed")
      .gte("created_at", dayAgo);

    if ((sentToday ?? 0) >= cap) {
      return NextResponse.json(
        {
          error: `You have sent ${sentToday} WhatsApp messages in the last 24 hours, which is the limit on your account. This protects your number from being restricted by WhatsApp.`,
          code: "daily_cap_reached",
        },
        { status: 429 }
      );
    }

    const { data: lastSent } = await admin
      .from("lead_messages")
      .select("sent_at")
      .eq("customer_id", customer.id)
      .eq("channel", "whatsapp")
      .eq("direction", "outbound")
      .not("sent_at", "is", null)
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const lastAt = (lastSent as { sent_at: string | null } | null)?.sent_at;
    if (lastAt) {
      const waitedSecs = (now.getTime() - new Date(lastAt).getTime()) / 1000;
      if (waitedSecs < interval) {
        return NextResponse.json(
          {
            error: `Please wait ${Math.ceil(interval - waitedSecs)} more seconds before sending again. Messaging in quick succession is what gets a number restricted.`,
            code: "too_soon",
            retry_after_seconds: Math.ceil(interval - waitedSecs),
          },
          { status: 429 }
        );
      }
    }

    // ---- Quiet hours (§40.12) ---------------------------------------------
    //
    // The two caps above are about VOLUME. Neither asks what time it is, and 6
    // of the first 17 WhatsApps ever sent went out at 20:xx London.
    //
    // ⚠️ IT REFUSES RATHER THAN DEFERRING, because there is nowhere to defer
    // to: every send is synchronous and operator-initiated, there is no queue,
    // no send_after column and no sending cron. Building one would also collide
    // with 0116's own note that TimelinesAI has no idempotency key, so a stale
    // queued WhatsApp can never be safely auto-retried.
    //
    // No admin bypass. §40.3 establishes that preview means live for THIS
    // viewer — an admin's own row sends real messages to real landlords — so a
    // real WhatsApp at 22:00 is exactly what this prevents, whoever sends it.
    if (!withinSendingHours(now, quietStart, quietEnd)) {
      const opens = describeNextWindow(now, quietStart, quietEnd);
      return NextResponse.json(
        {
          error: `It is outside the hours we message landlords. Your message will send if you come back at ${opens} — nothing has been sent and your text is still here.`,
          code: "quiet_hours",
        },
        { status: 429 }
      );
    }

    // ---- The cross-operator cooldown (§40.12) ------------------------------
    //
    // 136 of 441 leads are held by two or more operators and one by five, none
    // of whom can see each other. Every other limit here is per customer and
    // cannot ask this question.
    //
    // ⚠️ The verdict is a BOOLEAN and the copy names no time. Saying when they
    // could retry would, minus a cooldown anyone can measure by experiment,
    // disclose the other operator's send time — §19.7's rule reached by
    // subtraction. See contactLimits.ts.
    if (whatsappPhoneKey) {
      const cooldown = await otherOperatorMessagedRecently(admin, {
        phoneKey: whatsappPhoneKey,
        customerId: customer.id,
        cooldownHours,
        now,
      });
      if (cooldown.blocked) {
        return NextResponse.json(
          { error: LEAD_COOLDOWN_MESSAGE, code: "lead_cooldown" },
          { status: 429 }
        );
      }
    }
  }

  let newThread = false;

  // ---- Thread -------------------------------------------------------------
  //
  // ⚠️ WHATSAPP MATCHES ON THE NORMALISED KEY, NOT THE RAW STRING. The unique
  // index is (customer_id, counterparty_phone_norm); looking a thread up by the
  // raw phone means the send path and the inbound webhook — which sees the same
  // number in international form — miss each other's threads and then collide
  // on insert. That is what discarded every reply (see threads.ts). This path
  // got away with it only because it always uses the lead's stored phone.
  let threadId: string | null = null;

  if (channel === "email") {
    const { data: found } = await admin
      .from("lead_message_threads")
      .select("id")
      .eq("customer_id", customer.id)
      .eq("channel", "email")
      .eq("counterparty_email", recipient.toLowerCase())
      .maybeSingle();
    threadId = (found as { id: string } | null)?.id ?? null;

    if (!threadId) {
      const { data: made, error: threadErr } = await admin
        .from("lead_message_threads")
        .insert({
          customer_id: customer.id,
          assignment_id: a.id,
          lead_id: a.lead_id,
          channel: "email",
          counterparty_email: recipient.toLowerCase(),
        })
        .select("id")
        .maybeSingle();
      if (threadErr || !made) {
        console.error("[messaging/send] thread create failed", threadErr);
        return NextResponse.json({ error: "Could not start the conversation." }, { status: 500 });
      }
      threadId = (made as { id: string }).id;
      newThread = true;
    }
  } else {
    // phoneKey is resolved once above the caps block, because the cross-operator
    // cooldown needs it too. Non-null there by construction on this branch.
    const phoneKey = whatsappPhoneKey as string;
    const before = await admin
      .from("lead_message_threads")
      .select("id")
      .eq("customer_id", customer.id)
      .eq("channel", "whatsapp")
      .eq("counterparty_phone_norm", phoneKey)
      .maybeSingle();
    const existed = Boolean((before.data as { id: string } | null)?.id);

    threadId = await findOrCreateWhatsappThread(admin, {
      customerId: customer.id,
      assignmentId: a.id,
      leadId: a.lead_id,
      rawPhone: recipient,
      phoneKey,
    });
    if (!threadId) {
      return NextResponse.json({ error: "Could not start the conversation." }, { status: 500 });
    }
    newThread = !existed;
  }

  if (newThread) {
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

  // ---- Provenance -----------------------------------------------------------
  // Read the draft back from OUR ledger and compare here. Never trust a
  // client-supplied "unchanged" flag: the whole point of these columns is to
  // answer "do drafted messages convert better", and a caller that can assert
  // the answer makes the question meaningless.
  //
  // Normalised comparison, so a stray newline or a doubled space is not an
  // "edit" — that would make the edited population meaningless in the other
  // direction.
  let generatedBy: "human" | "llm" = "human";
  let editedAfterGeneration: boolean | null = null;
  let draftModelId: string | null = null;
  let draftPromptVersion: string | null = null;

  if (draftId) {
    const { data: draftRow } = await admin
      .from("message_draft_requests")
      .select("id, draft_text, model_id, prompt_version")
      .eq("id", draftId)
      .eq("customer_id", customer.id)
      .maybeSingle();

    const d = draftRow as {
      draft_text: string | null;
      model_id: string | null;
      prompt_version: string | null;
    } | null;

    if (d?.draft_text) {
      const norm = (v: string) => v.trim().replace(/\s+/g, " ");
      generatedBy = "llm";
      editedAfterGeneration = norm(d.draft_text) !== norm(text);
      draftModelId = d.model_id;
      draftPromptVersion = d.prompt_version;
    }
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
      generated_by: generatedBy,
      edited_after_generation: editedAfterGeneration,
      draft_id: draftId,
      model_id: draftModelId,
      prompt_version: draftPromptVersion,
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

    // ⚠️ VALIDATE WITH THE STRICT RULE, NOT THE MATCHING ONE.
    //
    // toE164 accepts anything normalisePhone accepts, and that is deliberately
    // loose: it is the 0070 IDENTITY rule (seven digits, not all zeros), whose
    // job is deciding whether two records describe the same person. It is not a
    // test of whether a number can receive anything.
    //
    // So a number one digit short — +44778643769, nine digits after the country
    // code where a UK mobile has ten — sailed through to TimelinesAI, which
    // rejected it with a bare `http_400`. The operator was told "the message
    // could not be sent (http_400)", which names neither the problem nor the
    // fix. §36 already owns the strict rule; this is the seam where it was not
    // being used.
    //
    // An explicitly FOREIGN number is a fact, not an error (§36.2) — landlords
    // abroad exist and WhatsApp is how you reach them — so it goes through to
    // the provider as E.164 and the provider decides.
    const uk = normaliseUkMobile(recipient);

    if (!uk.ok && uk.reason !== "foreign") {
      return fail(
        "bad_phone",
        uk.reason === "not_mobile"
          ? "That number is not a UK mobile, so it cannot receive WhatsApp. Check the lead's phone number — a digit is often missing."
          : uk.reason === "placeholder"
            ? "That lead's phone number is a placeholder, not a real number."
            : "That lead has no usable phone number.",
        409
      );
    }

    const phone = uk.ok ? `+44${uk.value.slice(1)}` : toE164(recipient);
    if (!phone) {
      return fail("bad_phone", "That lead has no usable phone number.", 409);
    }

    const sent = await sendWhatsapp(token, {
      phone,
      text,
      whatsappAccountPhone: wa.whatsapp_account_phone ?? undefined,
    });

    if (!sent.ok) {
      // ⚠️ THE VENDOR'S OWN EXPLANATION WAS BEING THROWN AWAY. `sent.detail`
      // carries what TimelinesAI actually said, and a bare `http_400` in front
      // of an operator names neither the problem nor the fix. Always logged; an
      // admin sees it, a customer does not — the messagingConfigError split.
      console.error("[messaging/send] whatsapp send failed", {
        code: sent.code,
        detail: sent.detail,
        messageId,
      });
      return fail(
        sent.code,
        sent.code === "invalid_token"
          ? "TimelinesAI rejected your token. Please reconnect WhatsApp."
          : isAdminUser(user) && sent.detail
            ? `WhatsApp rejected the message (${sent.code}): ${String(sent.detail).slice(0, 200)}`
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

  // The engagement signal. Written on the SERVICE ROLE and only after the
  // provider accepted the message — it is weighted 0.60, above tel_click, and
  // it flips the assignment to contacted via the 0118 trigger.
  //
  // ⚠️ message_sent must never be added to CLIENT_LEAD_EVENT_TYPES. A customer
  // able to POST it could shield every lead they hold from escalation and from
  // the expired pool.
  await admin
    .from("lead_events")
    .insert({ assignment_id: a.id, event_type: "message_sent" })
    .then(
      () => undefined,
      () => undefined
    );

  return NextResponse.json({ ok: true, message_id: messageId });
}
