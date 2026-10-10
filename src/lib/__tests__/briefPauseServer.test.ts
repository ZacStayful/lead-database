import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The server half of a Lead Brief customer's pause (batch 04 Phase 2), driven
 * against an in-memory client. The SQL half (write_pending_lead_brief's lock,
 * claim and C9 replacement) is pinned by supabase/tests/0168_*; here the fake
 * RPC applies the same rules so the decisions around it can be tested.
 */

const emails = vi.hoisted(() => ({
  sendBriefAreaUpdatedEmail: vi.fn(async () => ({ id: "e1", error: null })),
  sendBriefPauseConfirmationEmail: vi.fn(async () => ({ id: "e2", error: null })),
  sendPauseEndingSoonEmail: vi.fn(async () => ({ id: "e3", error: null })),
}));
vi.mock("@/lib/emails", () => emails);

const stripe = vi.hoisted(() => ({ update: vi.fn(async () => ({})) }));
vi.mock("@/lib/stripe", () => ({ getStripe: () => ({ subscriptions: { update: stripe.update } }) }));

vi.mock("@/lib/mondayStatus", () => ({ syncCustomerMondayStatus: vi.fn(async () => ({})) }));

const compute = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@/lib/leadBrief/briefServer", () => ({ computeBriefForCustomer: compute.fn }));

import {
  pauseBriefCustomer,
  recalibrateLongPause,
  settleLongPauseReturn,
  type BriefPauseCustomer,
} from "@/lib/briefPauseServer";

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

/** A small in-memory PostgREST: enough of the builder for these modules. */
function fakeAdmin(tables: Tables, opts: { failInsert?: string[]; failUpdate?: string[] } = {}) {
  let seq = 0;
  const rpcCalls: { name: string; args: Row }[] = [];
  function from(table: string) {
    const filters: ((r: Row) => boolean)[] = [];
    let op: "select" | "update" | "insert" | "delete" = "select";
    let patch: Row = {};
    let order: { col: string; asc: boolean } | null = null;
    let limitN: number | null = null;
    const rows = () => (tables[table] ??= []);
    const run = (): { data: Row[] | null; error: { message: string; code?: string } | null } => {
      if (op === "insert") {
        if (opts.failInsert?.includes(table)) return { data: null, error: { message: "insert failed" } };
        const row = { id: `${table}-${++seq}`, ...patch };
        rows().push(row);
        return { data: [row], error: null };
      }
      let matched = rows().filter((r) => filters.every((f) => f(r)));
      if (order) {
        const { col, asc } = order;
        matched = [...matched].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1));
      }
      if (limitN !== null) matched = matched.slice(0, limitN);
      if (op === "update") {
        if (opts.failUpdate?.includes(table)) return { data: null, error: { message: "update failed" } };
        for (const r of matched) Object.assign(r, patch);
      }
      if (op === "delete") tables[table] = rows().filter((r) => !matched.includes(r));
      return { data: matched, error: null };
    };
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), chain),
      neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), chain),
      is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), chain),
      in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), chain),
      order: (col: string, o?: { ascending?: boolean }) => ((order = { col, asc: o?.ascending !== false }), chain),
      limit: (n: number) => ((limitN = n), chain),
      update: (p: Row) => ((op = "update"), (patch = p), chain),
      insert: (p: Row) => ((op = "insert"), (patch = p), chain),
      delete: () => ((op = "delete"), chain),
      maybeSingle: async () => {
        const r = run();
        return { data: r.data?.[0] ?? null, error: r.error };
      },
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(run()).then(resolve, reject),
    };
    return chain;
  }
  async function rpc(name: string, args: Row) {
    rpcCalls.push({ name, args });
    if (name !== "write_pending_lead_brief") return { data: null, error: { message: "unknown rpc" } };
    const briefs = (tables.customer_lead_briefs ??= []);
    const active = briefs.find((b) => b.customer_id === args.p_customer_id && b.status === "active");
    if (!active || active.id !== args.p_expected_active_id) return { data: { result: "conflict" }, error: null };
    const scheduled = briefs.find((b) => b.customer_id === args.p_customer_id && b.status === "scheduled");
    if (args.p_basis_id !== (scheduled?.id ?? active.id)) return { data: { result: "conflict" }, error: null };
    const ep = (tables.subscription_pauses ?? []).find(
      (p) => p.id === args.p_pause_id && p.hold_area === false && !p.recalibrated_at
    );
    if (!ep) return { data: { result: "not_claimable" }, error: null };
    ep.recalibrated_at = "now";
    tables.customer_lead_briefs = briefs.filter((b) => !(b.customer_id === args.p_customer_id && b.status === "scheduled"));
    const id = `pending-${++seq}`;
    tables.customer_lead_briefs.push({
      id,
      customer_id: args.p_customer_id,
      status: "pending_confirmation",
      effective_at: args.p_effective_at,
    });
    ep.pending_brief_id = id;
    return { data: { result: "written", id }, error: null };
  }
  return { admin: { from, rpc } as unknown as SupabaseClient, rpcCalls, tables };
}

