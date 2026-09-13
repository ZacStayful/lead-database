/**
 * Chase an enquirer who never booked a web meeting (§55).
 *
 * /enquiry sends every prospect to the Calendly link and nothing followed up
 * the ones who did not book. Measured on production 2026-09-13: 29 waitlisted
 * prospects, 15 of them in the last 30 days, and not one ever chased.
 *
 * Runs every minute, because step 1 is due two minutes after the enquiry —
 * while they are still at the screen they filled the form in on. Steps 2 and 3
 * fall at 24 and 48 hours and ride the same job rather than a second one.
 *
 * THE ORDER OF THE LOOP IS THE DESIGN:
 *   1. stop conditions that cost nothing to check (converted, opted out)
 *   2. ⚠️ CALENDLY, before anything is sent, and it fails CLOSED
 *   3. CLAIM BY INSERT, then call the provider
 *   4. record the outcome
 *   5. Monday — the guarded label, then the update
 *
 * Step 3 is the one that matters. Checking "have we already sent?" and then
 * sending leaves a window a per-minute cron will eventually find; claiming by
 * write does not. The discipline credit_invoice() uses against Stripe
 * redelivery (§19.5) and the announcement send uses against a double click
 * (§21.2).
 */
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { isAdminUser } from "@/lib/auth";
import { resolveSettingsGate } from "@/lib/cron/settingsGate";
import { hasBookedWebMeeting } from "@/lib/calendly";
import {
  ENQUIRY_CHASE_STATUS,
  createEnquiryUpdate,
  mayWriteChaseLabel,
  fetchEnquiryItem,
  setEnquiryStatus,
} from "@/lib/monday";
import { sendProspectBookingNudgeEmail } from "@/lib/emails";
import { APP_URL } from "@/lib/env";
import {
  FINAL_STEP,
  claimKey,
  prospectWork,
  type ProspectChannel,
} from "@/lib/prospect/schedule";
import { emailForStep, whatsappForStep } from "@/lib/prospect/copy";
import { prospectFirstName } from "@/lib/prospect/name";
import { sendProspectWhatsapp } from "@/lib/prospect/sendProspectWhatsapp";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Settings this job reads, BY NAME (see the gate note in run()). */
const SETTING_KEYS = [
  "prospect_nudge_enabled",
  "prospect_nudge_daily_cap",
  "prospect_nudge_sender_customer_id",
] as const;

/**
 * How many ladders one tick will look at. The job runs every minute against a
 * book of ~15 enquiries a MONTH, so this is never reached in normal service —
 * it exists so a backlog after an outage drains over several ticks instead of
 * running one invocation into its 60-second ceiling.
 */
const MAX_LADDERS_PER_TICK = 25;

interface LadderRow {
  id: string;
  customer_id: string;
  enquired_at: string;
  opted_out_at: string | null;
  customers: {
    id: string;
    email: string | null;
    phone: string | null;
    contact_name: string | null;
    business_name: string | null;
    account_status: string | null;
    is_active: boolean | null;
    monday_item_id: string | null;
    monday_board_id: string | null;
  } | null;
}

export async function GET(request: Request) {
  return run(request);
}
export async function POST(request: Request) {
  return run(request);
}

