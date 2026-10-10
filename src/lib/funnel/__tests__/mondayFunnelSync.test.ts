import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The funnel's Monday writes (batch 03 Phase 2, §76), run against in-memory
 * Supabase and a stateful fake board. The batch doc's check, in its words:
 * "each transition writes once and protected statuses are never overwritten".
 */

const BOARD = "18420649520";
const LABEL_IDS: Record<number, string> = { 21: "Funnel started", 22: "Funnel finished, not paid" };

const monday = vi.hoisted(() => ({
  items: new Map<string, { boardId: string; statusLabel: string; signup?: string }>(),
  failRead: null as string | null,
  failWrite: null as string | null,
  throwRead: false,
  reads: 0,
  writes: [] as { itemId: string; labelId: number }[],
  signupWrites: [] as { itemId: string; columnId: string; label: string }[],
}));

vi.mock("@/lib/monday", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/monday")>();
  return {
    ...real,
    enquiryBoardId: () => BOARD,
    fetchEnquiryItem: vi.fn(async (itemId: string) => {
      monday.reads += 1;
      if (monday.throwRead) throw new Error("socket hang up");
      if (monday.failRead) return { ok: false as const, error: monday.failRead };
      const item = monday.items.get(itemId);
      if (!item) return { ok: true as const, item: null };
      return {
        ok: true as const,
        item: {
          id: itemId,
          name: "Jo",
          boardId: item.boardId,
          emails: [],
          phoneKey: "",
          statusLabel: item.statusLabel,
          startDate: "",
          endDate: "",
          leadInterest: "",
        },
      };
    }),
    setEnquiryStatusById: vi.fn(async ({ itemId, labelId }: { itemId: string; labelId: number }) => {
      if (monday.failWrite) return { written: false, error: monday.failWrite };
      monday.writes.push({ itemId, labelId });
      const item = monday.items.get(itemId)!;
      item.statusLabel = LABEL_IDS[labelId] ?? `#${labelId}`;
      return { written: true };
    }),
    setEnquirySignupSource: vi.fn(
      async ({ itemId, columnId, label }: { itemId: string; columnId: string; label: string }) => {
        const item = monday.items.get(itemId);
        if (!item) return { written: false, error: "item not found" };
        if (item.boardId !== BOARD) return { written: false, skipped: "not_status_board" as const };
        if (item.signup === label) return { written: false, skipped: "unchanged" as const };
        monday.signupWrites.push({ itemId, columnId, label });
        item.signup = label;
        return { written: true };
      }
    ),
  };
});

import {
  claimFunnelMondayWrite,
  pushSignupSource,
  runFunnelMondayPasses,
  syncFunnelMondayStatus,
} from "@/lib/funnel/mondayFunnelSync";
import { fakeDb } from "@/lib/checkout/__tests__/fakes";

