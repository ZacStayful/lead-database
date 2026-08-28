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
    return NextResponse.json({ ok: true, due: 0, polled: 0, updated: 0 });
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

  return NextResponse.json({
    ok: true,
    due: ordered.length,
    polled,
    updated,
    deferred,
    abandoned,
    stopped_for: stoppedFor,
    ms: Date.now() - startedAt,
  });
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
