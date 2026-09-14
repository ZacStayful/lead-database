import { describe, expect, it } from "vitest";
import { buildLeadActivity, type ActivityInput } from "../leadActivity";
import { CLIENT_LEAD_EVENT_TYPES } from "../types";
import { LEAD_EVENT_LABEL, OPERATOR_EVENT_COPY, SYSTEM_LEAD_EVENT_TYPES } from "../leadEvents";
import type { LeadEventType } from "../types";

const base: ActivityInput = {
  assignment: {
    id: "a1",
    assigned_at: "2026-09-09T17:05:00Z",
    first_contacted_at: null,
    landlord_referral_sent_at: null,
    status: "new",
    closed_at: null,
  },
  events: [],
  messages: [],
  notes: [],
  files: [],
};

describe("buildLeadActivity", () => {
  it("always starts from the delivery, newest first", () => {
    const items = buildLeadActivity({
      ...base,
      assignment: { ...base.assignment, landlord_referral_sent_at: "2026-09-09T17:06:00Z" },
    });
    expect(items.map((i) => i.kind)).toEqual(["introduced", "delivered"]);
  });

  it("renders stage_changed from its metadata with product labels", () => {
    const [item] = buildLeadActivity({
      ...base,
      events: [{ id: "e1", event_type: "stage_changed", created_at: "2026-09-11T10:30:00Z", metadata: { from: "cold", to: "web_meeting_booked" } }],
    });
    expect(item.kind).toBe("stage");
    expect(item.label).toBe("Stage → Web meeting booked");
    expect(item.detail).toBe("from Cold");
  });

  it("never renders a nudge or a detail_opened as operator activity", () => {
    const items = buildLeadActivity({
      ...base,
      events: [
        { id: "e1", event_type: "nudge_sent", created_at: "2026-09-11T10:30:00Z" },
        { id: "e2", event_type: "detail_opened", created_at: "2026-09-11T10:31:00Z" },
        { id: "e3", event_type: "message_sent", created_at: "2026-09-11T10:32:00Z" },
      ],
    });
    expect(items.map((i) => i.kind)).toEqual(["delivered"]);
  });

  it("an email open and a link click become their own rows at their own times", () => {
    const items = buildLeadActivity({
      ...base,
      messages: [
        {
          id: "m1",
          channel: "email",
          direction: "outbound",
          subject: "Short-term let projection",
          body_text: "Hi",
          created_at: "2026-09-11T10:02:00Z",
          first_opened_at: "2026-09-11T14:20:00Z",
          first_clicked_at: "2026-09-11T14:25:00Z",
        },
      ],
    });
    expect(items.map((i) => [i.kind, i.at])).toEqual([
      ["clicked_link", "2026-09-11T14:25:00Z"],
      ["opened", "2026-09-11T14:20:00Z"],
      ["message_out", "2026-09-11T10:02:00Z"],
      ["delivered", "2026-09-09T17:05:00Z"],
    ]);
  });

  it("an inbound message is the landlord's reply, worded as theirs", () => {
    const [item] = buildLeadActivity({
      ...base,
      messages: [{ id: "m1", channel: "whatsapp", direction: "inbound", subject: null, body_text: "Morning works best", created_at: "2026-09-14T08:32:00Z" }],
    });
    expect(item.kind).toBe("message_in");
    expect(item.label).toBe("Replied on WhatsApp");
    expect(item.detail).toBe("Morning works best");
  });

  it("a manually ticked attempt is a row; a click-closed one is not (its click already is)", () => {
    const items = buildLeadActivity({
      ...base,
      events: [{ id: "e1", event_type: "tel_click", created_at: "2026-09-10T09:00:00Z" }],
      attempts: [
        { number: 1, channel: "call", objective: "", dueAt: null, doneAt: "2026-09-10T09:00:00Z", state: "done", callOutcome: null, byClick: true },
        { number: 2, channel: "whatsapp", objective: "", dueAt: null, doneAt: "2026-09-10T15:00:00Z", state: "done", callOutcome: null, byClick: false },
      ],
      totalAttempts: 5,
    });
    const kinds = items.map((i) => i.kind);
    expect(kinds.filter((k) => k === "attempt")).toHaveLength(1);
    expect(kinds.filter((k) => k === "click")).toHaveLength(1);
    expect(items.find((i) => i.kind === "attempt")?.label).toBe("Follow-up 2 of 5 done");
  });

  it("notes are excerpted, files named", () => {
    const items = buildLeadActivity({
      ...base,
      notes: [{ id: "n1", body: "  Prefers   mornings. ".padEnd(200, "x"), created_at: "2026-09-12T10:00:00Z" }],
      files: [{ id: "f1", file_name: "Income analysis.pdf", created_at: "2026-09-12T11:00:00Z" }],
    });
    expect(items[0]).toMatchObject({ kind: "file", detail: "Income analysis.pdf" });
    expect(items[1].kind).toBe("note");
    expect(items[1].detail?.length).toBeLessThanOrEqual(90);
    expect(items[1].detail?.startsWith("Prefers mornings.")).toBe(true);
  });
});

describe("leadEvents — the shared vocabulary", () => {
  it("labels every event type in both voices", () => {
    const all: LeadEventType[] = [
      "detail_opened", "tel_click", "mailto_click", "whatsapp_click", "note_added",
      "file_added", "stage_changed", "message_sent", "message_received", "nudge_sent",
    ];
    for (const t of all) {
      expect(LEAD_EVENT_LABEL[t]).toBeTruthy();
      expect(OPERATOR_EVENT_COPY[t]).toBeTruthy();
    }
  });

  it("keeps stage_changed server-side: the browser may still report only the four", () => {
    // ⚠️ The PATCH route now writes stage_changed itself. It must never join
    // the client-reportable set — a customer able to POST it could shield
    // every lead they hold from escalation (§3, §40.7).
    expect([...CLIENT_LEAD_EVENT_TYPES]).toEqual(["detail_opened", "tel_click", "mailto_click", "whatsapp_click"]);
    expect(SYSTEM_LEAD_EVENT_TYPES).toEqual(["nudge_sent"]);
  });
});
