/**
 * Delivery status for WhatsApp messages (§40).
 *
 * ⚠️ THIS EXISTS BECAUSE THE VENDOR HAS NO DELIVERED/READ WEBHOOK. TimelinesAI's
 * QR-linked route fires `message:received:new` and `message:sent:new` and
 * nothing else, so `Delivered` and `Read` can only be learned by asking. The
 * send route has written `next_poll_at` on every outbound message since phase 1;
 * until this route existed nothing read it, and every WhatsApp sat at `sent`
 * for ever while the timeline offered two states it could never reach.
 *
 * Bounded three ways, because a poller against a shared rate limit is the shape
 * that quietly takes a provider down for every tenant at once:
 *
 *  1. **Backoff.** 1m → 5m → 15m → 1h → 6h, then abandoned at 48h. A landlord
 *     who has not read a message in two days is not going to be observed doing
 *     so by us; the message keeps whatever state it reached.
 *  2. **Round-robin by customer.** One operator who sent forty messages this
 *     morning must not consume the whole run and starve everybody else's. Due
 *     messages are dealt out one per customer per pass.
 *  3. **A wall clock**, and the shared 30-req/s IP budget through
 *     consume_provider_budget — which fails CLOSED, as every caller of it must.
 *
 * ⚠️ A POLL NEVER MARKS ANYTHING FAILED ON OUR OWN ERROR. A timeout, a 429 or an
 * unreadable token defers the message; only TimelinesAI's own `failed` status
 * writes `failed`. The opposite would turn a bad afternoon on their side into a
 * lead history that says the operator never reached the landlord.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminUser } from "@/lib/auth";
import { decryptSecret, timelinesTokenAad } from "@/lib/crypto/secretBox";
import { getStatusHistory, mapStatus } from "@/lib/messaging/timelines";
import {
  ingestTimelinesEvent,
  uidFromPayload,
  type TimelinesWebhookPayload,
} from "@/lib/messaging/ingestTimelinesEvent";
import { retryDelayMs, retryExhausted } from "@/lib/messaging/webhookRetry";
import {
  sendOneMessage,
  type SendableAssignment,
} from "@/lib/messaging/sendOneMessage";
import {
  advanceRun,
  DUE_DRAFT_COLUMNS,
  sequenceIdempotencyKey,
  sequenceSettings,
  stopRun,
  type StopReason,
} from "@/lib/messaging/sequences";

import {
  landlordReferralEnabled,
  retryOneReferral,
  REFERRAL_RETRY_MAX_PER_RUN,
  REFERRAL_RETRY_PACING_MS,
  type RetryableReferral,
} from "@/lib/landlordReferralSend";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Stop starting new work here, leaving room for the request already in flight. */
const WALL_CLOCK_BUDGET_MS = 45_000;

/** How many due rows to consider in one run. Bounds the query, not the work. */
const SCAN_LIMIT = 400;

/**
 * Requests per second against the shared TimelinesAI bucket.
 *
 * Their documented ceiling is 30 **per IP**, and every tenant shares Vercel's
 * egress addresses — so unlike Resend this is one bucket for the whole platform.
 * 12 leaves the operator-facing send path plenty of room: a cron that makes a
 * customer's own Send button fail is a bad trade whichever way it is measured.
 */
const RATE_CEILING_PER_SEC = 12;

/** Deferred webhook events to consider per run. Bounds the query, not the work. */
const RECOVERY_SCAN_LIMIT = 40;

/**
 * The recovery pass is not racing TimelinesAI's 5-second webhook ceiling, so it
 * can afford to wait properly — which is the entire reason a deferred event has
 * a second chance at all.
 */
const RECOVERY_READBACK_TIMEOUT_MS = 8000;

/** Due sequence drafts to consider per run. Bounds the query, not the work. */
const SEQUENCE_SCAN_LIMIT = 120;

/**
 * The ladder. Index by `poll_attempts` already made.
 *
 * Front-loaded because delivery is normally seconds and reads are minutes; the
 * long tail exists only to catch a phone that was switched off.
 */
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000];

/** Past this, stop asking. The message keeps whatever state it reached. */
const ABANDON_AFTER_MS = 48 * 60 * 60 * 1000;

/** Ordered, so a poll can never move a message backwards. */
const RANK: Record<string, number> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  failed: 4,
};

