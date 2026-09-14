import { describe, expect, it } from "vitest";
import { buildThreadItems, londonDayKey, type ThreadMessageInput } from "../threadItems";
import type { TimelineAttempt } from "@/lib/contact/contactPlan";

const NOW = new Date("2026-09-14T09:00:00Z");

function msg(over: Partial<ThreadMessageInput> & { id: string; created_at: string }): ThreadMessageInput {
  return {
    channel: "whatsapp",
    direction: "outbound",
    status: "sent",
    subject: null,
    body_text: "hello",
    ...over,
  };
}

function attempt(over: Partial<TimelineAttempt> & { number: number }): TimelineAttempt {
  return {
    channel: "whatsapp",
    objective: "Same day, only if the call went unanswered.",
    dueAt: null,
    doneAt: null,
    state: "upcoming",
    callOutcome: null,
    byClick: false,
    ...over,
  };
}

describe("buildThreadItems", () => {
  it("orders messages, clicks and attempts by time, oldest first", () => {
    const items = buildThreadItems({
      now: NOW,
      messages: [msg({ id: "m1", created_at: "2026-09-11T09:14:00Z" })],
      events: [{ id: "e1", event_type: "tel_click", created_at: "2026-09-10T09:00:00Z" }],
      attempts: [attempt({ number: 3, state: "due", dueAt: "2026-09-14T08:00:00Z" })],
      totalAttempts: 5,
    });
    expect(items.map((i) => i.kind)).toEqual(["click", "message", "attempt"]);
  });

  it("a click row carries no status and is worded as the operator's own act", () => {
    const [item] = buildThreadItems({
      now: NOW,
      messages: [],
      events: [{ id: "e1", event_type: "whatsapp_click", created_at: "2026-09-10T09:00:00Z" }],
    });
    expect(item.kind).toBe("click");
    expect("status" in item).toBe(false);
    expect("statusLabel" in item).toBe(false);
    if (item.kind === "click") {
      expect(item.channel).toBe("whatsapp");
      expect(item.label).toMatch(/from your phone/);
    }
  });

  it("drops non-click events (opens, nudges, server-side types)", () => {
    const items = buildThreadItems({
      now: NOW,
      messages: [],
      events: [
        { id: "e1", event_type: "detail_opened", created_at: "2026-09-10T09:00:00Z" },
        { id: "e2", event_type: "nudge_sent", created_at: "2026-09-10T09:00:00Z" },
        { id: "e3", event_type: "message_sent", created_at: "2026-09-10T09:00:00Z" },
      ],
    });
    expect(items).toEqual([]);
  });

  it("uses the shared statusLabel: read outranks opened", () => {
    const [item] = buildThreadItems({
      now: NOW,
      messages: [msg({ id: "m1", created_at: "2026-09-11T09:14:00Z", status: "delivered", first_opened_at: "2026-09-11T10:00:00Z", read_at: "2026-09-11T11:00:00Z" })],
      events: [],
    });
    if (item.kind === "message") {
      expect(item.statusLabel).toBe("Read");
      expect(item.approximate).toBe(false);
    } else throw new Error("expected message");
  });

  it("an inbound message reads as a reply", () => {
    const [item] = buildThreadItems({
      now: NOW,
      messages: [msg({ id: "m1", created_at: "2026-09-11T09:14:00Z", direction: "inbound", status: "received" })],
      events: [],
    });
    if (item.kind === "message") expect(item.statusLabel).toBe("Reply");
    else throw new Error("expected message");
  });

  it("an email carries a from → to line; a WhatsApp does not", () => {
    const items = buildThreadItems({
      now: NOW,
      messages: [
        msg({ id: "m1", created_at: "2026-09-11T09:14:00Z", channel: "email", from_address: "me@x.co.uk", to_address: "p@example.com" }),
        msg({ id: "m2", created_at: "2026-09-11T09:15:00Z" }),
      ],
      events: [],
    });
    expect(items.map((i) => (i.kind === "message" ? i.fromLine : "?"))).toEqual(["me@x.co.uk → p@example.com", null]);
  });

  it("a due attempt becomes a system row; overdue after a day; a click-closed rung adds nothing", () => {
    const items = buildThreadItems({
      now: NOW,
      messages: [],
      events: [],
      attempts: [
        attempt({ number: 1, state: "done", doneAt: "2026-09-10T09:00:00Z", byClick: true }),
        attempt({ number: 2, state: "done", doneAt: "2026-09-11T09:00:00Z", byClick: false, channel: "call" }),
        attempt({ number: 3, state: "due", dueAt: "2026-09-14T08:00:00Z" }),
        attempt({ number: 4, state: "overdue", dueAt: "2026-09-10T08:00:00Z" }),
        attempt({ number: 5, state: "upcoming" }),
      ],
      totalAttempts: 5,
    });
    const attempts = items.filter((i) => i.kind === "attempt");
    expect(attempts.map((i) => (i.kind === "attempt" ? [i.number, i.state] : null))).toEqual([
      [4, "overdue"],
      [2, "done"],
      [3, "due"],
    ]);
    const due = attempts.find((i) => i.kind === "attempt" && i.number === 3);
    expect(due && due.kind === "attempt" ? due.label : "").toBe("Follow-up 3 of 5 due today · WhatsApp · reply and the plan stops here");
  });
});

describe("londonDayKey", () => {
  it("cuts days in London, not UTC", () => {
    // 23:30 UTC on 31 July is 00:30 BST on 1 August.
    expect(londonDayKey("2026-07-31T23:30:00Z")).toBe("2026-08-01");
    expect(londonDayKey("2026-01-31T23:30:00Z")).toBe("2026-01-31");
  });
});