const NOW = new Date("2026-10-09T12:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const ago = (ms: number, from = NOW) => new Date(from.getTime() - ms).toISOString();
const later = (ms: number) => new Date(NOW.getTime() + ms);

const ENV = {
  MONDAY_API_TOKEN: "tok",
  MONDAY_STATUS_FUNNEL_STARTED: "21",
  MONDAY_STATUS_FUNNEL_FINISHED: "22",
  MONDAY_SIGNUP_SOURCE_COLUMN_ID: "color_signup",
};
const PK = { primaryKeys: { funnel_monday_writes: "session_id,transition" } };

function sessionRow(over: Record<string, unknown> = {}) {
  return {
    id: "s1",
    monday_item_id: "item1",
    step: "previewed",
    updated_at: ago(2 * HOUR),
    paid_at: null,
    first_answered_at: ago(3 * HOUR),
    ...over,
  };
}

function harness(sessions: Record<string, unknown>[] = [sessionRow()], claims: Record<string, unknown>[] = [], opts = {}) {
  return fakeDb({ funnel_sessions: sessions, funnel_monday_writes: claims }, { ...PK, ...opts });
}

beforeEach(() => {
  monday.items.clear();
  monday.items.set("item1", { boardId: BOARD, statusLabel: "New Enquiries" });
  monday.failRead = null;
  monday.failWrite = null;
  monday.throwRead = false;
  monday.reads = 0;
  monday.writes = [];
  monday.signupWrites = [];
});

const SESSION = { id: "s1", monday_item_id: "item1" };
const claimOf = (db: ReturnType<typeof fakeDb>, transition = "started") =>
  db.tables.funnel_monday_writes.find((c) => c.session_id === "s1" && c.transition === transition);

describe("syncFunnelMondayStatus — one transition, once", () => {
  it("claims, reads the cell, writes by label id, and settles 'written'", async () => {
    const db = harness();
    const r = await syncFunnelMondayStatus(db.admin, SESSION, "started", { now: NOW, env: ENV });
    expect(r).toEqual({ outcome: "written" });
    expect(monday.writes).toEqual([{ itemId: "item1", labelId: 21 }]);
    expect(monday.items.get("item1")!.statusLabel).toBe("Funnel started");
    const claim = claimOf(db)!;
    expect(claim.outcome).toBe("written");
    expect(claim.completed_at).toBeTruthy();
  });

  it("a second attempt is held by the claim and touches nothing", async () => {
    const db = harness();
    await syncFunnelMondayStatus(db.admin, SESSION, "started", { now: NOW, env: ENV });
    monday.items.get("item1")!.statusLabel = "New Enquiries"; // even if somebody reset it
    const again = await syncFunnelMondayStatus(db.admin, SESSION, "started", { now: later(3 * HOUR), env: ENV });
    expect(again).toEqual({ outcome: "not_attempted", reason: "held" });
    expect(monday.writes).toHaveLength(1);
    expect(monday.reads).toBe(1);
  });

  it("'finished' follows 'started' on the same item (E2)", async () => {
    const db = harness();
    await syncFunnelMondayStatus(db.admin, SESSION, "started", { now: NOW, env: ENV });
    const r = await syncFunnelMondayStatus(db.admin, SESSION, "finished", { now: NOW, env: ENV });
    expect(r.outcome).toBe("written");
    expect(monday.items.get("item1")!.statusLabel).toBe("Funnel finished, not paid");
  });

  it("never overwrites a protected status, and never asks again", async () => {
    for (const label of ["Web meeting booked", "Web meeting sat", "Management Customer", "Paused", "Cancelling", "Cancelled"]) {
      monday.items.set("item1", { boardId: BOARD, statusLabel: label });
      monday.writes = [];
      const db = harness();
      const r = await syncFunnelMondayStatus(db.admin, SESSION, "finished", { now: NOW, env: ENV });
      expect(r, label).toEqual({ outcome: "skipped", reason: `protected: ${label}` });
      expect(monday.writes, label).toEqual([]);
      expect(monday.items.get("item1")!.statusLabel).toBe(label);
      expect(claimOf(db, "finished")!.outcome).toBe("skipped");
      const later2 = await syncFunnelMondayStatus(db.admin, SESSION, "finished", { now: later(5 * HOUR), env: ENV });
      expect(later2.outcome, label).toBe("not_attempted");
    }
  });

  it("'started' over a finished session is refused, not walked back", async () => {
    monday.items.set("item1", { boardId: BOARD, statusLabel: "Funnel finished, not paid" });
    const db = harness();
    const r = await syncFunnelMondayStatus(db.admin, SESSION, "started", { now: NOW, env: ENV });
    expect(r.outcome).toBe("skipped");
    expect(monday.writes).toEqual([]);
  });

  it("a cell that already says it is settled 'unchanged' with no write", async () => {
    monday.items.set("item1", { boardId: BOARD, statusLabel: "Funnel started" });
    const db = harness();
    const r = await syncFunnelMondayStatus(db.admin, SESSION, "started", { now: NOW, env: ENV });
    expect(r).toEqual({ outcome: "skipped", reason: "unchanged" });
    expect(monday.writes).toEqual([]);
  });

  it("not configured: no claim, no read — so it is picked up once configured", async () => {
    for (const env of [
      { ...ENV, MONDAY_STATUS_FUNNEL_STARTED: "" },
      { ...ENV, MONDAY_STATUS_FUNNEL_STARTED: "Funnel started" },
      { ...ENV, MONDAY_API_TOKEN: undefined },
    ]) {
      const db = harness();
      const r = await syncFunnelMondayStatus(db.admin, SESSION, "started", { now: NOW, env });
      expect(r).toEqual({ outcome: "not_attempted", reason: "not_configured" });
      expect(db.tables.funnel_monday_writes).toEqual([]);
    }
    expect(monday.reads).toBe(0);
  });

  it("no board item: no claim, so a session whose item arrives later still gets it", async () => {
    const db = harness();
    const r = await syncFunnelMondayStatus(db.admin, { id: "s1", monday_item_id: null }, "started", { now: NOW, env: ENV });
    expect(r).toEqual({ outcome: "not_attempted", reason: "no_item" });
    expect(db.tables.funnel_monday_writes).toEqual([]);
  });

  it("an item on another board, or gone, is settled 'skipped'", async () => {
    monday.items.set("item1", { boardId: "18420913271", statusLabel: "" });
    const db = harness();
    expect(await syncFunnelMondayStatus(db.admin, SESSION, "started", { now: NOW, env: ENV })).toEqual({
      outcome: "skipped",
      reason: "not_status_board",
    });
    monday.items.clear();
    const db2 = harness();
    expect(await syncFunnelMondayStatus(db2.admin, SESSION, "started", { now: NOW, env: ENV })).toEqual({
      outcome: "skipped",
      reason: "item_not_found",
    });
    expect(monday.writes).toEqual([]);
  });

  it("a failed read is 'failed', held for an hour, then retried and written", async () => {
    const db = harness();
    monday.failRead = "Monday API HTTP 503";
    const first = await syncFunnelMondayStatus(db.admin, SESSION, "started", { now: NOW, env: ENV });
    expect(first.outcome).toBe("failed");
    expect(claimOf(db)!.detail).toContain("503");
    monday.failRead = null;
    expect((await syncFunnelMondayStatus(db.admin, SESSION, "started", { now: later(HOUR - MIN), env: ENV })).outcome).toBe(
      "not_attempted"
    );
    const retried = await syncFunnelMondayStatus(db.admin, SESSION, "started", { now: later(HOUR + MIN), env: ENV });
    expect(retried.outcome).toBe("written");
    expect(claimOf(db)!.outcome).toBe("written");
    expect(claimOf(db)!.detail).toBeNull();
  });

  it("a failed write is 'failed' too", async () => {
    monday.failWrite = "missingLabel";
    const db = harness();
    const r = await syncFunnelMondayStatus(db.admin, SESSION, "started", { now: NOW, env: ENV });
    expect(r).toEqual({ outcome: "failed", reason: "write: missingLabel" });
  });

  it("never throws: a throw from Monday settles 'failed'", async () => {
    monday.throwRead = true;
    const db = harness();
    const r = await syncFunnelMondayStatus(db.admin, SESSION, "started", { now: NOW, env: ENV });
    expect(r.outcome).toBe("failed");
    expect(claimOf(db)!.outcome).toBe("failed");
  });

  it("a claim nobody settled is taken over after an hour, not before", async () => {
    const db = harness([sessionRow()], [
      { session_id: "s1", transition: "started", claimed_at: ago(30 * MIN), outcome: null, completed_at: null, detail: null },
    ]);
    expect((await syncFunnelMondayStatus(db.admin, SESSION, "started", { now: NOW, env: ENV })).outcome).toBe("not_attempted");
    const stale = harness([sessionRow()], [
      { session_id: "s1", transition: "started", claimed_at: ago(2 * HOUR), outcome: null, completed_at: null, detail: null },
    ]);
    expect((await syncFunnelMondayStatus(stale.admin, SESSION, "started", { now: NOW, env: ENV })).outcome).toBe("written");
  });

  it("an unexpected insert error claims nothing and calls nothing", async () => {
    const db = harness([sessionRow()], [], { failInsert: { funnel_monday_writes: { code: "42501", message: "denied" } } });
    const r = await syncFunnelMondayStatus(db.admin, SESSION, "started", { now: NOW, env: ENV });
    expect(r).toEqual({ outcome: "not_attempted", reason: "claim_failed" });
    expect(monday.reads).toBe(0);
  });

  it("of two runs reaching for one stale claim, exactly one gets it", async () => {
    const db = harness([sessionRow()], [
      { session_id: "s1", transition: "started", claimed_at: ago(2 * HOUR), outcome: "failed", completed_at: ago(2 * HOUR), detail: "x" },
    ]);
    const a = await claimFunnelMondayWrite(db.admin, "s1", "started", NOW);
    const b = await claimFunnelMondayWrite(db.admin, "s1", "started", NOW);
    expect([a, b]).toEqual(["claimed", "held"]);
  });
});

describe("runFunnelMondayPasses — the cron's two passes", () => {
  it("writes 'started' then 'finished' for a session due both", async () => {
    const db = harness();
    const run = await runFunnelMondayPasses(db.admin, { now: NOW, env: ENV });
    expect(run.ok).toBe(true);
    expect(run.passes.map((p) => [p.transition, p.written])).toEqual([
      ["started", 1],
      ["finished", 1],
    ]);
    expect(monday.writes.map((w) => w.labelId)).toEqual([21, 22]);
    expect(monday.items.get("item1")!.statusLabel).toBe("Funnel finished, not paid");
  });

  it("a second run writes nothing", async () => {
    const db = harness();
    await runFunnelMondayPasses(db.admin, { now: NOW, env: ENV });
    const again = await runFunnelMondayPasses(db.admin, { now: later(15 * MIN), env: ENV });
    expect(again.passes.every((p) => p.attempted === 0 && p.due === 0)).toBe(true);
    expect(monday.writes).toHaveLength(2);
  });

  it("selects only who is due", async () => {
    const db = harness([
      sessionRow({ id: "due" }),
      sessionRow({ id: "paid", paid_at: ago(MIN), step: "paid" }),
      sessionRow({ id: "no-item", monday_item_id: null }),
      sessionRow({ id: "fresh", first_answered_at: ago(MIN), updated_at: ago(MIN) }),
      sessionRow({ id: "old", first_answered_at: ago(8 * 24 * HOUR), updated_at: ago(8 * 24 * HOUR) }),
      sessionRow({ id: "unanswered", step: "started", first_answered_at: null, updated_at: ago(2 * HOUR) }),
    ]);
    const run = await runFunnelMondayPasses(db.admin, { now: NOW, env: ENV, dryRun: true });
    const [started, finished] = run.passes;
    expect(started.wouldWrite!.sort()).toEqual(["due", "fresh"]);
    expect(finished.wouldWrite).toEqual(["due"]);
  });

  it("a dry run claims nothing and calls nothing, configured or not", async () => {
    for (const env of [ENV, {}]) {
      const db = harness();
      const run = await runFunnelMondayPasses(db.admin, { now: NOW, env, dryRun: true });
      expect(run.passes.map((p) => p.wouldWrite)).toEqual([["s1"], ["s1"]]);
      expect(db.tables.funnel_monday_writes).toEqual([]);
    }
    expect(monday.reads).toBe(0);
  });

  it("not configured: reads nothing and claims nothing", async () => {
    const db = harness([sessionRow()], [], { failSelect: { funnel_sessions: { message: "should not be read" } } });
    const run = await runFunnelMondayPasses(db.admin, { now: NOW, env: {} });
    expect(run.ok).toBe(true);
    expect(run.passes.every((p) => !p.configured && p.due === 0)).toBe(true);
    expect(db.tables.funnel_monday_writes).toEqual([]);
  });

  it("an unreadable session table is a failed run, not a quiet one", async () => {
    const db = harness([sessionRow()], [], { failSelect: { funnel_sessions: { message: "timeout" } } });
    const run = await runFunnelMondayPasses(db.admin, { now: NOW, env: ENV });
    expect(run.ok).toBe(false);
    expect(run.passes[0].error).toBe("sessions_unreadable");
  });

  it("stops starting writes when the budget is spent", async () => {
    const db = harness();
    const run = await runFunnelMondayPasses(db.admin, { now: NOW, env: ENV, budgetMs: -1 });
    expect(run.passes.every((p) => p.truncated && p.attempted === 0)).toBe(true);
    expect(monday.writes).toEqual([]);
  });

  it("writes at most 25 per transition per run", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => sessionRow({ id: `s${i}`, monday_item_id: `item${i}` }));
    for (let i = 0; i < 30; i++) monday.items.set(`item${i}`, { boardId: BOARD, statusLabel: "" });
    const db = harness(rows);
    const run = await runFunnelMondayPasses(db.admin, { now: NOW, env: ENV });
    expect(run.passes[0].written).toBe(25);
  });
});

