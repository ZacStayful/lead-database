import { describe, expect, it } from "vitest";
import { buildContactTimeline } from "@/lib/contact/contactPlan";
import { CONTACT_ATTEMPTS } from "@/lib/contact/contactStrategy";

const NOW = new Date("2026-09-10T12:00:00Z");
const days = (n: number) =>
  new Date(NOW.getTime() + n * 86_400_000).toISOString();

const row = (
  step: number,
  over: Partial<{
    channel: string;
    body: string | null;
    send_after: string;
    state: string;
    done_at: string | null;
    done_source: string | null;
    call_outcome: string | null;
  }> = {}
) => ({
  step_number: step,
  channel: CONTACT_ATTEMPTS[step - 1].channel,
  body: null,
  send_after: days(-1),
  state: "pending",
  done_at: null,
  done_source: null,
  call_outcome: null,
  ...over,
});

describe("buildContactTimeline", () => {
  it("shows all five rungs for a lead with nothing materialised yet", () => {
    const t = buildContactTimeline({ rows: [], now: NOW });
    expect(t.attempts).toHaveLength(5);
    expect(t.total).toBe(5);
    expect(t.completed).toBe(0);
    // Every rung carries its objective even before the scheduler has queued it:
    // the operator must be able to see what is LEFT.
    for (const a of t.attempts) expect(a.objective.length).toBeGreaterThan(20);
    expect(t.attempts.every((a) => a.state === "upcoming")).toBe(true);
    expect(t.current).toBeNull();
  });

  it("marks the earliest outstanding rung as DUE and leaves later ones alone", () => {
    const t = buildContactTimeline({
      rows: [
        row(1, { state: "sent", done_at: days(-5), done_source: "click" }),
        row(2, { state: "sent", done_at: days(-5), done_source: "manual" }),
        row(3, { send_after: days(-2) }),
        row(4, { send_after: days(2) }),
      ],
      now: NOW,
    });
    expect(t.attempts[2].state).toBe("due");
    expect(t.current?.number).toBe(3);
    expect(t.attempts[3].state).toBe("upcoming");
    expect(t.completed).toBe(2);
  });

  it("distinguishes a click-completed rung from a manual one", () => {
    const t = buildContactTimeline({
      rows: [
        row(1, { state: "sent", done_at: days(-1), done_source: "click" }),
        row(2, { state: "sent", done_at: days(-1), done_source: "manual" }),
      ],
      now: NOW,
    });
    expect(t.attempts[0].byClick).toBe(true);
    expect(t.attempts[1].byClick).toBe(false);
  });

  it("carries the call outcome through", () => {
    const t = buildContactTimeline({
      rows: [
        row(1, { state: "sent", done_at: days(-1), done_source: "click", call_outcome: "no_answer" }),
      ],
      now: NOW,
    });
    expect(t.attempts[0].callOutcome).toBe("no_answer");
  });

  it("treats a cancelled rung as skipped, not done", () => {
    const t = buildContactTimeline({
      rows: [row(1, { state: "cancelled" })],
      now: NOW,
    });
    expect(t.attempts[0].state).toBe("skipped");
    expect(t.completed).toBe(0);
  });

  it("offers NOTHING to do on a stopped run — the landlord already replied", () => {
    const t = buildContactTimeline({
      rows: [row(1), row(2)],
      runStatus: "stopped",
      now: NOW,
    });
    expect(t.stopped).toBe(true);
    expect(t.current).toBeNull();
  });

  it("reports finished once all five are done", () => {
    const t = buildContactTimeline({
      rows: [1, 2, 3, 4, 5].map((n) =>
        row(n, { state: "sent", done_at: days(-1), done_source: "click" })
      ),
      now: NOW,
    });
    expect(t.completed).toBe(5);
    expect(t.finished).toBe(true);
    expect(t.current).toBeNull();
  });

  it("honours the landlord's stated preference on rung 1 only", () => {
    const t = buildContactTimeline({
      rows: [],
      landlordContactMethod: "email",
      now: NOW,
    });
    expect(t.attempts[0].channel).toBe("email");
    expect(t.attempts[1].channel).toBe(CONTACT_ATTEMPTS[1].channel);
    expect(t.attempts[3].channel).toBe("call");
  });

  it("⚠️ trusts the STORED channel over the default, so an edited plan renders truthfully", () => {
    // An operator may have changed their plan since; the timeline must show
    // what was actually scheduled rather than what the default says.
    const t = buildContactTimeline({
      rows: [row(1, { channel: "email" })],
      now: NOW,
    });
    expect(t.attempts[0].channel).toBe("email");
  });

  it("prefers a stored objective over the default, and ignores a blank one", () => {
    const t = buildContactTimeline({
      rows: [row(1, { body: "Ask about the loft conversion" }), row(2, { body: "   " })],
      now: NOW,
    });
    expect(t.attempts[0].objective).toBe("Ask about the loft conversion");
    expect(t.attempts[1].objective).toBe(CONTACT_ATTEMPTS[1].objective);
  });
});
