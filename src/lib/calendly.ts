/**
 * "Has this person booked a web meeting?" (§55)
 *
 * The one question the chase turns on. Every send is preceded by this, because
 * the worst outcome available to this feature is messaging somebody who has
 * already booked: it reads as the product being broken, to exactly the person
 * who was about to buy.
 *
 * Verified against the live account: the connected user is zac@stayful.co.uk
 * (user 4524c498-f081-4a94-b99d-e0122bb33215), the event type enquirers are
 * sent to is "Stayful Lead Database", and /scheduled_events accepts an
 * invitee_email filter — which is what makes this one cheap request per
 * prospect rather than a walk of the whole calendar.
 */

const API = "https://api.calendly.com";
/** Matches the 8s used by monday.ts, sms.ts and businessTime.ts. */
const TIMEOUT_MS = 8000;

export type BookingCheck =
  | { ok: true; booked: boolean }
  | { ok: false; error: string };

/**
 * ⚠️ FAILS CLOSED, AND EVERY CALLER MUST TREAT `ok: false` AS "DO NOT SEND".
 *
 * An unreadable Calendly is not evidence that nobody booked. Sending on a
 * guess would message somebody who has a meeting in the diary; deferring costs
 * a few minutes and the next tick retries. A long outage therefore degrades
 * the two-minute step into a later one, which the admin panel surfaces — the
 * same direction §40.9's status poller takes when it refuses to mark anything
 * failed on OUR error.
 *
 * Not configured counts as a failure for the same reason: no token means we
 * cannot check, and cannot check means do not send.
 *
 * @param email the invitee address, i.e. the address they enquired with
 * @param since only count meetings starting after this — normally the enquiry
 *   time, so a meeting they sat months ago on a different enquiry does not
 *   read as "already booked" today
 */
export async function hasBookedWebMeeting(
  email: string,
  since: Date
): Promise<BookingCheck> {
  const token = process.env.CALENDLY_API_TOKEN;
  const user = process.env.CALENDLY_USER_URI;
  if (!token) return { ok: false, error: "not_configured" };
  if (!user) return { ok: false, error: "no_user_uri" };

  const address = email.trim().toLowerCase();
  if (!address) return { ok: false, error: "no_email" };

  const url = new URL(`${API}/scheduled_events`);
  url.searchParams.set("user", user);
  url.searchParams.set("invitee_email", address);
  // A cancelled meeting is not a booking. Somebody who books and then cancels
  // is genuinely back in play, and chasing them again is right.
  url.searchParams.set("status", "active");
  url.searchParams.set("min_start_time", since.toISOString());
  url.searchParams.set("count", "1");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
      // The App Router patches fetch with its own Data Cache, and a cached
      // response here would mean the call never actually happens — §27.4
      // records a rate limiter that silently never reached the database for
      // exactly this reason. A booking check read from cache is a booking
      // check that cannot see today's booking.
      cache: "no-store",
    });
    if (!res.ok) {
      return { ok: false, error: `calendly_http_${res.status}` };
    }
    const body = (await res.json()) as { collection?: unknown[] };
    return { ok: true, booked: (body.collection?.length ?? 0) > 0 };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