describe("pushSignupSource (E4)", () => {
  function customerDb(customer: Record<string, unknown>, sessions: Record<string, unknown>[] = [], opts = {}) {
    return fakeDb({ customers: [{ id: "c1", monday_item_id: "item1", ...customer }], funnel_sessions: sessions }, opts);
  }

  it("a call sign-up is written 'Call', without reading any session", async () => {
    const db = customerDb({ signup_source: "call" }, [], { failSelect: { funnel_sessions: { message: "not read" } } });
    expect(await pushSignupSource(db.admin, "c1", { env: ENV })).toEqual({ written: true, route: "call" });
    expect(monday.signupWrites).toEqual([{ itemId: "item1", columnId: "color_signup", label: "Call" }]);
  });

  it("a funnel sign-up is 'Funnel', unless the paid session came from the post-call recap", async () => {
    const funnel = customerDb({ signup_source: "funnel" }, [{ customer_id: "c1", step: "paid", entry_point: "instant" }]);
    expect((await pushSignupSource(funnel.admin, "c1", { env: ENV })).route).toBe("funnel");
    monday.items.get("item1")!.signup = undefined;
    const recap = customerDb({ signup_source: "funnel" }, [{ customer_id: "c1", step: "paid", entry_point: "post_call" }]);
    expect((await pushSignupSource(recap.admin, "c1", { env: ENV })).route).toBe("call");
    expect(monday.signupWrites.map((w) => w.label)).toEqual(["Funnel", "Call"]);
  });

  it("an unreadable session refuses to write rather than guess", async () => {
    const db = customerDb({ signup_source: "funnel" }, [], { failSelect: { funnel_sessions: { message: "timeout" } } });
    const r = await pushSignupSource(db.admin, "c1", { env: ENV });
    expect(r.written).toBe(false);
    expect(r.error).toContain("session read");
    expect(monday.signupWrites).toEqual([]);
  });

  it("skips when not configured, or with no board item", async () => {
    expect(await pushSignupSource(customerDb({ signup_source: "call" }).admin, "c1", { env: {} })).toEqual({
      written: false,
      skipped: "not_configured",
    });
    expect(
      await pushSignupSource(customerDb({ signup_source: "call", monday_item_id: null }).admin, "c1", { env: ENV })
    ).toEqual({ written: false, skipped: "no_item" });
    expect(monday.signupWrites).toEqual([]);
  });

  it("passes on the writer's 'unchanged' and 'not_status_board'", async () => {
    monday.items.get("item1")!.signup = "Call";
    expect(await pushSignupSource(customerDb({ signup_source: "call" }).admin, "c1", { env: ENV })).toEqual({
      written: false,
      route: "call",
      skipped: "unchanged",
    });
    monday.items.set("item1", { boardId: "18420913271", statusLabel: "" });
    expect((await pushSignupSource(customerDb({ signup_source: "call" }).admin, "c1", { env: ENV })).skipped).toBe(
      "not_status_board"
    );
  });

  it("never throws", async () => {
    const admin = { from: () => { throw new Error("boom"); } } as unknown as Parameters<typeof pushSignupSource>[0];
    const r = await pushSignupSource(admin, "c1", { env: ENV });
    expect(r.written).toBe(false);
    expect(r.error).toContain("boom");
  });
});
