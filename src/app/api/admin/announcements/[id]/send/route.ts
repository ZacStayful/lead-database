import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminRequest } from "@/lib/trainingAdmin";
import {
  audienceLabel,
  fetchAnnouncementCandidates,
  paragraphs,
  splitRecipients,
} from "@/lib/announcements";
import { sendAnnouncementEmail } from "@/lib/emails";
import type { Announcement } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 300, matching monthly-insights and admin/assign/bulk.
 *
 * This is the third route that makes a per-customer OUTBOUND vendor call in a
 * loop, and the only one an admin triggers by hand and then watches. At the
 * pacing below (~600ms between sends) the ceiling is roughly 450 recipients
 * before the function is killed part-way through. Today's book is ~22, so there
 * is a wide margin — but if the list ever approaches it, the fix is Resend's
 * batch endpoint (100 messages per call), not a longer timeout.
 *
 * Being killed mid-run is survivable: every recipient already emailed holds a
 * delivery row, so re-running finishes the list rather than starting it again.
 */
export const maxDuration = 300;

/**
 * Resend's default limit is 2 requests a second. The existing crons ignore it
 * because they send to a handful of people on a schedule nobody watches; this
 * one fires the whole book at once on a button press, which is exactly the
 * shape that trips a rate limiter. 600ms keeps it comfortably under.
 */
const SEND_INTERVAL_MS = 600;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Send an announcement to its audience.
 *
 * IDEMPOTENCY IS THE UNIQUE INDEX, NOT THE STATUS COLUMN. Each recipient is
 * claimed by INSERTing an announcement_deliveries row and only then emailed, so
 * a double-clicked button, a browser retry, or a second run after a timeout all
 * collide on unique (announcement_id, customer_id) and skip. This is the same
 * guard credit_invoice() uses against Stripe redelivery (§19.5), and for the
 * same reason: checking whether we have already sent, then sending, leaves a
 * window. Claiming by write does not.
 *
 * That is also why a run left at status 'sending' by a crashed function is
 * re-enterable rather than jammed. The status is presentation; the index is
 * what makes a second attempt safe.
 *
 * FAILURE IS PER RECIPIENT. One bad address must not cost the rest of the book
 * their announcement, so a Resend error is written onto that recipient's
 * delivery row and the loop continues — the same shape as progress-report. The
 * row stays behind deliberately: "we tried and it failed" and "we never tried"
 * are different facts, and only one of them is worth chasing by hand.
 *
 * ?dryRun=true reports exactly who would receive it and sends nothing.
 */
