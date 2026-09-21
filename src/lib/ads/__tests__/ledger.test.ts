import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DRAFT_CAP_PER_DAY,
  draftCapReached,
  draftsStartedToday,
  recordGenerations,
  type LedgerEntry,
} from "../ledger";

const entry = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  kind: "copy",
  outcome: "ok",
  attempt: 1,
  modelId: "claude-opus-5",
  promptVersion: "ad_copy_v1",
  rejectReason: null,
  cacheReadTokens: null,
  ...over,
});

/** Records every filter it is given, so a missing `.eq` is visible. */
function fakeSelect(result: { count?: number | null; error?: { message: string } | null }) {
  const filters: Array<[string, string]> = [];
  const builder: Record<string, unknown> = {
    eq: (col: string, val: string) => {
      filters.push(["eq", `${col}=${val}`]);
      return builder;
    },
    gte: (col: string, val: string) => {
      filters.push(["gte", `${col}=${val}`]);
      return builder;
    },
    then: (res: (v: unknown) => unknown) =>
      Promise.resolve({ count: result.count ?? null, error: result.error ?? null }).then(res),
  };
  const client = {
    from: () => ({ select: () => builder }),
  } as unknown as SupabaseClient;
  return { client, filters };
}

function fakeInsert(error: { message: string } | null = null) {
  const rows: Record<string, unknown>[] = [];
  const client = {
    from: () => ({
      insert: (r: Record<string, unknown>[]) => {
        rows.push(...r);
        return Promise.resolve({ error });
      },
    }),
  } as unknown as SupabaseClient;
  return { client, rows };
}

describe("recording a generation", () => {
  it("writes one row per entry, with the draft it was spent on", async () => {
    const { client, rows } = fakeInsert();
    await recordGenerations(client, {
      customerId: "cust",
      draftId: "draft",
      entries: [entry({ kind: "questions" }), entry({ outcome: "rejected", rejectReason: "income_claim", attempt: 2 })],
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ customer_id: "cust", draft_id: "draft", kind: "questions" });
    expect(rows[1]).toMatchObject({ outcome: "rejected", reject_reason: "income_claim", attempt: 2 });
  });

  it("does nothing at all when there is nothing to record", async () => {
    const { client, rows } = fakeInsert();
    await recordGenerations(client, { customerId: "c", draftId: null, entries: [] });
    expect(rows).toHaveLength(0);
  });

  /**
   * ⚠️ A LOST LEDGER ROW IS A REPORTING GAP; A FAILED ADVERT IS THE OPERATOR'S
   * AFTERNOON. Same discipline `subscription_plan_changes` states for its own
   * audit trail — live state is elsewhere and the history is best-effort.
   */
  it("never throws when the insert fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = fakeInsert({ message: "boom" });
    await expect(
      recordGenerations(client, { customerId: "c", draftId: null, entries: [entry()] })
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  /** `attempt` is CHECKed between 1 and 5; a 23514 here would lose the row. */
  it.each([
    [0, 1],
    [1, 1],
    [5, 5],
    [99, 5],
    [Number.NaN, 1],
  ])("clamps attempt %s to %s rather than losing the row", async (given, expected) => {
    const { client, rows } = fakeInsert();
    await recordGenerations(client, { customerId: "c", draftId: null, entries: [entry({ attempt: given })] });
    expect(rows[0].attempt).toBe(expected);
  });

  it("truncates a reason to the column's bound", async () => {
    const { client, rows } = fakeInsert();
    await recordGenerations(client, {
      customerId: "c",
      draftId: null,
      entries: [entry({ rejectReason: "x".repeat(500) })],
    });
    expect((rows[0].reject_reason as string).length).toBe(200);
  });

  /**
   * ⚠️ ZERO IS A CACHE MISS AND MUST SURVIVE. It is the one reading that would
   * tell us the five-minute window is not being hit, and it is exactly the
   * value a careless falsy check would throw away.
   */
  it.each([
    [0, 0],
    [1800, 1800],
    [1800.6, 1801],
    [-5, 0],
    [Number.NaN, null],
    [null, null],
  ])("stores a cache read of %s as %s", async (given, expected) => {
    const { client, rows } = fakeInsert();
    await recordGenerations(client, {
      customerId: "c",
      draftId: null,
      entries: [entry({ cacheReadTokens: given as number | null })],
    });
    expect(rows[0].cache_read_tokens).toBe(expected);
  });
});

describe("the draft cap", () => {
  /**
   * ⚠️ `kind = 'questions'` ONLY. A draft is started by exactly one questions
   * call, so that is the count of drafts. Counting every row would charge an
   * operator for their own simplifications and for our automatic retry — so
   * somebody who could not follow a question and asked twice would get fewer
   * adverts than somebody who followed it first time, which is backwards.
   */
  it("counts the questions calls for this customer in the last day", async () => {
    const { client, filters } = fakeSelect({ count: 4 });
    const r = await draftsStartedToday(client, "cust-1");
    expect(r).toEqual({ ok: true, count: 4 });
    expect(filters).toContainEqual(["eq", "customer_id=cust-1"]);
    expect(filters).toContainEqual(["eq", "kind=questions"]);
    expect(filters.some(([kind, f]) => kind === "gte" && f.startsWith("created_at="))).toBe(true);
  });

  /**
   * ⚠️ FAILS CLOSED. The whole point of counting an append-only table is that
   * it cannot be reset; reading an error as zero hands out an unbounded number
   * of adverts at the one moment we cannot see how many have gone already.
   */
  it("refuses rather than assuming zero when it cannot read", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = fakeSelect({ error: { message: "gateway timeout" } });
    expect(await draftsStartedToday(client, "c")).toEqual({ ok: false });
    spy.mockRestore();
  });

  it("treats a null count as none", async () => {
    const { client } = fakeSelect({ count: null });
    expect(await draftsStartedToday(client, "c")).toEqual({ ok: true, count: 0 });
  });

  it("is reached at the cap, not past it", () => {
    expect(draftCapReached(DRAFT_CAP_PER_DAY - 1)).toBe(false);
    expect(draftCapReached(DRAFT_CAP_PER_DAY)).toBe(true);
    expect(draftCapReached(DRAFT_CAP_PER_DAY + 1)).toBe(true);
  });
});
