import { describe, it, expect, afterEach, vi } from "vitest";
import { hasBookedWebMeeting } from "@/lib/calendly";

const SINCE = new Date("2026-09-13T10:00:00.000Z");
const ORIGINAL = globalThis.fetch;

function stub(impl: (url: string, init?: RequestInit) => unknown) {
  globalThis.fetch = vi.fn(async (input: unknown, init?: unknown) =>
    impl(String(input), init as RequestInit)
  ) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = ORIGINAL;
  delete process.env.CALENDLY_API_TOKEN;
  delete process.env.CALENDLY_USER_URI;
  vi.unstubAllEnvs();
});

function configure() {
  process.env.CALENDLY_API_TOKEN = "tok";
  process.env.CALENDLY_USER_URI = "https://api.calendly.com/users/abc";
}

/**
 * ⚠️ THE DIRECTION OF FAILURE IS THE WHOLE POINT OF THIS MODULE.
 *
 * Every one of these asserts `ok: false` — never `booked: false`. The caller
 * treats `ok: false` as "do not send", so an unreadable Calendly defers the
 * step instead of messaging somebody who already has a meeting in the diary.
 * Flip any of these to a cheerful `{ ok: true, booked: false }` and the feature
 * starts chasing the people it most needs to leave alone.
 */
describe("hasBookedWebMeeting fails CLOSED", () => {
  it("when no API token is configured", async () => {
    process.env.CALENDLY_USER_URI = "https://api.calendly.com/users/abc";
    const r = await hasBookedWebMeeting("a@b.com", SINCE);
    expect(r).toEqual({ ok: false, error: "not_configured" });
  });

  it("when the user URI is missing", async () => {
    process.env.CALENDLY_API_TOKEN = "tok";
    const r = await hasBookedWebMeeting("a@b.com", SINCE);
    expect(r).toEqual({ ok: false, error: "no_user_uri" });
  });

  it("when there is no email to look up", async () => {
    configure();
    const r = await hasBookedWebMeeting("   ", SINCE);
    expect(r).toEqual({ ok: false, error: "no_email" });
  });

  it("on a non-200 from Calendly", async () => {
    configure();
    stub(() => ({ ok: false, status: 503, json: async () => ({}) }));
    const r = await hasBookedWebMeeting("a@b.com", SINCE);
    expect(r).toEqual({ ok: false, error: "calendly_http_503" });
  });

  it("on a thrown transport error or timeout", async () => {
    configure();
    stub(() => {
      throw new Error("aborted");
    });
    const r = await hasBookedWebMeeting("a@b.com", SINCE);
    expect(r.ok).toBe(false);
  });
});

describe("hasBookedWebMeeting reads the answer", () => {
  it("reports booked when Calendly returns an event", async () => {
    configure();
    stub(() => ({
      ok: true,
      status: 200,
      json: async () => ({ collection: [{ uri: "x" }] }),
    }));
    expect(await hasBookedWebMeeting("a@b.com", SINCE)).toEqual({
      ok: true,
      booked: true,
    });
  });

  it("reports not booked on an empty collection", async () => {
    configure();
    stub(() => ({ ok: true, status: 200, json: async () => ({ collection: [] }) }));
    expect(await hasBookedWebMeeting("a@b.com", SINCE)).toEqual({
      ok: true,
      booked: false,
    });
  });
});

describe("the request it actually makes", () => {
  it("filters by invitee, by active status and by the enquiry time", async () => {
    configure();
    let seen = "";
    stub((url) => {
      seen = url;
      return { ok: true, status: 200, json: async () => ({ collection: [] }) };
    });
    await hasBookedWebMeeting("Ann@Example.COM ", SINCE);

    const u = new URL(seen);
    // Lower-cased and trimmed: the address came off a public form.
    expect(u.searchParams.get("invitee_email")).toBe("ann@example.com");
    // ⚠️ A CANCELLED MEETING IS NOT A BOOKING. Somebody who books and then
    // cancels is genuinely back in play and should be chased again.
    expect(u.searchParams.get("status")).toBe("active");
    // ⚠️ Bounded by the enquiry, so a meeting they sat months ago on a
    // different enquiry does not read as "already booked" today.
    expect(u.searchParams.get("min_start_time")).toBe(SINCE.toISOString());
  });

  it("is never served from Next's fetch cache", async () => {
    // §27.4: the App Router patches fetch, and a cached booking check is a
    // booking check that cannot see today's booking.
    configure();
    let init: RequestInit | undefined;
    stub((_url, i) => {
      init = i;
      return { ok: true, status: 200, json: async () => ({ collection: [] }) };
    });
    await hasBookedWebMeeting("a@b.com", SINCE);
    expect((init as { cache?: string }).cache).toBe("no-store");
  });
});