async function run(request: Request) {
  // The §2 cron auth pattern, verbatim. Boolean(cronSecret) fails closed when
  // the var is unset.
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

  const dryRun = new URL(request.url).searchParams.get("dryRun") === "true";
  const admin = createAdminClient();

  // ⚠️ resolveSettingsGate, NEVER `const { data } = await ...`. A discarded
  // error yields an empty map, an empty map reads as every switch being off,
  // and the job then reports a cause that is not the cause — §18.3, which cost
  // two un-backfillable daily series and left a confident wrong explanation
  // sitting over the hole.
  const { data: rows, error } = await admin
    .from("system_settings")
    .select("key, value")
    .in("key", SETTING_KEYS as unknown as string[]);

  const gate = resolveSettingsGate(rows, error);
  if (!gate.ok && gate.reason === "read_failed") {
    console.error("[prospect-nudges] aborted — system_settings unreadable");
    return NextResponse.json(
      { ok: false, error: "settings_read_failed" },
      { status: 500 }
    );
  }
  // ⚠️ `not_configured` is a DIFFERENT answer and is not a failure. These keys
  // are selected BY NAME, so an empty result is the ordinary shape of a
  // database where 0149 has not been applied — and the documented default for
  // the switch is off, which is the safe reading. §18.3 keeps the two reasons
  // apart precisely because its two callers need opposite answers.
  const config = gate.ok ? gate.config : new Map<string, string>();

  if (config.get("prospect_nudge_enabled") !== "true") {
    return NextResponse.json({ ok: true, skipped: "prospect_nudge_disabled" });
  }

  const senderCustomerId = config.get("prospect_nudge_sender_customer_id");
  const dailyCap = Number(config.get("prospect_nudge_daily_cap") ?? "30");

  // The cap counts CLAIMS, not successes: a claim means the provider was
  // called, which is what the cap is protecting the number's reputation from.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count: sentToday, error: countError } = await admin
    .from("prospect_nudge_sends")
    .select("id", { count: "exact", head: true })
    .gte("claimed_at", since);

  if (countError) {
    console.error("[prospect-nudges] cap read failed", countError);
    return NextResponse.json(
      { ok: false, error: "cap_read_failed" },
      { status: 500 }
    );
  }
  let budget = Math.max(0, dailyCap - (sentToday ?? 0));
  if (budget <= 0) {
    return NextResponse.json({ ok: true, skipped: "daily_cap_reached" });
  }

  const { data: ladderRows, error: ladderError } = await admin
    .from("prospect_booking_nudges")
    .select(
      `id, customer_id, enquired_at, opted_out_at,
       customers!inner ( id, email, phone, contact_name, business_name,
                         account_status, is_active, monday_item_id, monday_board_id )`
    )
    .eq("status", "active")
    .order("enquired_at", { ascending: true })
    .limit(MAX_LADDERS_PER_TICK);

  if (ladderError) {
    console.error("[prospect-nudges] ladder read failed", ladderError);
    return NextResponse.json(
      { ok: false, error: "ladder_read_failed" },
      { status: 500 }
    );
  }

  const ladders = (ladderRows ?? []) as unknown as LadderRow[];
  const report: Record<string, unknown>[] = [];

  for (const ladder of ladders) {
    if (budget <= 0) break;
    const customer = ladder.customers;
    if (!customer) continue;

    const enquiredAt = new Date(ladder.enquired_at);

    // --- 1. The free stop conditions -------------------------------------
    //
    // They converted, were archived, or asked us to stop. None of these needs
    // a network call, so they come before the one that does.
    if (customer.account_status !== "waitlisted") {
      await stop(admin, ladder.id, "converted", dryRun);
      report.push({ ladder: ladder.id, action: "stopped", reason: "converted" });
      continue;
    }
    if (customer.is_active === false) {
      await stop(admin, ladder.id, "archived", dryRun);
      report.push({ ladder: ladder.id, action: "stopped", reason: "archived" });
      continue;
    }
    if (ladder.opted_out_at) {
      await stop(admin, ladder.id, "opted_out", dryRun);
      report.push({ ladder: ladder.id, action: "stopped", reason: "opted_out" });
      continue;
    }

    // --- 2. What does this ladder owe? ------------------------------------
    const { data: sendRows } = await admin
      .from("prospect_nudge_sends")
      .select("step, channel")
      .eq("nudge_id", ladder.id);

    const claimed = new Set(
      (sendRows ?? []).map((r: { step: number; channel: string }) =>
        claimKey(r.step, r.channel as ProspectChannel)
      )
    );

    const work = prospectWork(enquiredAt, new Date(), claimed);
    if (work.kind === "waiting") {
      report.push({ ladder: ladder.id, action: "waiting", due: work.nextDueAt });
      continue;
    }
    if (work.kind === "complete") {
      await finish(admin, ladder, dryRun);
      report.push({ ladder: ladder.id, action: "completed" });
      continue;
    }

    // --- 3. ⚠️ Calendly, and it fails CLOSED ------------------------------
    //
    // An unreadable Calendly is NOT evidence that nobody booked. Sending on a
    // guess messages somebody who has a meeting in the diary, which reads as
    // the product being broken to exactly the person about to buy. Deferring
    // costs a minute; the next tick retries.
    const booking = await hasBookedWebMeeting(customer.email ?? "", enquiredAt);
    if (!booking.ok) {
      report.push({
        ladder: ladder.id,
        action: "deferred",
        reason: `calendly_${booking.error}`,
      });
      continue;
    }
    if (booking.booked) {
      await markBooked(admin, ladder, dryRun);
      report.push({ ladder: ladder.id, action: "booked" });
      continue;
    }

    if (dryRun) {
      report.push({
        ladder: ladder.id,
        action: "would_send",
        step: work.step,
        channels: work.channels,
      });
      continue;
    }

    // --- 4. Claim, then send ----------------------------------------------
    const firstName = prospectFirstName(
      customer.contact_name ?? customer.business_name
    );
    const optOutUrl = `${APP_URL}/api/prospect/opt-out?n=${ladder.id}`;
    const outcomes: Record<string, string> = {};

    for (const channel of work.channels) {
      if (budget <= 0) break;

      // ⚠️ THE CLAIM COMES FIRST, ALWAYS. A 23505 here means another tick beat
      // us to it, and the correct response is to send nothing at all.
      const { error: claimError } = await admin
        .from("prospect_nudge_sends")
        .insert({ nudge_id: ladder.id, step: work.step, channel });
      if (claimError) {
        outcomes[channel] = "already_claimed";
        continue;
      }
      budget -= 1;

      let providerId: string | null = null;
      let failure: string | null = null;

      if (channel === "whatsapp") {
        const text = whatsappForStep(work.step, { firstName });
        if (!text) {
          failure = "no_copy";
        } else if (!senderCustomerId) {
          failure = "no_sender_configured";
        } else {
          const sent = await sendProspectWhatsapp(admin, {
            senderCustomerId,
            toPhone: customer.phone,
            text,
          });
          if (sent.ok) providerId = sent.providerMessageId;
          else failure = sent.code;
        }
      } else {
        const mail = emailForStep(work.step, { firstName, optOutUrl });
        if (!mail) {
          failure = "no_copy";
        } else if (!customer.email) {
          failure = "no_email";
        } else {
          const sent = await sendProspectBookingNudgeEmail({
            to: customer.email,
            subject: mail.subject,
            paragraphs: mail.paragraphs,
            cta: mail.cta,
            optOutUrl,
          });
          if (sent.error) failure = "email_failed";
          else providerId = sent.id;
        }
      }

      await admin
        .from("prospect_nudge_sends")
        .update(
          failure
            ? { error: failure }
            : { sent_at: new Date().toISOString(), provider_message_id: providerId }
        )
        .eq("nudge_id", ladder.id)
        .eq("step", work.step)
        .eq("channel", channel);

      outcomes[channel] = failure ?? "sent";
    }

    // --- 5. Monday, AFTER the ledger --------------------------------------
    //
    // Never before: a Monday outage must never cost a send or, worse, cause one
    // to be repeated. Everything below returns a result object and is wrapped,
    // the contract setEnquiryStatus and syncCustomerMondayStatus already hold
    // (§23.6).
    await pushToMonday(admin, ladder, customer, work.step, outcomes);

    report.push({
      ladder: ladder.id,
      action: "sent",
      step: work.step,
      outcomes,
    });
  }

  return NextResponse.json({
    ok: true,
    dryRun,
    considered: ladders.length,
    budgetLeft: budget,
    report,
  });
}

