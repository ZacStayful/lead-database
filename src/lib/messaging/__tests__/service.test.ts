/**
 * The bug that started phase 2, pinned.
 *
 * `channelAvailability` read `enabled && whatsapp?.status === "connected"`, so a
 * CONNECTED admin previewing the feature was reported as not connected and the
 * modal offered setup for ever. The `&&` was dead logic for a customer — the
 * early return had already caught them — and wrong for the one person able to
 * rehearse the flow.
 *
 * The other half of the file covers what replaced it: email is hidden behind its
 * own switch rather than deleted, and hidden means ABSENT from the channel list,
 * not a disabled button.
 */
import { describe, it, expect } from "vitest";
import { channelAvailability, assignmentSendable } from "../service";

interface FakeState {
  messagingEnabled: boolean;
  emailEnabled: boolean;
  whatsappStatus?: string;
  emailStatus?: string;
}

/**
 * The smallest thing that answers the four queries channelAvailability makes.
 * Every one of them is `.from(t).select(…).eq(…)` and then either
 * `.maybeSingle()` or an await, so one chainable object covers all of them.
 */
function fakeAdmin(state: FakeState) {
  function builder(table: string) {
    const filters: Record<string, unknown> = {};
    const self = {
      select: () => self,
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return self;
      },
      maybeSingle: async () => {
        if (table === "system_settings") {
          const key = filters.key;
          if (key === "messaging_enabled")
            return { data: { value: state.messagingEnabled ? "true" : "false" }, error: null };
          if (key === "messaging_email_enabled")
            return { data: { value: state.emailEnabled ? "true" : "false" }, error: null };
          return { data: null, error: null };
        }
        if (table === "customer_whatsapp_connections")
          return {
            data: state.whatsappStatus ? { status: state.whatsappStatus } : null,
            error: null,
          };
        if (table === "customer_email_domains")
          return {
            data: state.emailStatus ? { status: state.emailStatus } : null,
            error: null,
          };
        return { data: null, error: null };
      },
      // lead_message_threads is awaited directly rather than single-ed.
      then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(resolve),
    };
    return self;
  }
  return { from: (table: string) => builder(table) } as never;
}

const ASSIGNMENT = { id: "a1", status: "new", closed_at: null, closed_reason: null };
const LEAD = { email: "landlord@example.com", phone: "07700900123" };

async function availability(state: FakeState, preview: boolean) {
  return channelAvailability(fakeAdmin(state), {
    customerId: "c1",
    assignment: ASSIGNMENT,
    lead: LEAD,
    preview,
  });
}

describe("channelAvailability and the kill switch", () => {
  it("renders nothing at all for a customer while the switch is off", () => {
    return availability(
      { messagingEnabled: false, emailEnabled: false, whatsappStatus: "connected" },
      false
    ).then((channels) => expect(channels).toEqual([]));
  });

  /** ⚠️ THE BUG. A connected admin must read as connected. */
  it("reports a CONNECTED admin as connected while the switch is off", async () => {
    const channels = await availability(
      { messagingEnabled: false, emailEnabled: false, whatsappStatus: "connected" },
      true
    );
    const wa = channels.find((c) => c.channel === "whatsapp");
    expect(wa?.connected).toBe(true);
    expect(wa?.setupStarted).toBe(false);
  });

  it("still reports an UNCONNECTED admin as not connected", async () => {
    const channels = await availability(
      { messagingEnabled: false, emailEnabled: false, whatsappStatus: "pending" },
      true
    );
    const wa = channels.find((c) => c.channel === "whatsapp");
    expect(wa?.connected).toBe(false);
    // "Started but not finished" is a different state from "never started".
    expect(wa?.setupStarted).toBe(true);
  });

  it("reports a connected customer once the switch is on", async () => {
    const channels = await availability(
      { messagingEnabled: true, emailEnabled: false, whatsappStatus: "connected" },
      false
    );
    expect(channels.find((c) => c.channel === "whatsapp")?.connected).toBe(true);
  });
});

describe("email is hidden, not deleted", () => {
  it("omits the email channel entirely while messaging_email_enabled is false", async () => {
    const channels = await availability(
      {
        messagingEnabled: true,
        emailEnabled: false,
        whatsappStatus: "connected",
        emailStatus: "verified",
      },
      false
    );
    expect(channels.map((c) => c.channel)).toEqual(["whatsapp"]);
  });

  it("returns it again the moment the switch is flipped", async () => {
    const channels = await availability(
      {
        messagingEnabled: true,
        emailEnabled: true,
        whatsappStatus: "connected",
        emailStatus: "verified",
      },
      false
    );
    // WhatsApp first — it is the only one customers see today.
    expect(channels.map((c) => c.channel)).toEqual(["whatsapp", "email"]);
    expect(channels.find((c) => c.channel === "email")?.connected).toBe(true);
  });

  it("shows it to an admin so the dormant flow stays rehearsable", async () => {
    const channels = await availability(
      { messagingEnabled: false, emailEnabled: false, emailStatus: "verified" },
      true
    );
    expect(channels.map((c) => c.channel)).toContain("email");
  });
});

describe("assignmentSendable", () => {
  it("refuses a rejected lead — settled and chargeable (§5E)", () => {
    expect(assignmentSendable({ status: "rejected" }).sendable).toBe(false);
  });

  it("refuses a closed lead — closing exists to stop exactly this (§18)", () => {
    expect(
      assignmentSendable({ status: "contacted", closed_reason: "not_interested" }).sendable
    ).toBe(false);
  });

  it("allows a won lead: an ongoing relationship, nothing left to protect", () => {
    expect(assignmentSendable({ status: "won" }).sendable).toBe(true);
  });
});
