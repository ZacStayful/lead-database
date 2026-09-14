import { describe, expect, it } from "vitest";
import { buildInboxRows, type InboxClick, type InboxMessagePreview, type InboxThread } from "../inbox";
import type { AssignmentWithLead } from "@/lib/types";

function assignment(id: string, leadId: string): AssignmentWithLead {
  return {
    id,
    lead_id: leadId,
    customer_id: "cust",
    assigned_at: "2026-09-01T09:00:00Z",
    status: "new",
    pipeline_stage: "cold",
    lead: { id: leadId, lead_name: `Lead ${leadId}`, lead_type: "management" },
  } as unknown as AssignmentWithLead;
}

function thread(over: Partial<InboxThread> & { id: string; assignment_id: string }): InboxThread {
  return {
    channel: "whatsapp",
    lead_id: "l1",
    unread_inbound_count: 0,
    starred_at: null,
    last_message_at: null,
    last_inbound_at: null,
    ...over,
  };
}

const A1 = assignment("a1", "l1");
const A2 = assignment("a2", "l2");
const A3 = assignment("a3", "l3");

describe("buildInboxRows — which leads appear", () => {
  it("omits a lead with neither a thread nor a click", () => {
    const rows = buildInboxRows({ assignments: [A1, A2], threads: [], previews: [], clicks: [] });
    expect(rows).toEqual([]);
  });

  it("includes a lead with only a click, as a click row with no message", () => {
    const clicks: InboxClick[] = [{ assignment_id: "a1", event_type: "whatsapp_click", created_at: "2026-09-10T10:00:00Z" }];
    const [row] = buildInboxRows({ assignments: [A1], threads: [], previews: [], clicks });
    expect(row.leadId).toBe("l1");
    expect(row.hasMessages).toBe(false);
    expect(row.channels).toEqual([]);
    expect(row.preview.kind).toBe("click");
    expect(row.preview.channel).toBe("whatsapp");
    expect(row.lastActivityAt).toBe("2026-09-10T10:00:00Z");
  });

  it("ignores detail_opened and nudge_sent even if handed to it", () => {
    const clicks: InboxClick[] = [
      { assignment_id: "a1", event_type: "detail_opened", created_at: "2026-09-10T10:00:00Z" },
      { assignment_id: "a1", event_type: "nudge_sent", created_at: "2026-09-11T10:00:00Z" },
    ];
    expect(buildInboxRows({ assignments: [A1], threads: [], previews: [], clicks })).toEqual([]);
  });
});

describe("buildInboxRows — grouping by lead", () => {
  it("folds a WhatsApp thread and an email thread on one lead into one row", () => {
    const threads = [
      thread({ id: "t1", assignment_id: "a1", channel: "whatsapp", unread_inbound_count: 2, last_message_at: "2026-09-10T10:00:00Z" }),
      thread({ id: "t2", assignment_id: "a1", channel: "email", unread_inbound_count: 1, last_message_at: "2026-09-12T10:00:00Z", starred_at: "2026-09-12T11:00:00Z" }),
    ];
    const rows = buildInboxRows({ assignments: [A1], threads, previews: [], clicks: [] });
    expect(rows).toHaveLength(1);
    expect(rows[0].channels).toEqual(["whatsapp", "email"]);
    expect(rows[0].unread).toBe(3);
    expect(rows[0].starred).toBe(true);
    expect(rows[0].lastActivityAt).toBe("2026-09-12T10:00:00Z");
  });

  it("never merges two customers' assignments for the same lead (rows are per assignment)", () => {
    const other = assignment("a9", "l1");
    const threads = [thread({ id: "t1", assignment_id: "a1", last_message_at: "2026-09-10T10:00:00Z" })];
    const rows = buildInboxRows({ assignments: [A1, other], threads, previews: [], clicks: [] });
    expect(rows.map((r) => r.assignmentId)).toEqual(["a1"]);
  });
});

describe("buildInboxRows — preview and ordering", () => {
  const previews: InboxMessagePreview[] = [
    { thread_id: "t1", direction: "inbound", channel: "whatsapp", subject: null, body_text: "  Yes still   interested ", created_at: "2026-09-12T08:31:00Z" },
    { thread_id: "t1", direction: "outbound", channel: "whatsapp", subject: null, body_text: "Hi Priya", created_at: "2026-09-11T09:14:00Z" },
  ];

  it("uses the newest message as the preview and collapses whitespace", () => {
    const threads = [thread({ id: "t1", assignment_id: "a1", last_message_at: "2026-09-12T08:31:00Z" })];
    const [row] = buildInboxRows({ assignments: [A1], threads, previews, clicks: [] });
    expect(row.preview).toEqual({ kind: "message", channel: "whatsapp", direction: "inbound", text: "Yes still interested" });
    expect(row.hasMessages).toBe(true);
  });

  it("a later click beats an earlier message for the preview, and never carries a status", () => {
    const threads = [thread({ id: "t1", assignment_id: "a1", last_message_at: "2026-09-12T08:31:00Z" })];
    const clicks: InboxClick[] = [{ assignment_id: "a1", event_type: "tel_click", created_at: "2026-09-13T08:00:00Z" }];
    const [row] = buildInboxRows({ assignments: [A1], threads, previews, clicks });
    expect(row.preview.kind).toBe("click");
    expect(row.lastActivityAt).toBe("2026-09-13T08:00:00Z");
    expect(Object.keys(row.preview)).not.toContain("status");
  });

  it("on a tie the message wins over the click", () => {
    const threads = [thread({ id: "t1", assignment_id: "a1", last_message_at: "2026-09-12T08:31:00Z" })];
    const clicks: InboxClick[] = [{ assignment_id: "a1", event_type: "tel_click", created_at: "2026-09-12T08:31:00Z" }];
    const [row] = buildInboxRows({ assignments: [A1], threads, previews, clicks });
    expect(row.preview.kind).toBe("message");
  });

  it("orders rows by most recent activity of any kind", () => {
    const threads = [thread({ id: "t1", assignment_id: "a1", last_message_at: "2026-09-10T10:00:00Z" })];
    const clicks: InboxClick[] = [
      { assignment_id: "a2", event_type: "mailto_click", created_at: "2026-09-13T10:00:00Z" },
      { assignment_id: "a3", event_type: "tel_click", created_at: "2026-09-05T10:00:00Z" },
    ];
    const rows = buildInboxRows({ assignments: [A1, A2, A3], threads, previews: [], clicks });
    expect(rows.map((r) => r.leadId)).toEqual(["l2", "l1", "l3"]);
  });

  it("uses the subject when an email has no body, and a fallback when a thread has no message", () => {
    const threads = [
      thread({ id: "t1", assignment_id: "a1", channel: "email", last_message_at: "2026-09-12T08:31:00Z" }),
      thread({ id: "t2", assignment_id: "a2", channel: "email", last_message_at: "2026-09-12T08:31:00Z" }),
    ];
    const p: InboxMessagePreview[] = [
      { thread_id: "t1", direction: "outbound", channel: "email", subject: "Projection for 14 Harrison Terrace", body_text: "", created_at: "2026-09-12T08:31:00Z" },
    ];
    const rows = buildInboxRows({ assignments: [A1, A2], threads, previews: p, clicks: [] });
    expect(rows.find((r) => r.leadId === "l1")?.preview.text).toBe("Projection for 14 Harrison Terrace");
    expect(rows.find((r) => r.leadId === "l2")?.preview.text).toBe("No messages yet");
  });
});