async function stop(
  admin: ReturnType<typeof createAdminClient>,
  ladderId: string,
  reason: string,
  dryRun: boolean
) {
  if (dryRun) return;
  await admin
    .from("prospect_booking_nudges")
    .update({
      status: "stopped",
      stopped_reason: reason,
      updated_at: new Date().toISOString(),
    })
    .eq("id", ladderId)
    .eq("status", "active");
}

/**
 * The ladder ran its course and nobody booked.
 *
 * The label written here is the one that is actually actionable for sales:
 * "the automation is finished with this person, over to you".
 */
async function finish(
  admin: ReturnType<typeof createAdminClient>,
  ladder: LadderRow,
  dryRun: boolean
) {
  if (dryRun) return;
  await admin
    .from("prospect_booking_nudges")
    .update({ status: "completed", updated_at: new Date().toISOString() })
    .eq("id", ladder.id)
    .eq("status", "active");

  await writeChaseLabel(
    ladder.customers?.monday_item_id,
    ladder.customers?.monday_board_id,
    ENQUIRY_CHASE_STATUS.chased_no_booking
  );
  await postUpdate(
    ladder.customers?.monday_item_id,
    `Stayful: booking chase finished after ${FINAL_STEP} messages. No meeting booked.`
  );
}

async function markBooked(
  admin: ReturnType<typeof createAdminClient>,
  ladder: LadderRow,
  dryRun: boolean
) {
  if (dryRun) return;
  await admin
    .from("prospect_booking_nudges")
    .update({
      status: "booked",
      booked_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", ladder.id)
    .eq("status", "active");

  // ⚠️ DELIBERATELY DOES NOT WRITE "Web meeting booked". That is a sales-owned
  // label (§23.1), and setting it from here would fire the board's group-move
  // automation AND trip the stayful-presentation workflow, which is keyed on
  // exactly that transition. The booking is recorded as an update instead;
  // changing that is a decision about the sales process, not a tidy-up.
  await postUpdate(
    ladder.customers?.monday_item_id,
    "Stayful: booked a web meeting. Booking chase stopped."
  );
}

async function pushToMonday(
  admin: ReturnType<typeof createAdminClient>,
  ladder: LadderRow,
  customer: NonNullable<LadderRow["customers"]>,
  step: number,
  outcomes: Record<string, string>
) {
  const lines = Object.entries(outcomes)
    .map(([channel, outcome]) => `${channel}: ${outcome}`)
    .join(" · ");
  await postUpdate(
    customer.monday_item_id,
    `Stayful: booking chase ${step} of ${FINAL_STEP} — ${lines}`
  );

  if (step === 1) {
    const wrote = await writeChaseLabel(
      customer.monday_item_id,
      customer.monday_board_id,
      ENQUIRY_CHASE_STATUS.chasing
    );
    if (wrote === "written") {
      await admin
        .from("customers")
        .update({ monday_status_label: ENQUIRY_CHASE_STATUS.chasing })
        .eq("id", customer.id);
    }
  }
}

/**
 * ⚠️ READ THE CELL, THEN DECIDE — the one Monday write in this codebase that
 * does, and a deliberate departure from §23.4.
 *
 * That section says we never read the board first because it costs round trips
 * and makes our write conditional on somebody else's edit. Here the
 * conditionality is the whole point: this column has two owners already (six
 * labels written by code, seven set by sales by hand, §23.1) and the chase is
 * the third. A human judgement — "In the future", "Web meeting booked",
 * "Abandoned" — outranks an automated chase, every time. At ~15 enquiries a
 * month the extra request costs nothing.
 *
 * A prospect with no board item simply gets no label. 4 of the 29 current rows
 * have none, and §23.7 treats that as a skip rather than an error.
 */
async function writeChaseLabel(
  itemId: string | null | undefined,
  boardId: string | null | undefined,
  label: (typeof ENQUIRY_CHASE_STATUS)[keyof typeof ENQUIRY_CHASE_STATUS]
): Promise<"written" | "skipped" | "failed"> {
  if (!itemId) return "skipped";
  try {
    const current = await fetchEnquiryItem(itemId);
    if (!current.ok || !current.item) return "skipped";
    if (!mayWriteChaseLabel(current.item.statusLabel)) return "skipped";

    const res = await setEnquiryStatus({
      itemId,
      boardId: boardId ?? undefined,
      label,
    });
    return res.written ? "written" : "failed";
  } catch (err) {
    console.error("[prospect-nudges] monday label failed", err);
    return "failed";
  }
}

async function postUpdate(itemId: string | null | undefined, body: string) {
  if (!itemId) return;
  try {
    await createEnquiryUpdate(itemId, body);
  } catch (err) {
    console.error("[prospect-nudges] monday update failed", err);
  }
}