const NOW = new Date("2026-12-03T08:00:00Z");
const CUSTOMER = {
  id: "c1",
  email: "lin@x.com",
  contact_name: "Lin Long",
  phone: "+447700900123",
  monthly_allocation: 20,
  pending_monthly_allocation: null,
};

function activeBrief(over: Row = {}): Row {
  return {
    id: "active-1",
    customer_id: "c1",
    status: "active",
    base_postcode: "HG2",
    priority_outcodes: [],
    travel_limit_miles: null,
    min_bedrooms: null,
    min_gross: null,
    similar_areas: [],
    priorities: [{ key: "location" }],
    allocation: 20,
    service_radius_miles: 20,
    service_outcodes: ["HG2", "HG1"],
    ...over,
  };
}

function episode(over: Row = {}): Row {
  return {
    id: "ep-1",
    customer_id: "c1",
    paused_at: "2026-10-10T09:00:00Z",
    resumes_at: "2026-12-10T00:00:00.000Z",
    hold_area: false,
    recalibrated_at: null,
    pending_brief_id: null,
    ended_at: null,
    ...over,
  };
}

function preview(radius: number, outcodes: string[]) {
  return {
    ok: true,
    preview: {
      plan: 20,
      brief: {
        basePostcode: "HG2",
        baseOutcode: "HG2",
        operatingMode: "anywhere",
        travelLimitMiles: null,
        essentials: [],
        minBedrooms: null,
        minGross: null,
        priorityOutcodes: [],
        similarAreas: [],
      },
      priorities: [{ key: "location", threshold: null }],
      serviceRadiusMiles: radius,
      serviceOutcodes: outcodes,
      firstPickOutcodes: [],
      paceOutcodes: [],
      mixLeansNearby: false,
      expectedMix: {},
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  compute.fn.mockReset();
});

describe("recalibrateLongPause", () => {
  it("an unchanged area stamps the episode and writes no version", async () => {
    const { admin, rpcCalls, tables } = fakeAdmin({
      customer_lead_briefs: [activeBrief()],
      subscription_pauses: [episode()],
    });
    compute.fn.mockResolvedValue(preview(20, ["HG1", "HG2"]));
    const r = await recalibrateLongPause(admin, CUSTOMER, episode() as never, {
      effectiveAtIso: "2026-12-10T00:00:00.000Z",
      now: NOW,
    });
    expect(r).toEqual({ kind: "unchanged" });
    expect(rpcCalls).toHaveLength(0);
    expect(tables.subscription_pauses[0].recalibrated_at).toBe(NOW.toISOString());
  });

  it("a changed area is written as pending, effective on the return date", async () => {
    const { admin, rpcCalls, tables } = fakeAdmin({
      customer_lead_briefs: [activeBrief()],
      subscription_pauses: [episode()],
    });
    compute.fn.mockResolvedValue(preview(30, ["HG2", "HG1", "LS1"]));
    const r = await recalibrateLongPause(admin, CUSTOMER, episode() as never, {
      effectiveAtIso: "2026-12-10T00:00:00.000Z",
      now: NOW,
    });
    expect(r).toMatchObject({ kind: "written", radiusMiles: 30, previousRadiusMiles: 20, basePostcode: "HG2" });
    expect(rpcCalls[0].args).toMatchObject({
      p_customer_id: "c1",
      p_expected_active_id: "active-1",
      p_basis_id: "active-1",
      p_pause_id: "ep-1",
      p_effective_at: "2026-12-10T00:00:00.000Z",
    });
    expect(tables.customer_lead_briefs.map((b) => b.status)).toEqual(["active", "pending_confirmation"]);
  });

  it("C9: computes from the customer's scheduled change, and that counts as a change", async () => {
    const { admin, rpcCalls } = fakeAdmin({
      customer_lead_briefs: [
        activeBrief(),
        activeBrief({ id: "sched-1", status: "scheduled", similar_areas: ["LS"], service_radius_miles: 20 }),
      ],
      subscription_pauses: [episode()],
    });
    // The same radius and outcodes as the active brief: still a change, because
    // the answers moved.
    compute.fn.mockResolvedValue(preview(20, ["HG2", "HG1"]));
    const r = await recalibrateLongPause(admin, CUSTOMER, episode() as never, {
      effectiveAtIso: "2026-12-10T00:00:00.000Z",
      now: NOW,
    });
    expect(r.kind).toBe("written");
    expect(rpcCalls[0].args.p_basis_id).toBe("sched-1");
    const input = compute.fn.mock.calls[0][2].input;
    expect(input.similarAreas).toEqual(["LS"]);
    expect(compute.fn.mock.calls[0][3]).toEqual({ autoTickRecommended: false });
  });

  it("an unreadable supply is a retry, never an empty area", async () => {
    const { BriefSupplyUnavailableError } = await import("@/lib/leadBrief/supply");
    const { admin, rpcCalls } = fakeAdmin({
      customer_lead_briefs: [activeBrief()],
      subscription_pauses: [episode()],
    });
    compute.fn.mockRejectedValue(new BriefSupplyUnavailableError("down"));
    const r = await recalibrateLongPause(admin, CUSTOMER, episode() as never, {
      effectiveAtIso: "2026-12-10T00:00:00.000Z",
      now: NOW,
    });
    expect(r.kind).toBe("retry");
    expect(rpcCalls).toHaveLength(0);
  });

  it("no active brief is reported, not invented", async () => {
    const { admin } = fakeAdmin({ customer_lead_briefs: [], subscription_pauses: [episode()] });
    const r = await recalibrateLongPause(admin, CUSTOMER, episode() as never, {
      effectiveAtIso: "2026-12-10T00:00:00.000Z",
      now: NOW,
    });
    expect(r).toEqual({ kind: "no_brief" });
    expect(compute.fn).not.toHaveBeenCalled();
  });
});

describe("settleLongPauseReturn", () => {
  it("C4: a pending version awaiting confirmation holds them", async () => {
    const { admin } = fakeAdmin({
      subscription_pauses: [episode({ recalibrated_at: "x", pending_brief_id: "p1" })],
      customer_lead_briefs: [activeBrief(), { id: "p1", customer_id: "c1", status: "pending_confirmation" }],
    });
    expect(await settleLongPauseReturn(admin, CUSTOMER, { now: NOW, source: "t" })).toEqual({ action: "hold" });
    expect(compute.fn).not.toHaveBeenCalled();
  });

  it("a confirmed or superseded version, or an unchanged area, restarts them", async () => {
    for (const status of ["active", "superseded"]) {
      const { admin } = fakeAdmin({
        subscription_pauses: [episode({ recalibrated_at: "x", pending_brief_id: "p1" })],
        customer_lead_briefs: [{ id: "p1", customer_id: "c1", status }],
      });
      expect(await settleLongPauseReturn(admin, CUSTOMER, { now: NOW, source: "t" })).toEqual({ action: "resume" });
    }
    const { admin } = fakeAdmin({ subscription_pauses: [episode({ recalibrated_at: "x" })] });
    expect(await settleLongPauseReturn(admin, CUSTOMER, { now: NOW, source: "t" })).toEqual({ action: "resume" });
  });

  it("not recalculated yet: recalculates, and a changed area holds them and tells them", async () => {
    const { admin, tables } = fakeAdmin({
      customer_lead_briefs: [activeBrief()],
      subscription_pauses: [episode()],
    });
    compute.fn.mockResolvedValue(preview(30, ["HG2", "LS1"]));
    const late = new Date("2026-12-11T08:00:00Z");
    expect(await settleLongPauseReturn(admin, CUSTOMER, { now: late, source: "t" })).toEqual({ action: "hold" });
    expect(emails.sendBriefAreaUpdatedEmail).toHaveBeenCalledWith({
      to: "lin@x.com",
      contactName: "Lin Long",
      restartDate: "2026-12-11",
    });
    expect(tables.n8n_events).toHaveLength(1);
    expect(tables.n8n_events[0]).toMatchObject({
      event_type: "brief_area_updated",
      customer_id: "c1",
      subject_id: "ep-1",
      payload: { first_name: "Lin", phone: "+447700900123", return_date: "2026-12-11", radius_miles: 30, previous_radius_miles: 20 },
    });
    // After the return date the pending version is effective from it.
    expect(tables.customer_lead_briefs.find((b) => b.status === "pending_confirmation")!.effective_at).toBe(
      "2026-12-10T00:00:00.000Z"
    );
  });

  it("ending a long pause EARLY: effective from now", async () => {
    const { admin, tables } = fakeAdmin({
      customer_lead_briefs: [activeBrief()],
      subscription_pauses: [episode()],
    });
    compute.fn.mockResolvedValue(preview(30, ["HG2", "LS1"]));
    const early = new Date("2026-11-01T10:00:00Z");
    expect(await settleLongPauseReturn(admin, CUSTOMER, { now: early, source: "t" })).toEqual({ action: "hold" });
    expect(tables.customer_lead_briefs.find((b) => b.status === "pending_confirmation")!.effective_at).toBe(
      early.toISOString()
    );
  });

  it("fails CLOSED while the area cannot be checked: they stay paused", async () => {
    const { BriefSupplyUnavailableError } = await import("@/lib/leadBrief/supply");
    const { admin } = fakeAdmin({ customer_lead_briefs: [activeBrief()], subscription_pauses: [episode()] });
    compute.fn.mockRejectedValue(new BriefSupplyUnavailableError("down"));
    expect((await settleLongPauseReturn(admin, CUSTOMER, { now: NOW, source: "t" })).action).toBe("retry");
  });

  it("fails OPEN where holding would never end: no episode, or the engine refuses the brief", async () => {
    const none = fakeAdmin({ subscription_pauses: [] });
    expect(await settleLongPauseReturn(none.admin, CUSTOMER, { now: NOW, source: "t" })).toEqual({
      action: "resume",
      note: "no_episode",
    });
    const refused = fakeAdmin({ customer_lead_briefs: [activeBrief()], subscription_pauses: [episode()] });
    compute.fn.mockResolvedValue({ ok: false, issues: [{ code: "postcode_unknown" }] });
    expect(await settleLongPauseReturn(refused.admin, CUSTOMER, { now: NOW, source: "t" })).toEqual({
      action: "resume",
      note: "invalid",
    });
  });

  it("an ordinary or short pause episode is never treated as long", async () => {
    const { admin } = fakeAdmin({ subscription_pauses: [episode({ hold_area: true })] });
    expect(await settleLongPauseReturn(admin, CUSTOMER, { now: NOW, source: "t" })).toEqual({
      action: "resume",
      note: "no_episode",
    });
  });
});

describe("pauseBriefCustomer", () => {
  const BRIEF_CUSTOMER: BriefPauseCustomer = {
    id: "c1",
    email: "lin@x.com",
    contact_name: "Lin Long",
    account_status: "active",
    subscription_status: "active",
    gr_subscription_status: "inactive",
    stripe_subscription_id: "sub_1",
    paused_at: null,
    pause_count: 0,
    lead_brief_required: true,
    lead_brief_completed_at: "2026-10-01T00:00:00Z",
  };
  const PAUSE_NOW = new Date("2026-10-10T09:00:00Z");
  const input = (returnDate: string) => ({ returnDate, reasons: ["seasonal"], note: null });

  it("a 4-week pause keeps the area, and records the episode with no month count", async () => {
    const { admin, tables } = fakeAdmin({ customers: [{ ...BRIEF_CUSTOMER }] });
    const r = await pauseBriefCustomer(admin, BRIEF_CUSTOMER, input("2026-11-07"), { now: PAUSE_NOW, source: "t" });
    expect(r).toMatchObject({ ok: true, holdArea: true, resumesAtIso: "2026-11-07T00:00:00.000Z" });
    expect(tables.customers[0]).toMatchObject({
      paused_at: PAUSE_NOW.toISOString(),
      pause_resumes_at: "2026-11-07T00:00:00.000Z",
      pause_holds_area: true,
      pause_count: 1,
    });
    expect(tables.subscription_pauses[0]).toMatchObject({ months: null, hold_area: true, reasons: ["seasonal"] });
    expect(stripe.update).toHaveBeenCalledWith("sub_1", { pause_collection: { behavior: "void" } });
    expect(emails.sendBriefPauseConfirmationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ restartDate: "2026-11-07", holdArea: true })
    );
  });

  it("a longer pause releases it", async () => {
    const { admin, tables } = fakeAdmin({ customers: [{ ...BRIEF_CUSTOMER }] });
    const r = await pauseBriefCustomer(admin, BRIEF_CUSTOMER, input("2026-12-10"), { now: PAUSE_NOW, source: "t" });
    expect(r).toMatchObject({ ok: true, holdArea: false });
    expect(tables.customers[0].pause_holds_area).toBe(false);
  });

  it("⚠️ the episode is written BEFORE Stripe, and a failed insert pauses nothing", async () => {
    const { admin, tables } = fakeAdmin({ customers: [{ ...BRIEF_CUSTOMER }] }, { failInsert: ["subscription_pauses"] });
    const r = await pauseBriefCustomer(admin, BRIEF_CUSTOMER, input("2026-12-10"), { now: PAUSE_NOW, source: "t" });
    expect(r).toMatchObject({ ok: false, status: 500 });
    expect(stripe.update).not.toHaveBeenCalled();
    expect(tables.customers[0]).toMatchObject({ paused_at: null, pause_holds_area: null, pause_count: 0 });
  });

  it("a Stripe failure rolls back the pause and deletes the episode", async () => {
    stripe.update.mockRejectedValueOnce(new Error("stripe down"));
    const { admin, tables } = fakeAdmin({ customers: [{ ...BRIEF_CUSTOMER }] });
    const r = await pauseBriefCustomer(admin, BRIEF_CUSTOMER, input("2026-12-10"), { now: PAUSE_NOW, source: "t" });
    expect(r).toMatchObject({ ok: false, status: 502 });
    expect(tables.customers[0]).toMatchObject({ paused_at: null, pause_holds_area: null });
    expect(tables.subscription_pauses).toEqual([]);
    expect(emails.sendBriefPauseConfirmationEmail).not.toHaveBeenCalled();
  });

  it("refuses a customer without a confirmed brief, a bad date, no reason, or an existing pause", async () => {
    const { admin } = fakeAdmin({ customers: [{ ...BRIEF_CUSTOMER }] });
    const go = (c: BriefPauseCustomer, i: ReturnType<typeof input>) =>
      pauseBriefCustomer(admin, c, i, { now: PAUSE_NOW, source: "t" });
    expect(await go({ ...BRIEF_CUSTOMER, lead_brief_completed_at: null }, input("2026-11-07"))).toMatchObject({
      ok: false,
      code: "not_brief_customer",
    });
    expect(await go(BRIEF_CUSTOMER, input("2027-01-11"))).toMatchObject({ ok: false, code: "return_date_too_late" });
    expect(await go(BRIEF_CUSTOMER, { returnDate: "2026-11-07", reasons: [], note: null })).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(await go({ ...BRIEF_CUSTOMER, paused_at: "x" }, input("2026-11-07"))).toMatchObject({ ok: false, status: 409 });
    expect(await go({ ...BRIEF_CUSTOMER, stripe_subscription_id: null }, input("2026-11-07"))).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(stripe.update).not.toHaveBeenCalled();
  });
});
