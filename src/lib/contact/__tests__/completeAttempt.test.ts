import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  channelClosedByEvent,
  completeAttempt,
  completeAttemptForEvent,
} from "@/lib/contact/completeAttempt";

// advanceRun / stopRun are exercised by the sequences suite; here we only care
// that the right one is called with the right arguments.
const advanceRun = vi.fn();
const stopRun = vi.fn();
vi.mock("@/lib/messaging/sequences", () => ({
  advanceRun: (...a: unknown[]) => advanceRun(...a),
  stopRun: (...a: unknown[]) => stopRun(...a),
}));

/**
 * A fake just wide enough for the two chains this module builds. Records the
 * update payload so the trust boundary can be asserted on what would actually
 * be written.
 */
function fakeAdmin(open: Record<string, unknown> | null) {
  const updates: Record<string, unknown>[] = [];
  const selectChain = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ["eq", "order", "limit"]) {
      chain[m] = () => chain;
    }
    // `limit` terminates the read.
    chain.limit = () =>
      Promise.resolve({ data: open ? [open] : [], error: null });
    return chain;
  };
  const updateChain = (payload: Record<string, unknown>) => {
    updates.push(payload);
    const chain: Record<string, unknown> = {};
    chain.eq = (_k: string, _v: unknown) => {
      // second .eq terminates
      return chain.__done ? Promise.resolve({ error: null }) : ((chain.__done = true), chain);
    };
    return chain;
  };
  return {
    updates,
    client: {
      from: () => ({
        select: () => selectChain(),
        update: (payload: Record<string, unknown>) => updateChain(payload),
      }),
    } as never,
  };
}

const openAttempt = (channel: string, step = 1) => ({
  id: `attempt-${step}`,
  run_id: "run-1",
  step_number: step,
  channel,
  message_sequence_runs: {
    id: "run-1",
    sequence_id: "seq-1",
    status: "active",
    assignment_id: "assign-1",
    message_sequences: { delivery: "manual" },
  },
});

beforeEach(() => {
  advanceRun.mockReset();
  stopRun.mockReset();
});

describe("channelClosedByEvent", () => {
  it("maps each click to its own channel and nothing else", () => {
    expect(channelClosedByEvent("tel_click")).toBe("call");
    expect(channelClosedByEvent("whatsapp_click")).toBe("whatsapp");
    expect(channelClosedByEvent("mailto_click")).toBe("email");
  });

  it("⚠️ detail_opened closes NOTHING — reading a lead is not contacting it", () => {
    expect(channelClosedByEvent("detail_opened")).toBeNull();
  });

  it("closes nothing for our own nudge, or the landlord's reply", () => {
    expect(channelClosedByEvent("nudge_sent")).toBeNull();
    expect(channelClosedByEvent("message_received")).toBeNull();
  });

  it("closes nothing for record-keeping", () => {
    expect(channelClosedByEvent("note_added")).toBeNull();
    expect(channelClosedByEvent("file_added")).toBeNull();
    expect(channelClosedByEvent("stage_changed")).toBeNull();
  });
});

describe("completeAttemptForEvent", () => {
  it("closes a matching attempt and advances the run", async () => {
    const { client, updates } = fakeAdmin(openAttempt("call"));
    const r = await completeAttemptForEvent(client, {
      assignmentId: "assign-1",
      eventType: "tel_click",
      eventId: "event-9",
    });
    expect(r.closed).toBe(true);
    expect(r.stepNumber).toBe(1);
    expect(advanceRun).toHaveBeenCalledOnce();
    expect(advanceRun.mock.calls[0][1]).toMatchObject({
      runId: "run-1",
      sequenceId: "seq-1",
      completedStep: 1,
    });
    expect(updates[0]).toMatchObject({ state: "sent", done_source: "click" });
  });

  it("returns quietly for detail_opened without touching the run", async () => {
    const { client, updates } = fakeAdmin(openAttempt("call"));
    const r = await completeAttemptForEvent(client, {
      assignmentId: "assign-1",
      eventType: "detail_opened",
    });
    expect(r).toEqual({ closed: false, reason: "not_a_contact_event" });
    expect(updates).toHaveLength(0);
    expect(advanceRun).not.toHaveBeenCalled();
  });

  it("closes nothing when no attempt of that channel is open", async () => {
    const { client } = fakeAdmin(null);
    const r = await completeAttemptForEvent(client, {
      assignmentId: "assign-1",
      eventType: "whatsapp_click",
    });
    expect(r.closed).toBe(false);
    expect(r.reason).toBe("no_matching_attempt");
    expect(advanceRun).not.toHaveBeenCalled();
  });
});

describe("⚠️ the trust boundary", () => {
  it("a CLICK records done_event_id, so the completion traces to the click", async () => {
    const { client, updates } = fakeAdmin(openAttempt("whatsapp"));
    await completeAttempt(client, {
      assignmentId: "assign-1",
      channel: "whatsapp",
      source: "click",
      eventId: "event-42",
    });
    expect(updates[0]).toMatchObject({
      done_source: "click",
      done_event_id: "event-42",
    });
  });

  it("a MANUAL completion NEVER carries an event id, even if one is passed", async () => {
    // The DB CHECK refuses the pair outright; this makes the application layer
    // refuse it too, so a caller cannot launder a manual tick into engagement.
    const { client, updates } = fakeAdmin(openAttempt("call"));
    await completeAttempt(client, {
      assignmentId: "assign-1",
      channel: "call",
      source: "manual",
      eventId: "event-42",
    });
    expect(updates[0]).toMatchObject({
      done_source: "manual",
      done_event_id: null,
    });
  });

  it("a manual completion still advances the plan — adherence counts both", async () => {
    const { client } = fakeAdmin(openAttempt("email"));
    const r = await completeAttempt(client, {
      assignmentId: "assign-1",
      channel: "email",
      source: "manual",
    });
    expect(r.closed).toBe(true);
    expect(advanceRun).toHaveBeenCalledOnce();
  });
});

describe("⚠️ an answered call ends the plan", () => {
  it("stops the run instead of advancing it", async () => {
    const { client } = fakeAdmin(openAttempt("call"));
    const r = await completeAttempt(client, {
      assignmentId: "assign-1",
      channel: "call",
      source: "click",
      eventId: "e1",
      callOutcome: "answered",
    });
    expect(r.runStopped).toBe(true);
    expect(stopRun).toHaveBeenCalledWith(expect.anything(), "run-1", "replied");
    expect(advanceRun).not.toHaveBeenCalled();
  });

  it("no answer advances to the next attempt, as the sequence requires", async () => {
    const { client } = fakeAdmin(openAttempt("call"));
    const r = await completeAttempt(client, {
      assignmentId: "assign-1",
      channel: "call",
      source: "click",
      eventId: "e1",
      callOutcome: "no_answer",
    });
    expect(r.runStopped).toBe(false);
    expect(advanceRun).toHaveBeenCalledOnce();
    expect(stopRun).not.toHaveBeenCalled();
  });

  it("voicemail advances too — a message left is not a conversation", async () => {
    const { client } = fakeAdmin(openAttempt("call"));
    await completeAttempt(client, {
      assignmentId: "assign-1",
      channel: "call",
      source: "click",
      eventId: "e1",
      callOutcome: "voicemail",
    });
    expect(advanceRun).toHaveBeenCalledOnce();
    expect(stopRun).not.toHaveBeenCalled();
  });
});