interface DueMessage {
  id: string;
  customer_id: string;
  provider_message_id: string | null;
  status: string;
  poll_attempts: number;
  created_at: string;
  delivered_at: string | null;
  read_at: string | null;
}

function nextPollAt(attempts: number): string {
  const step = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)];
  return new Date(Date.now() + step).toISOString();
}

/**
 * Deal the due rows out one customer at a time.
 *
 * `next_poll_at asc` alone would hand a whole run to whoever sent a burst, and
 * the operator with one message waiting would be the one who never learns
 * whether it landed.
 */
function roundRobin(rows: DueMessage[]): DueMessage[] {
  const byCustomer = new Map<string, DueMessage[]>();
  for (const r of rows) {
    const list = byCustomer.get(r.customer_id);
    if (list) list.push(r);
    else byCustomer.set(r.customer_id, [r]);
  }
  const queues = Array.from(byCustomer.values());
  const out: DueMessage[] = [];
  let drained = false;
  for (let i = 0; !drained; i++) {
    drained = true;
    for (const q of queues) {
      if (i < q.length) {
        out.push(q[i]);
        drained = false;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Phase 4 — landlord referrals that were claimed and never delivered (§41).
//
// A referral is claimed by write BEFORE it is sent (§19.5), so a Resend failure
// leaves a row that has taken its slot and delivered nothing. Without this
// sweep that landlord is never introduced at all — and the failure it exists
// for is not hypothetical: bulk assign runs completeAssignment at
// NOTIFY_CONCURRENCY = 8, which with a second email per assignment is sixteen
// concurrent requests against Resend's documented 2/second limit (§21.3).
//
// ⚠️ IT RUNS LAST, AND THAT IS DELIBERATE. The three phases above are all
// time-critical — a delivery status, a landlord's reply stopping a ladder, a
// scheduled send. A referral retry is minutes-tolerant by construction, because
// it is already on a backoff ladder. So it takes leftover budget and can never
// starve the others.
//
// ⚠️ IT DOES NOT TOUCH consume_provider_budget. That is TimelinesAI's 30/second
// bucket; this is Resend, a different vendor with a far tighter limit. Pacing
// here is its own — REFERRAL_RETRY_PACING_MS, the 600ms the announcement sender
// uses — because a sweep cleaning up after a rate limit must not reproduce it.
//
// A phase rather than a fifteenth cron, for the reason §40.9 and §40.13 both
// give: this route already runs every five minutes and already holds a wall
// clock.
// ---------------------------------------------------------------------------
async function retryLandlordReferrals(
  admin: ReturnType<typeof createAdminClient>,
  startedAt: number
): Promise<{ due: number; sent: number; deferred: number; failed: number; abandoned: number; skipped: string | null }> {
  const empty = { due: 0, sent: 0, deferred: 0, failed: 0, abandoned: 0, skipped: null as string | null };

  // The kill switch governs the sweep too. Turning the feature off must stop
  // every send, not just the ones on the assignment path.
  if (!(await landlordReferralEnabled(admin))) {
    return { ...empty, skipped: "disabled" };
  }

  const { data, error } = await admin
    .from("lead_assignments")
    .select(
      "id, customer_id, landlord_referral_attempts, landlord_referral_claimed_at, " +
        "lead:leads!inner(id, lead_name, email, address, bedrooms, lead_type, " +
        "owner_customer_id, lead_quality_codes, gross_annual_income, " +
        "landlord_referral_first_sent_at)"
    )
    .not("landlord_referral_claimed_at", "is", null)
    .is("landlord_referral_sent_at", null)
    .not("landlord_referral_next_attempt_at", "is", null)
    .lte("landlord_referral_next_attempt_at", new Date().toISOString())
    .order("landlord_referral_next_attempt_at", { ascending: true })
    .limit(REFERRAL_RETRY_MAX_PER_RUN);

  if (error) return { ...empty, skipped: "query_failed" };

  const rows = (data ?? []) as unknown as {
    id: string;
    customer_id: string;
    landlord_referral_attempts: number;
    landlord_referral_claimed_at: string | null;
    lead: RetryableReferral["lead"];
  }[];
  if (rows.length === 0) return empty;

  // Which of these leads has ANY assignment already delivered? That decides
  // whether the questions have genuinely been asked, and therefore whether a
  // give-up should hand them back for the next operator to ask.
  const leadIds = Array.from(new Set(rows.map((r) => r.lead?.id).filter(Boolean)));
  const { data: sentSiblings } = await admin
    .from("lead_assignments")
    .select("lead_id")
    .in("lead_id", leadIds)
    .not("landlord_referral_sent_at", "is", null);
  const leadsWithASend = new Set(
    ((sentSiblings ?? []) as { lead_id: string }[]).map((r) => r.lead_id)
  );

  const tally = { ...empty, due: rows.length };

  for (const row of rows) {
    if (Date.now() - startedAt > WALL_CLOCK_BUDGET_MS) break;
    if (!row.lead) {
      tally.skipped = "no_lead";
      continue;
    }

    const outcome = await retryOneReferral(admin, {
      id: row.id,
      customer_id: row.customer_id,
      landlord_referral_attempts: row.landlord_referral_attempts ?? 0,
      landlord_referral_claimed_at: row.landlord_referral_claimed_at,
      lead: row.lead,
      noSiblingSent: !leadsWithASend.has(row.lead.id),
    });

    if (outcome === "sent") tally.sent += 1;
    else if (outcome === "deferred") tally.deferred += 1;
    else if (outcome === "failed") tally.failed += 1;
    else if (outcome === "abandoned") tally.abandoned += 1;

    // Pace against Resend, not against TimelinesAI.
    await new Promise((r) => setTimeout(r, REFERRAL_RETRY_PACING_MS));
  }

  return tally;
}

/**
 * The phases that must run on EVERY invocation, whether or not there was a
 * WhatsApp status to poll.
 *
 * ⚠️ EXTRACTED SO A FOURTH PHASE CANNOT BE ADDED TO ONE EXIT AND NOT THE OTHER.
 * This route returns early when the status queue is empty — which its own
 * comment calls the NORMAL case — so a phase wired only into the main path runs
 * on the minority of runs that happened to have a message to poll. That is the
 * trap the recovery phase's comment already warned about, and the landlord
 * referral sweep fell straight into it when it was first added.
 *
 * ⚠️ ORDER IS LOAD-BEARING FOR THE FIRST TWO. Sequences run AFTER recovery so a
 * landlord's reply rescued this run stops the ladder before the next step goes
 * out. Referrals run LAST because they are the only minutes-tolerant phase.
 */
async function runTailPhases(
  admin: ReturnType<typeof createAdminClient>,
  startedAt: number,
  dryRun: boolean
) {
  if (dryRun) return { recovery: null, sequences: null, referrals: null };

  const recovery = await recoverDeferredEvents(admin, startedAt);
  const sequences = await sendDueSequenceDrafts(admin, startedAt);

  let referrals: unknown = { skipped: "not_run" };
  try {
    referrals = await retryLandlordReferrals(admin, startedAt);
  } catch (error) {
    console.error("[poll-whatsapp-status] landlord referral phase failed", error);
  }
  return { recovery, sequences, referrals };
}

async function handle(request: NextRequest) {
  const auth = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  const viaCron = Boolean(cronSecret) && auth === `Bearer ${cronSecret}`;

  if (!viaCron) {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!isAdminUser(user)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const dryRun = request.nextUrl.searchParams.get("dryRun") === "true";
  const admin = createAdminClient();
  const startedAt = Date.now();

  const { data: dueRows, error } = await admin
    .from("lead_messages")
    .select(
      "id, customer_id, provider_message_id, status, poll_attempts, created_at, delivered_at, read_at"
    )
    .eq("channel", "whatsapp")
    .eq("direction", "outbound")
    .in("status", ["queued", "sent", "delivered"])
    .not("next_poll_at", "is", null)
    .lte("next_poll_at", new Date().toISOString())
    .order("next_poll_at", { ascending: true })
    .limit(SCAN_LIMIT);

  if (error) {
    console.error("[poll-whatsapp-status] scan failed", error);
    return NextResponse.json({ ok: false, error: "scan_failed" }, { status: 500 });
  }

  const due = (dueRows ?? []) as DueMessage[];
  if (due.length === 0) {
    // ⚠️ Still run the recovery phase. An idle status queue is the NORMAL case,
    // and returning here would mean deferred webhook events are only ever
    // recovered on the minority of runs that also had a message to poll.
    const tail = await runTailPhases(admin, startedAt, dryRun);
    return NextResponse.json({
      ok: true,
      due: 0,
      polled: 0,
      updated: 0,
      recovery: tail.recovery,
      sequences: tail.sequences,
      referrals: tail.referrals,
    });
  }

  const ordered = roundRobin(due);

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      due: ordered.length,
      customers: new Set(ordered.map((m) => m.customer_id)).size,
      sample: ordered.slice(0, 20).map((m) => ({
        id: m.id,
        status: m.status,
        attempts: m.poll_attempts,
        age_hours: Math.round((Date.now() - new Date(m.created_at).getTime()) / 3_600_000),
      })),
    });
  }

  // One decrypt per customer, not per message. Cached as `null` for a customer
  // whose connection is gone or unreadable, so a broken connection costs one
  // lookup rather than one per message they have in flight.
  const tokens = new Map<string, string | null>();

  async function tokenFor(customerId: string): Promise<string | null> {
    const cached = tokens.get(customerId);
    if (cached !== undefined) return cached;

    const { data } = await admin
      .from("customer_whatsapp_connections")
      .select("token_ciphertext, status")
      .eq("customer_id", customerId)
      .maybeSingle();

    const row = data as { token_ciphertext: string | null; status: string } | null;
    let token: string | null = null;
    if (row?.token_ciphertext && row.status === "connected") {
      try {
        token = decryptSecret(row.token_ciphertext, timelinesTokenAad(customerId));
      } catch {
        token = null;
      }
    }
    tokens.set(customerId, token);
    return token;
  }

  let polled = 0;
  let updated = 0;
  let deferred = 0;
  let abandoned = 0;
  let stoppedFor: string | null = null;

  for (const m of ordered) {
    if (Date.now() - startedAt > WALL_CLOCK_BUDGET_MS) {
      stoppedFor = "wall_clock";
      break;
    }

    const ageMs = Date.now() - new Date(m.created_at).getTime();

    // Abandon rather than poll for ever. next_poll_at is cleared, which is what
    // takes the row out of the partial index this route scans; the message keeps
    // the last status it was actually observed in.
    if (ageMs > ABANDON_AFTER_MS || !m.provider_message_id) {
      await admin.from("lead_messages").update({ next_poll_at: null }).eq("id", m.id);
      abandoned++;
      continue;
    }

    const token = await tokenFor(m.customer_id);
    if (!token) {
      // A disconnected or unreadable connection is not the message's fault.
      // Defer on the ladder and let the abandon window end it if the operator
      // never reconnects.
      await admin
        .from("lead_messages")
        .update({ next_poll_at: nextPollAt(m.poll_attempts) })
        .eq("id", m.id);
      deferred++;
      continue;
    }

    // The shared bucket. Increment-then-compare, and FAIL CLOSED — a limiter we
    // cannot read is not permission to carry on. Stopping the run is safe: every
    // unpolled row keeps its due next_poll_at and is first in line next time.
    const { data: budget, error: budgetErr } = await admin.rpc("consume_provider_budget", {
      p_provider: "timelinesai",
      p_window_seconds: 1,
    });
    const count = (budget as { count?: number } | null)?.count;
    if (budgetErr || typeof count !== "number" || count > RATE_CEILING_PER_SEC) {
      stoppedFor = budgetErr ? "budget_unavailable" : "rate_ceiling";
      break;
    }

    const history = await getStatusHistory(token, m.provider_message_id);
    polled++;

    if (!history.ok) {
      if (history.code === "rate_limited") {
        // Their limiter, not ours. Stop the whole run rather than walking the
        // rest of the queue into the same wall — the run-lead-analysis rule.
        stoppedFor = "provider_rate_limited";
        break;
      }
      // ⚠️ Never `failed`. A timeout or a 5xx says nothing about the message.
      await admin
        .from("lead_messages")
        .update({
          poll_attempts: m.poll_attempts + 1,
          next_poll_at: nextPollAt(m.poll_attempts + 1),
        })
        .eq("id", m.id);
      deferred++;
      continue;
    }

    const entries = (history.data?.status_history ?? [])
      .map((e) => ({ status: mapStatus(e.status), at: e.timestamp }))
      .filter((e): e is { status: NonNullable<ReturnType<typeof mapStatus>>; at: string } =>
        Boolean(e.status)
      );

    // The furthest state the provider has observed. Ranked rather than "last
    // entry wins", because status_history has no documented ordering guarantee
    // and a poll must never walk a message back from Read to Sent.
    let best = m.status;
    for (const e of entries) {
      if ((RANK[e.status] ?? -1) > (RANK[best] ?? -1)) best = e.status;
    }

    const firstAt = (status: string) =>
      entries.filter((e) => e.status === status).map((e) => e.at).sort()[0] ?? null;

    const patch: Record<string, unknown> = {
      poll_attempts: m.poll_attempts + 1,
    };

    if (best !== m.status) {
      patch.status = best;
      updated++;
    }
    // coalesce, first observation wins — the first_contacted_at discipline (§6).
    if (!m.delivered_at && (best === "delivered" || best === "read")) {
      patch.delivered_at = firstAt("delivered") ?? new Date().toISOString();
    }
    if (!m.read_at && best === "read") {
      patch.read_at = firstAt("read") ?? new Date().toISOString();
    }

    // read and failed are terminal: there is nothing further to observe.
    patch.next_poll_at =
      best === "read" || best === "failed" ? null : nextPollAt(m.poll_attempts + 1);

    await admin.from("lead_messages").update(patch).eq("id", m.id);

    // Per-transition evidence. Deduped by the (message_id, event_type,
    // occurred_at) unique index, so re-polling the same history is a no-op
    // rather than a growing pile of duplicate rows.
    for (const e of entries) {
      if (e.status === "queued") continue;
      await admin
        .from("lead_message_events")
        .insert({ message_id: m.id, event_type: e.status, occurred_at: e.at })
        .then(
          () => undefined,
          () => undefined
        );
    }
  }


  const tail = await runTailPhases(admin, startedAt, false);

  return NextResponse.json({
    ok: true,
    due: ordered.length,
    polled,
    updated,
    deferred,
    abandoned,
    stopped_for: stoppedFor,
    recovery: tail.recovery,
    sequences: tail.sequences,
    referrals: tail.referrals,
    ms: Date.now() - startedAt,
  });
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}

/**
 * PHASE TWO — webhook events we could not verify in time (§40.8).
 *
 * ⚠️ THIS EXISTS BECAUSE THE VENDOR'S OWN RETRIES CANNOT HELP US. TimelinesAI
 * retries a failed delivery twice, but the receiver claims the event by INSERT
 * BEFORE it reads back, so every retry short-circuits on 23505 and does nothing.
 * Claiming first is right — it is what stops double-processing — and it makes
 * recovery ours alone. Without this pass, a landlord's reply that arrived during
 * a slow minute at the vendor is lost, and it looks exactly like a landlord who
 * never replied, which is why nobody would ever report it.
 *
 * ⚠️ IT LIVES HERE RATHER THAN IN ITS OWN CRON on purpose. This route already
 * runs every five minutes, already goes through consume_provider_budget — the
 * SHARED 30-req/s TimelinesAI bucket, which a second job would contend with
 * blindly — and already holds a wall clock. A separate cron would duplicate all
 * three and compete with this one for the same ceiling.
 *
 * It runs AFTER the status phase and inside its own try/catch, so neither can
 * cost the other its run.
 */
async function recoverDeferredEvents(
  admin: ReturnType<typeof createAdminClient>,
  startedAt: number
): Promise<{ due: number; stored: number; dropped: number; deferred: number; abandoned: number } | null> {
  const stats = { due: 0, stored: 0, dropped: 0, deferred: 0, abandoned: 0 };
  try {
    const { data, error } = await admin
      .from("message_webhook_events")
      .select("id, customer_id, payload, attempts, received_at")
      .eq("provider", "timelinesai")
      .eq("verified", false)
      .not("customer_id", "is", null)
      .not("next_attempt_at", "is", null)
      .lte("next_attempt_at", new Date().toISOString())
      .order("next_attempt_at", { ascending: true })
      .limit(RECOVERY_SCAN_LIMIT);

    if (error || !data) return stats;

    type PendingEvent = {
      id: string;
      customer_id: string;
      payload: TimelinesWebhookPayload | null;
      attempts: number;
      received_at: string;
    };
    const pending = data as unknown as PendingEvent[];
    stats.due = pending.length;
    if (!pending.length) return stats;

    // One decrypt per customer, as the status phase does.
    const creds = new Map<string, string | null>();
    const credFor = async (customerId: string): Promise<string | null> => {
      const cached = creds.get(customerId);
      if (cached !== undefined) return cached;
      const { data: row } = await admin
        .from("customer_whatsapp_connections")
        .select("token_ciphertext")
        .eq("customer_id", customerId)
        .maybeSingle();
      const cipher = (row as { token_ciphertext: string | null } | null)?.token_ciphertext ?? null;
      creds.set(customerId, cipher);
      return cipher;
    };

    for (const ev of pending) {
      if (Date.now() - startedAt > WALL_CLOCK_BUDGET_MS) break;

      // Past the window, stop asking. The row is KEPT and only its due time
      // nulled — it is the evidence the event arrived, and its payload is the
      // only record of what was sent.
      if (retryExhausted(ev.received_at)) {
        await admin
          .from("message_webhook_events")
          .update({ next_attempt_at: null })
          .eq("id", ev.id);
        stats.abandoned++;
        continue;
      }

      const uid = ev.payload ? uidFromPayload(ev.payload) : undefined;
      if (!ev.payload || !uid) {
        // Nothing to re-run from. Retire it rather than looping for a day.
        await admin
          .from("message_webhook_events")
          .update({ next_attempt_at: null })
          .eq("id", ev.id);
        stats.abandoned++;
        continue;
      }

      // The shared bucket, same ceiling as the status phase. Fails CLOSED.
      const { data: budget, error: budgetErr } = await admin.rpc("consume_provider_budget", {
        p_provider: "timelinesai",
        p_window_seconds: 1,
      });
      const count = (budget as { count?: number } | null)?.count;
      if (budgetErr || typeof count !== "number" || count > RATE_CEILING_PER_SEC) break;

      const result = await ingestTimelinesEvent(admin, {
        customerId: ev.customer_id,
        tokenCiphertext: await credFor(ev.customer_id),
        uid,
        payload: ev.payload,
        claimId: ev.id,
        timeoutMs: RECOVERY_READBACK_TIMEOUT_MS,
      });

      if (result.outcome === "deferred") {
        // ⚠️ Still OUR failure, not a verdict about the event. Back off; never
        // mark it settled because we could not reach the vendor.
        const attempts = (ev.attempts ?? 0) + 1;
        await admin
          .from("message_webhook_events")
          .update({
            attempts,
            next_attempt_at: new Date(Date.now() + retryDelayMs(attempts)).toISOString(),
          })
          .eq("id", ev.id);
        stats.deferred++;
        continue;
      }

      // Read back successfully. `dropped` means it genuinely is not ours to
      // keep, which is settled — retrying would not change the answer.
      await admin
        .from("message_webhook_events")
        .update({ verified: true, next_attempt_at: null, attempts: (ev.attempts ?? 0) + 1 })
        .eq("id", ev.id);

      if (result.outcome === "stored") stats.stored++;
      else stats.dropped++;
    }

    return stats;
  } catch (e) {
    // Its own failure must never cost the status phase its run.
    console.error("[poll-whatsapp-status] recovery failed", e instanceof Error ? e.message : e);
    return stats;
  }
}

/**
 * PHASE THREE — send the follow-up steps that have come due (§40.13).
 *
 * ⚠️ IT LIVES HERE FOR THE REASON PHASE TWO GIVES, verbatim. This route already
 * runs every five minutes, already goes through consume_provider_budget — the
 * SHARED 30-req/s TimelinesAI bucket, which a second job would contend with
 * blindly — and already holds a wall clock. A sending cron of its own would
 * duplicate all three and compete with this one for the same ceiling.
 *
 * ⚠️ THIS IS NOT A RETRY QUEUE, and the difference is the whole reason the
 * feature is defensible against the codebase's own objection (0121's header).
 * What is stored is an INTENT — "this text is due at 09:00" — never an unsent
 * provider payload. The send itself walks `sendOneMessage`, which claims a
 * `lead_messages` row on (customer_id, idempotency_key) and only then calls
 * TimelinesAI. The key is derived from (run_id, step_number), so this route
 * running twice on one step collides on 23505 rather than messaging the landlord
 * twice, and a crash after the provider call leaves a `queued` row the operator
 * can see — exactly what a manual send does today. Nothing is ever re-sent.
 *
 * That is also why the two failure sets below are split where they are: every
 * RESCHEDULE code is refused BEFORE the claim insert, so retrying it is
 * genuinely free. Everything after the claim is terminal for that step.
 */

/**
 * Refusals that happen before any row is claimed, and are therefore safe to try
 * again later. Value is how long to wait; "quiet" means "until the window
 * reopens", which `sendOneMessage` reports as `quietOpensAt`.
 *
 * ⚠️ QUIET HOURS DEFER HERE WHERE THE COMPOSER REFUSES, and that inversion is
 * correct rather than an inconsistency. §40.12 refuses a manual send because
 * there is nowhere to defer to; a scheduled step has a schedule. Same rule, two
 * remedies — no landlord is messaged outside the window either way.
 */
const SEQUENCE_RESCHEDULE_MS: Record<string, number | "quiet" | "retry_after"> = {
  quiet_hours: "quiet",
  too_soon: "retry_after",
  // An hour, not five minutes: a customer at their daily cap will still be at it
  // on the next run, and re-deciding that twelve times an hour is pure noise.
  daily_cap_reached: 60 * 60 * 1000,
  lead_cooldown: 60 * 60 * 1000,
  // Our own failures. Short, because they are usually transient.
  thread_failed: 15 * 60 * 1000,
  claim_failed: 15 * 60 * 1000,
};

/**
 * Refusals that mean every later step would fail the same way. Stopping the run
 * is kinder than sending the operator four identical failures over a fortnight.
 */
const SEQUENCE_STOP_CODES: Record<string, StopReason> = {
  not_sendable: "not_sendable",
  no_recipient: "bad_phone",
  bad_phone: "bad_phone",
  not_connected: "no_connection",
  credential_unreadable: "no_connection",
};

interface DueDraft {
  id: string;
  run_id: string;
  customer_id: string;
  step_number: number;
  body: string;
  draft_id: string | null;
  message_sequence_runs: {
    id: string;
    status: string;
    sequence_id: string;
    assignment_id: string;
    lead_id: string;
  } | null;
}

async function sendDueSequenceDrafts(
  admin: ReturnType<typeof createAdminClient>,
  startedAt: number
): Promise<{
  due: number;
  sent: number;
  rescheduled: number;
  stopped: number;
  skipped: number;
  disabled?: true;
} | null> {
  const stats = { due: 0, sent: 0, rescheduled: 0, stopped: 0, skipped: 0 };
  try {
    // Fails CLOSED. What is gated sends unattended messages from a real
    // person's own number to members of the public.
    const settings = await sequenceSettings(admin);
    if (!settings.enabled) return { ...stats, disabled: true };

    const { data, error } = await admin
      .from("message_sequence_drafts")
      .select(DUE_DRAFT_COLUMNS)
      .eq("state", "pending")
      .eq("message_sequence_runs.status", "active")
      .lte("send_after", new Date().toISOString())
      .order("send_after", { ascending: true })
      .limit(SEQUENCE_SCAN_LIMIT);

    if (error || !data) {
      if (error) console.error("[poll-whatsapp-status] sequence scan failed", error);
      return stats;
    }

    const due = data as unknown as DueDraft[];
    stats.due = due.length;
    if (!due.length) return stats;

    // The same round-robin argument as the status phase: one operator whose
    // whole backlog comes due at 9am must not consume the run and leave
    // everybody else's first message until tomorrow.
    const byCustomer = new Map<string, DueDraft[]>();
    for (const d of due) {
      const list = byCustomer.get(d.customer_id);
      if (list) list.push(d);
      else byCustomer.set(d.customer_id, [d]);
    }
    const queues = Array.from(byCustomer.values());
    const ordered: DueDraft[] = [];
    for (let i = 0, more = true; more; i += 1) {
      more = false;
      for (const q of queues) {
        if (i < q.length) {
          ordered.push(q[i]);
          more = true;
        }
      }
    }

    for (const draft of ordered) {
      if (Date.now() - startedAt > WALL_CLOCK_BUDGET_MS) break;
      const run = draft.message_sequence_runs;
      if (!run) continue;

      // The shared bucket, same ceiling as the other two phases, same FAIL
      // CLOSED. Every unsent draft keeps its due send_after and is first in
      // line next time, so stopping here costs five minutes and nothing else.
      const { data: budget, error: budgetErr } = await admin.rpc("consume_provider_budget", {
        p_provider: "timelinesai",
        p_window_seconds: 1,
      });
      const count = (budget as { count?: number } | null)?.count;
      if (budgetErr || typeof count !== "number" || count > RATE_CEILING_PER_SEC) break;

      const { data: assignmentRow } = await admin
        .from("lead_assignments")
        .select(
          "id, status, closed_at, closed_reason, lead_id, leads(id, lead_name, email, phone, lead_type)"
        )
        .eq("id", run.assignment_id)
        .eq("customer_id", draft.customer_id)
        .maybeSingle();

      if (!assignmentRow) {
        // The 0121 cascade should have taken the run with the assignment, so
        // this is a race rather than a state. Stop it either way.
        await stopRun(admin, run.id, "not_sendable");
        stats.stopped += 1;
        continue;
      }

      const result = await sendOneMessage(admin, {
        customerId: draft.customer_id,
        assignment: assignmentRow as unknown as SendableAssignment,
        channel: "whatsapp",
        text: draft.body,
        idempotencyKey: sequenceIdempotencyKey(run.id, draft.step_number),
        // Nobody was at a keyboard. The column is nullable precisely for this.
        sentByUserId: null,
        draftId: draft.draft_id,
        // Overridden to 'llm' when the ledger has the draft, which it will —
        // this reads 'system' only for a step whose draft row has been pruned.
        defaultGeneratedBy: "system",
        // Free-text provenance, so "which sequence and step converted" is a
        // join rather than a migration (0116 §5).
        templateKey: `sequence:${run.sequence_id}`,
        variantKey: `step:${draft.step_number}`,
      });

      if (result.ok) {
        const sentAt = new Date();
        await admin
          .from("message_sequence_drafts")
          .update({
            state: "sent",
            message_id: result.messageId,
            updated_at: sentAt.toISOString(),
          })
          .eq("id", draft.id);
        await advanceRun(admin, {
          runId: run.id,
          sequenceId: run.sequence_id,
          completedStep: draft.step_number,
          sentAt,
        });
        stats.sent += 1;
        continue;
      }

      const wait = SEQUENCE_RESCHEDULE_MS[result.code];
      if (wait !== undefined) {
        const next =
          wait === "quiet"
            ? (result.quietOpensAt ?? new Date(Date.now() + 60 * 60 * 1000))
            : wait === "retry_after"
              ? new Date(Date.now() + (result.retryAfterSeconds ?? 60) * 1000)
              : new Date(Date.now() + wait);
        await admin
          .from("message_sequence_drafts")
          .update({ send_after: next.toISOString(), updated_at: new Date().toISOString() })
          .eq("id", draft.id);
        stats.rescheduled += 1;
        continue;
      }

      const stopReason = SEQUENCE_STOP_CODES[result.code];
      if (stopReason) {
        // stopRun sweeps this draft to `skipped` itself, along with any other
        // pending step on the run.
        await stopRun(admin, run.id, stopReason);
        stats.stopped += 1;
        continue;
      }

      // ⚠️ EVERYTHING LEFT IS TERMINAL FOR THIS STEP, and that is the vendor's
      // missing idempotency key showing through. A provider failure happens
      // AFTER the claim, so the row already exists carrying this step's key —
      // trying again would collide on 23505 and report a send that failed as a
      // send that happened. The failed message is visible in the operator's own
      // timeline, and the ladder moves on rather than dying on one bad night.
      console.error("[poll-whatsapp-status] sequence step failed", {
        draft: draft.id,
        code: result.code,
      });
      await admin
        .from("message_sequence_drafts")
        .update({
          state: "skipped",
          skip_reason: result.code,
          updated_at: new Date().toISOString(),
        })
        .eq("id", draft.id);
      await advanceRun(admin, {
        runId: run.id,
        sequenceId: run.sequence_id,
        completedStep: draft.step_number,
        sentAt: new Date(),
      });
      stats.skipped += 1;
    }

    return stats;
  } catch (e) {
    console.error(
      "[poll-whatsapp-status] sequence phase failed",
      e instanceof Error ? e.message : e
    );
    return stats;
  }
}
