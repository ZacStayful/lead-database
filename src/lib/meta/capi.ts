/**
 * Meta Conversions API transport — the only thing here that touches the network.
 *
 * Server-side conversions exist because the browser pixel is unreliable in
 * exactly the places that matter: roughly a third of visitors block
 * `fbevents.js` outright, and the enquiry form's success path is a hard
 * `window.location.href` off-site to Calendly, which races the beacon.
 *
 * Deliberately inert until configured, the `sms.ts` pattern: with
 * NEXT_PUBLIC_META_PIXEL_ID or META_CAPI_ACCESS_TOKEN unset, nothing is sent
 * and `fetch` is never called — so this code can ship well ahead of the ad
 * account being ready and change nothing in the meantime.
 *
 * ⚠️ THE RETURN TYPE IS A PROMISE THAT NEVER REJECTS, AND BOTH CALL SITES
 * DEPEND ON IT.
 *   - `api/enquiry/route.ts` would otherwise turn a Meta outage into a 500 on
 *     a real lead.
 *   - The Stripe webhook DELETES its `stripe_events` idempotency claim on any
 *     throw, so an escaping exception would make Stripe redeliver an invoice
 *     that has already been credited (CLAUDE.md §23.6).
 * Do not "simplify" the catch-all away.
 */
import type { MetaEvent } from "./events";

const META_API_VERSION = "v21.0";
const META_TIMEOUT_MS = 4000;

export type MetaEventResult = { sent: boolean; skipped?: string; error?: string };

export async function sendMetaConversion(event: MetaEvent): Promise<MetaEventResult> {
  const pixelId = process.env.NEXT_PUBLIC_META_PIXEL_ID;
  const token = process.env.META_CAPI_ACCESS_TOKEN;

  // The expected steady state before the vars are set in Vercel. Returns
  // WITHOUT touching fetch, which `meta.test.ts` asserts directly — that test
  // is what proves merging this branch changes nothing in production.
  if (!pixelId || !token) return { sent: false, skipped: "not_configured" };

  try {
    const body: Record<string, unknown> = {
      data: [event],
      // In the BODY, never the query string, so the token can never end up in
      // a URL that a proxy or an error log echoes back.
      access_token: token,
    };

    // ⚠️ MUST BE UNSET IN PRODUCTION. Events carrying a test code are routed to
    // the Test Events tool and are NOT used for ad delivery, optimisation or
    // attribution — so leaving this set means the campaign optimises on
    // nothing while Events Manager looks perfectly healthy.
    const testCode = process.env.META_TEST_EVENT_CODE;
    if (testCode) body.test_event_code = testCode;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), META_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(
        `https://graph.facebook.com/${META_API_VERSION}/${pixelId}/events`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        }
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      // Meta's error body is the ONLY way to diagnose a bad token or a
      // malformed user_data — the status alone says nothing useful.
      const detail = await res.text().catch(() => "");
      return { sent: false, error: `meta_${res.status}: ${detail.slice(0, 300)}` };
    }

    // A 200 does not mean the event was accepted. A rejected event_time, for
    // instance, comes back 200 with an explanation in `messages`.
    const payload = (await res.json().catch(() => null)) as
      | { events_received?: number; messages?: unknown[] }
      | null;
    if (payload?.messages?.length) {
      return {
        sent: true,
        error: `meta_warning: ${JSON.stringify(payload.messages).slice(0, 300)}`,
      };
    }
    if (payload && payload.events_received !== 1) {
      return { sent: false, error: `meta_events_received: ${payload.events_received}` };
    }

    return { sent: true };
  } catch (e) {
    return { sent: false, error: e instanceof Error ? e.message : "unknown" };
  }
}

/**
 * Log an outcome that deserves attention.
 *
 * Silent on `not_configured` — that is the expected steady state before the
 * env vars land, not a fault. The same discipline `logMondayPush` applies in
 * the Stripe webhook.
 *
 * ⚠️ Never log the access token, and never log `user_data`: it carries hashed
 * PII plus a raw IP address. The event name, the id and the outcome are enough
 * to diagnose anything worth diagnosing.
 */
export function logMetaResult(
  reason: string,
  event: Pick<MetaEvent, "event_name" | "event_id">,
  result: MetaEventResult
): void {
  if (result.error) {
    console.error("[meta-capi]", {
      reason,
      event: event.event_name,
      eventId: event.event_id,
      error: result.error,
    });
  }
}