async function handle(req: NextRequest, id: string) {
  if (!(await isAdminRequest(req))) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "true";
  const admin = createAdminClient();

  const { data } = await admin
    .from("announcements")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  const announcement = data as Announcement | null;
  if (!announcement) {
    return NextResponse.json(
      { error: "Announcement not found." },
      { status: 404 }
    );
  }

  if (announcement.status === "sent" && !dryRun) {
    return NextResponse.json(
      {
        error: `This announcement was already sent${
          announcement.sent_at
            ? ` on ${new Date(announcement.sent_at).toLocaleDateString("en-GB")}`
            : ""
        }. It cannot be sent again — check the delivery log for anyone it failed to reach, and contact them directly.`,
      },
      { status: 409 }
    );
  }

  const { rows: candidates, error: candidateError } =
    await fetchAnnouncementCandidates(admin);
  if (candidateError) {
    console.error("[announcement-send] customer read failed", candidateError);
    return NextResponse.json({ error: candidateError }, { status: 500 });
  }

  const { emailable, optedOut } = splitRecipients(
    announcement.audience,
    candidates
  );

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dry_run: true,
      audience: announcement.audience,
      audience_label: audienceLabel(announcement.audience),
      would_send: emailable.length,
      opted_out: optedOut.length,
      recipients: emailable.map((c) => ({
        customer_id: c.id,
        email: c.email,
        business_name: c.business_name,
      })),
      opted_out_customers: optedOut.map((c) => ({
        customer_id: c.id,
        business_name: c.business_name,
      })),
    });
  }

  if (emailable.length === 0) {
    return NextResponse.json(
      {
        error: `Nobody matches this audience (${audienceLabel(
          announcement.audience
        )}), so there is nothing to send.`,
      },
      { status: 400 }
    );
  }

  // Claim the run. Not a lock — the delivery index is what makes concurrency
  // safe — but it puts the list in a state the admin page can render as
  // "sending" rather than looking untouched while a long run is in flight.
  await admin
    .from("announcements")
    .update({ status: "sending", updated_at: new Date().toISOString() })
    .eq("id", id);

  const body = paragraphs(announcement.body_text);
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let first = true;

  for (const customer of emailable) {
    // Claim this recipient. A duplicate key means an earlier run already
    // emailed them; 23505 is the only code that can mean that here.
    const { error: claimError } = await admin
      .from("announcement_deliveries")
      .insert({
        announcement_id: id,
        customer_id: customer.id,
        email: customer.email,
      });

    if (claimError) {
      if (claimError.code === "23505") {
        skipped += 1;
        continue;
      }
      console.error("[announcement-send] could not claim recipient", {
        customer_id: customer.id,
        error: claimError.message,
      });
      failed += 1;
      continue;
    }

    // Paced between sends, not before the first one — an announcement to a
    // single-customer audience should not sit waiting for nothing.
    if (!first) await sleep(SEND_INTERVAL_MS);
    first = false;

    const { id: resendId, error: emailError } = await sendAnnouncementEmail({
      to: customer.email,
      contactName: customer.contact_name,
      subject: announcement.subject,
      title: announcement.title,
      paragraphs: body,
      linkUrl: announcement.link_url,
      linkLabel: announcement.link_label,
    });

    if (emailError) {
      console.error("[announcement-send] email failed", {
        customer_id: customer.id,
      });
      failed += 1;
      await admin
        .from("announcement_deliveries")
        .update({
          error:
            emailError instanceof Error
              ? emailError.message
              : String(emailError),
        })
        .eq("announcement_id", id)
        .eq("customer_id", customer.id);
      continue;
    }

    sent += 1;
    if (resendId) {
      await admin
        .from("announcement_deliveries")
        .update({ resend_id: resendId })
        .eq("announcement_id", id)
        .eq("customer_id", customer.id);
    }
  }

  // recipient_count is what was actually DELIVERED across every run, read back
  // from the log rather than counted in this loop — a resumed run would
  // otherwise record only its own half.
  const { count: deliveredCount } = await admin
    .from("announcement_deliveries")
    .select("id", { count: "exact", head: true })
    .eq("announcement_id", id)
    .is("error", null);

  const { error: stampError } = await admin
    .from("announcements")
    .update({
      status: "sent",
      sent_at: announcement.sent_at ?? new Date().toISOString(),
      recipient_count: deliveredCount ?? sent,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (stampError) {
    // The emails are already gone. Log loudly rather than report a failure the
    // admin might act on by sending again — the delivery rows exist, so a
    // re-run would skip everybody and simply finish the stamp.
    console.error("[announcement-send] stamp failed", stampError);
  }

  return NextResponse.json({
    ok: true,
    audience: announcement.audience,
    audience_label: audienceLabel(announcement.audience),
    sent_count: sent,
    skipped_count: skipped,
    failed_count: failed,
    opted_out_count: optedOut.length,
    recipient_count: deliveredCount ?? sent,
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  return handle(req, params.id);
}

// GET serves the dry run only, so a recipient preview can be fetched without a
// request that could conceivably send. A GET that reaches the send path is
// refused outright rather than trusted to have set the flag.
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  if (req.nextUrl.searchParams.get("dryRun") !== "true") {
    return NextResponse.json(
      { error: "Use POST to send. GET serves ?dryRun=true only." },
      { status: 405 }
    );
  }
  return handle(req, params.id);
}
