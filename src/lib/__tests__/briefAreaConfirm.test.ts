import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The confirm-on-login screen's server half (batch 04 Phase 3), driven against
 * an in-memory client. The SQL half (confirm_pending_lead_brief's lock, the
 * 72-hour check, the first-pick filter, extend_brief_pause's bounds) is pinned
 * by supabase/tests/0169_*; here the RPCs answer as configured so the
 * decisions around them can be tested.
 */

const emails = vi.hoisted(() => ({
  sendBriefAreaConfirmedEmail: vi.fn(async () => ({ id: "e1", error: null })),
  sendBriefPauseConfirmationEmail: vi.fn(async () => ({ id: "e2", error: null })),
  sendBriefAreaUpdatedEmail: vi.fn(async () => ({ id: "e3", error: null })),
  sendPauseEndingSoonEmail: vi.fn(async () => ({ id: "e4", error: null })),
}));
vi.mock("@/lib/emails", () => emails);

vi.mock("@/lib/stripe", () => ({ getStripe: () => ({ subscriptions: { update: vi.fn() } }) }));
vi.mock("@/lib/mondayStatus", () => ({ syncCustomerMondayStatus: vi.fn(async () => ({})) }));

const resume = vi.hoisted(() => ({ fn: vi.fn(async () => ({ outcome: "resumed" })) }));
vi.mock("@/lib/resumePause", async (orig) => {
  const actual = await orig<typeof import("@/lib/resumePause")>();
  return { ...actual, resumePausedCustomer: resume.fn };
});

const compute = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@/lib/leadBrief/briefServer", () => ({ computeBriefForCustomer: compute.fn }));

import {
  confirmPendingArea,
  extendLongPause,
  lockedUntilFor,
  restartTiming,
  scheduleTighterArea,
  sendAutoAcceptEmail,
  type AreaConfirmCustomer,
} from "@/lib/briefAreaConfirm";
import { needsAreaConfirmation } from "@/lib/leadBrief/gate";
import { areaUpdatedLine } from "@/lib/leadBrief/editCopy";
import { BriefSupplyUnavailableError } from "@/lib/leadBrief/supply";

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;
type RpcAnswer = (args: Row) => { data: unknown; error: { message: string } | null };

function fakeAdmin(tables: Tables, rpcs: Record<string, RpcAnswer> = {}) {
  const rpcCalls: { name: string; args: Row }[] = [];
  function from(table: string) {
    const filters: ((r: Row) => boolean)[] = [];
    let limitN: number | null = null;
    const rows = () => (tables[table] ??= []);
    const run = () => {
      let matched = rows().filter((r) => filters.every((f) => f(r)));
      if (limitN !== null) matched = matched.slice(0, limitN);
      return { data: matched, error: null };
    };
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), chain),
      is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), chain),
      in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), chain),
      order: () => chain,
      limit: (n: number) => ((limitN = n), chain),
      maybeSingle: async () => {
        const r = run();
        return { data: r.data[0] ?? null, error: null };
      },
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(run()).then(resolve, reject),
    };
    return chain;
  }
  async function rpc(name: string, args: Row) {
    rpcCalls.push({ name, args });
    const answer = rpcs[name];
    if (!answer) return { data: null, error: { message: `unexpected rpc ${name}` } };
    return answer(args);
  }
  return { admin: { from, rpc } as unknown as SupabaseClient, rpcCalls };
}

const NOW = new Date("2026-12-03T10:00:00Z");

function customer(over: Partial<AreaConfirmCustomer> = {}): AreaConfirmCustomer {
  return {
    id: "c1",
    email: "lin@x.com",
    contact_name: "Lin Long",
    phone: null,
    stripe_subscription_id: "sub_1",
    is_active: true,
    account_status: "active",
    subscription_status: "active",
    gr_subscription_status: null,
    // A long brief pause by default: the return case.
    paused_at: "2026-10-01T09:00:00Z",
    pause_holds_area: false,
    pause_resumes_at: "2026-12-01T00:00:00.000Z",
    cancel_at_period_end: false,
    monthly_allocation: 20,
    pending_monthly_allocation: null,
    billing_cycle_anchor: "2026-09-15",
    gr_billing_cycle_anchor: null,
    created_at: "2026-06-01T00:00:00Z",
    lead_brief_required: true,
    lead_brief_completed_at: "2026-06-02T00:00:00Z",
    ...over,
  } as AreaConfirmCustomer;
}

function brief(over: Row = {}): Row {
  return {
    id: "active-1",
    version: 1,
    customer_id: "c1",
    status: "active",
    origin: "customer",
    base_postcode: "HG2 7AA",
    base_outcode: "HG2",
    travel_limit_miles: null,
    allocation: 20,
    priorities: [{ key: "location" }],
    essentials: [],
    min_bedrooms: null,
    min_gross: null,
    priority_outcodes: [],
    similar_areas: [],
    service_radius_miles: 20,
    created_at: "2026-06-02T00:00:00Z",
    confirmed_at: "2026-06-02T00:00:00Z",
    locked_until: null,
    effective_at: null,
    ...over,
  };
}

const PENDING = brief({
  id: "pending-1",
  version: 2,
  status: "pending_confirmation",
  origin: "recompute",
  service_radius_miles: 30,
  confirmed_at: null,
  effective_at: "2026-12-01T00:00:00.000Z",
});

function preview(firstPicks: string[], coverage10 = 18) {
  return {
    ok: true,
    preview: {
      plan: 20,
      brief: {
        basePostcode: "HG2 7AA",
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
      serviceRadiusMiles: 30,
      serviceOutcodes: ["HG2", "HG1"],
      firstPickOutcodes: firstPicks,
      paceOutcodes: [],
      mixLeansNearby: false,
      expectedMix: {},
      coverage: [
        { plan: 10, radiusMiles: coverage10, meetsTarget: true },
        { plan: 20, radiusMiles: 30, meetsTarget: true },
      ],
    },
  };
}

const confirmed: RpcAnswer = () => ({ data: { result: "confirmed", id: "pending-1" }, error: null });

beforeEach(() => {
  vi.clearAllMocks();
  compute.fn.mockReset();
  resume.fn.mockResolvedValue({ outcome: "resumed" });
});

describe("restartTiming and the lock date", () => {
  it("a widening never restarts anything (the leads never stopped, C4)", () => {
    const t = restartTiming({ paused_at: null, pause_holds_area: null }, "2026-12-01T00:00:00Z", NOW);
    expect(t).toEqual({ isReturn: false, resumeNow: false, restartYmd: null });
    expect(
      lockedUntilFor({ billing_cycle_anchor: "2026-09-15", gr_billing_cycle_anchor: null, created_at: "2026-06-01T00:00:00Z" }, t, NOW)
    ).toBe("2026-12-15");
  });

  it("a return whose date has come restarts now, and is locked a month from today", () => {
    const t = restartTiming(customer(), "2026-12-01T00:00:00Z", NOW);
    expect(t).toEqual({ isReturn: true, resumeNow: true, restartYmd: "2026-12-03" });
    expect(lockedUntilFor(customer(), t, NOW)).toBe("2027-01-03");
  });

  it("a return confirmed BEFORE its date restarts on that date, as the email told them", () => {
    const early = new Date("2026-11-27T10:00:00Z");
    // Effective at London midnight of 1 December (GMT).
    const t = restartTiming(customer(), "2026-12-01T00:00:00.000Z", early);
    expect(t).toEqual({ isReturn: true, resumeNow: false, restartYmd: "2026-12-01" });
    expect(lockedUntilFor(customer(), t, early)).toBe("2027-01-01");
  });

  it("the return date is read in London time across BST", () => {
    // London midnight of 1 June is 23:00 UTC on 31 May.
    const t = restartTiming(customer(), "2027-05-31T23:00:00.000Z", new Date("2027-05-20T10:00:00Z"));
    expect(t.restartYmd).toBe("2027-06-01");
  });

  it("'Switch to 10 leads' before the date restarts today (C5)", () => {
    const early = new Date("2026-11-27T10:00:00Z");
    expect(restartTiming(customer(), "2026-12-01T00:00:00Z", early, { restartNow: true })).toEqual({
      isReturn: true,
      resumeNow: true,
      restartYmd: "2026-11-27",
    });
  });
});

describe("the gate", () => {
  it("existing customers never see the screen, whatever the read says", () => {
    expect(needsAreaConfirmation(customer({ lead_brief_required: false }), true)).toBe(false);
    expect(needsAreaConfirmation(null, true)).toBe(false);
  });

  it("a brief customer with a pending area does; a failed read does not gate (fails open)", () => {
    expect(needsAreaConfirmation(customer(), true)).toBe(true);
    expect(needsAreaConfirmation(customer(), false)).toBe(false);
    expect(needsAreaConfirmation(customer(), null)).toBe(false);
  });

  it("a GR-only customer is never gated (invariant 6)", () => {
    expect(
      needsAreaConfirmation(
        customer({ account_status: "waitlisted", subscription_status: "inactive", gr_subscription_status: "active" }),
        true
      )
    ).toBe(false);
  });
});

describe("confirmPendingArea", () => {
  it("a due return: recomputed first picks, the lock date, auto false, then the restart", async () => {
    const { admin, rpcCalls } = fakeAdmin(
      { customer_lead_briefs: [brief(), PENDING] },
      { confirm_pending_lead_brief: confirmed }
    );
    compute.fn.mockResolvedValue(preview(["HG3", "HG4"]));
    const r = await confirmPendingArea(admin, customer(), {
      expectedPendingId: "pending-1",
      auto: false,
      now: NOW,
      source: "t",
    });
    expect(r).toMatchObject({ kind: "confirmed", isReturn: true, resume: "resumed", restartYmd: "2026-12-03" });
    expect(rpcCalls[0]).toEqual({
      name: "confirm_pending_lead_brief",
      args: {
        p_customer_id: "c1",
        p_expected_active_id: "active-1",
        p_pending_id: "pending-1",
        p_first_picks: ["HG3", "HG4"],
        p_locked_until: "2027-01-03",
        p_auto: false,
      },
    });
    expect(resume.fn).toHaveBeenCalledTimes(1);
  });

  it("first picks are recomputed from the PENDING version's answers", async () => {
    const { admin } = fakeAdmin(
      {
        customer_lead_briefs: [
          brief(),
          { ...PENDING, base_postcode: "LS6 1AA", priority_outcodes: ["LS7"], similar_areas: ["BD"] },
        ],
      },
      { confirm_pending_lead_brief: confirmed }
    );
    compute.fn.mockResolvedValue(preview([]));
    await confirmPendingArea(admin, customer(), { expectedPendingId: "pending-1", auto: false, now: NOW, source: "t" });
    const parsed = compute.fn.mock.calls[0][2];
    expect(parsed.input).toMatchObject({ basePostcode: "LS6 1AA", priorityOutcodes: ["LS7"], similarAreas: ["BD"] });
  });

  it("supply unreadable: the stored first picks are kept (null), never an empty list", async () => {
    const { admin, rpcCalls } = fakeAdmin(
      { customer_lead_briefs: [brief(), PENDING] },
      { confirm_pending_lead_brief: confirmed }
    );
    compute.fn.mockRejectedValue(new BriefSupplyUnavailableError("down"));
    const r = await confirmPendingArea(admin, customer(), {
      expectedPendingId: "pending-1",
      auto: false,
      now: NOW,
      source: "t",
    });
    expect(r.kind).toBe("confirmed");
    expect(rpcCalls[0].args.p_first_picks).toBeNull();
  });

  it("before the return date: confirmed, NOT restarted", async () => {
    const { admin } = fakeAdmin({ customer_lead_briefs: [brief(), PENDING] }, { confirm_pending_lead_brief: confirmed });
    compute.fn.mockResolvedValue(preview([]));
    const r = await confirmPendingArea(admin, customer(), {
      expectedPendingId: "pending-1",
      auto: false,
      now: new Date("2026-11-28T10:00:00Z"),
      source: "t",
    });
    expect(r).toMatchObject({ kind: "confirmed", resume: null, restartYmd: "2026-12-01" });
    expect(resume.fn).not.toHaveBeenCalled();
  });

  it("before the return date with forSwitch: restarted today (C5)", async () => {
    const { admin } = fakeAdmin({ customer_lead_briefs: [brief(), PENDING] }, { confirm_pending_lead_brief: confirmed });
    compute.fn.mockResolvedValue(preview([]));
    const r = await confirmPendingArea(admin, customer(), {
      expectedPendingId: "pending-1",
      auto: false,
      now: new Date("2026-11-28T10:00:00Z"),
      source: "t",
      restartNow: true,
    });
    expect(r).toMatchObject({ kind: "confirmed", resume: "resumed", restartYmd: "2026-11-28" });
  });

  it("a widening: confirmed, nothing resumed", async () => {
    const { admin } = fakeAdmin({ customer_lead_briefs: [brief(), PENDING] }, { confirm_pending_lead_brief: confirmed });
    compute.fn.mockResolvedValue(preview([]));
    const r = await confirmPendingArea(admin, customer({ paused_at: null, pause_holds_area: null }), {
      expectedPendingId: "pending-1",
      auto: false,
      now: NOW,
      source: "t",
    });
    expect(r).toMatchObject({ kind: "confirmed", isReturn: false, resume: null });
    expect(resume.fn).not.toHaveBeenCalled();
  });

  it("a pending cancellation: the area is confirmed, the leads are NOT restarted", async () => {
    const { admin } = fakeAdmin({ customer_lead_briefs: [brief(), PENDING] }, { confirm_pending_lead_brief: confirmed });
    compute.fn.mockResolvedValue(preview([]));
    const r = await confirmPendingArea(admin, customer({ cancel_at_period_end: true }), {
      expectedPendingId: "pending-1",
      auto: true,
      now: NOW,
      source: "t",
    });
    expect(r).toMatchObject({ kind: "confirmed", resume: "refused" });
    expect(resume.fn).not.toHaveBeenCalled();
  });

  it("a stale screen (a different pending version) is a conflict and writes nothing", async () => {
    const { admin, rpcCalls } = fakeAdmin({ customer_lead_briefs: [brief(), PENDING] });
    const r = await confirmPendingArea(admin, customer(), {
      expectedPendingId: "pending-OLD",
      auto: false,
      now: NOW,
      source: "t",
    });
    expect(r).toEqual({ kind: "conflict" });
    expect(rpcCalls).toHaveLength(0);
  });

  it("nothing pending any more", async () => {
    const { admin } = fakeAdmin({ customer_lead_briefs: [brief()] });
    expect(
      await confirmPendingArea(admin, customer(), { expectedPendingId: "pending-1", auto: false, now: NOW, source: "t" })
    ).toEqual({ kind: "not_pending" });
  });

  it("an existing (non-brief) customer is refused before anything is read", async () => {
    const { admin, rpcCalls } = fakeAdmin({ customer_lead_briefs: [brief(), PENDING] });
    expect(
      await confirmPendingArea(admin, customer({ lead_brief_required: false }), {
        expectedPendingId: "pending-1",
        auto: false,
        now: NOW,
        source: "t",
      })
    ).toEqual({ kind: "not_brief_customer" });
    expect(rpcCalls).toHaveLength(0);
  });

  it("the auto-accept passes p_auto true, and the RPC's not_due is reported", async () => {
    const { admin, rpcCalls } = fakeAdmin(
      { customer_lead_briefs: [brief(), PENDING] },
      { confirm_pending_lead_brief: () => ({ data: { result: "not_due" }, error: null }) }
    );
    compute.fn.mockResolvedValue(preview([]));
    const r = await confirmPendingArea(admin, customer(), {
      expectedPendingId: "pending-1",
      auto: true,
      now: NOW,
      source: "t",
    });
    expect(r).toEqual({ kind: "not_due" });
    expect(rpcCalls[0].args.p_auto).toBe(true);
    expect(resume.fn).not.toHaveBeenCalled();
  });
});

describe("the auto-accept email", () => {
  const base = { kind: "confirmed" as const, restartYmd: null, radiusMiles: 30, basePostcode: "HG2 7AA" };

  it("a return that restarted: the batch's sentence", async () => {
    expect(await sendAutoAcceptEmail(customer(), { ...base, isReturn: true, resume: "resumed" }, "t")).toBe(true);
    expect(emails.sendBriefAreaConfirmedEmail).toHaveBeenCalledWith({
      to: "lin@x.com",
      contactName: "Lin Long",
      radiusMiles: 30,
      basePostcode: "HG2 7AA",
      restarted: true,
    });
  });

  it("a return that did NOT restart gets no 'your leads have restarted' email", async () => {
    for (const resumeOutcome of ["refused", "stripe_failed", "db_failed", null] as const) {
      expect(await sendAutoAcceptEmail(customer(), { ...base, isReturn: true, resume: resumeOutcome }, "t")).toBe(false);
    }
    expect(emails.sendBriefAreaConfirmedEmail).not.toHaveBeenCalled();
  });

  it("a widening is told its area moved, not that leads restarted", async () => {
    await sendAutoAcceptEmail(customer(), { ...base, isReturn: false, resume: null }, "t");
    expect(emails.sendBriefAreaConfirmedEmail).toHaveBeenCalledWith(expect.objectContaining({ restarted: false }));
  });
});

describe("extendLongPause", () => {
  const episode = {
    id: "ep-1",
    customer_id: "c1",
    paused_at: "2026-10-01T09:00:00Z",
    resumes_at: "2026-12-01T00:00:00.000Z",
    hold_area: false,
    recalibrated_at: "2026-11-24T08:00:00Z",
    pending_brief_id: "pending-1",
    ended_at: null,
  };

  it("sends London midnight of the date and emails the new date", async () => {
    const { admin, rpcCalls } = fakeAdmin(
      { subscription_pauses: [episode] },
      { extend_brief_pause: () => ({ data: { result: "extended" }, error: null }) }
    );
    expect(await extendLongPause(admin, customer(), "2026-12-20", { source: "t" })).toEqual({
      ok: true,
      returnYmd: "2026-12-20",
    });
    expect(rpcCalls[0].args).toEqual({
      p_customer_id: "c1",
      p_pause_id: "ep-1",
      p_resumes_at: "2026-12-20T00:00:00.000Z",
    });
    expect(emails.sendBriefPauseConfirmationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ restartDate: "2026-12-20", holdArea: false })
    );
  });

  it("a refusal is worded, and sends nothing", async () => {
    const { admin } = fakeAdmin(
      { subscription_pauses: [episode] },
      { extend_brief_pause: () => ({ data: { result: "too_late" }, error: null }) }
    );
    const r = await extendLongPause(admin, customer(), "2027-03-20", { source: "t" });
    expect(r).toMatchObject({ ok: false, status: 400, code: "too_late" });
    expect(emails.sendBriefPauseConfirmationEmail).not.toHaveBeenCalled();
  });

  it("not a date, or not on a long pause, never reaches the RPC", async () => {
    const { admin, rpcCalls } = fakeAdmin({ subscription_pauses: [episode] });
    expect(await extendLongPause(admin, customer(), "next week", { source: "t" })).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(
      await extendLongPause(admin, customer({ pause_holds_area: true }), "2026-12-20", { source: "t" })
    ).toMatchObject({ ok: false, status: 409 });
    expect(rpcCalls).toHaveLength(0);
  });
});

describe("scheduleTighterArea", () => {
  it("refuses a customer still on 20 leads", async () => {
    const { admin, rpcCalls } = fakeAdmin({ customer_lead_briefs: [brief()] });
    expect(await scheduleTighterArea(admin, customer(), { now: NOW })).toEqual({ kind: "not_switched" });
    expect(rpcCalls).toHaveLength(0);
  });

  it("after the switch: the 10-lead area is saved as the one scheduled change", async () => {
    const { admin, rpcCalls } = fakeAdmin(
      { customer_lead_briefs: [brief()] },
      { save_scheduled_lead_brief: () => ({ data: { result: "saved", id: "s1" }, error: null }) }
    );
    compute.fn.mockResolvedValue({ ...preview([]), preview: { ...preview([]).preview, plan: 10, serviceRadiusMiles: 18 } });
    const r = await scheduleTighterArea(admin, customer({ pending_monthly_allocation: 10, paused_at: null }), {
      now: NOW,
    });
    expect(r).toMatchObject({ kind: "scheduled", radiusMiles: 18 });
    expect(rpcCalls[0].name).toBe("save_scheduled_lead_brief");
    expect(rpcCalls[0].args).toMatchObject({
      p_customer_id: "c1",
      p_expected_active_id: "active-1",
      p_row: expect.objectContaining({ status: "scheduled", allocation: 10, service_radius_miles: 18 }),
    });
  });
});

describe("the 'Area updated' line on the brief bar", () => {
  const row = { origin: "recompute", confirmed_at: "2026-12-03T10:00:00Z", locked_until: "2027-01-03" };

  it("shows for the first cycle after a recalculated area", () => {
    expect(areaUpdatedLine(row, "2026-12-03")).toBe("Area updated 3 December");
    expect(areaUpdatedLine(row, "2027-01-02")).toBe("Area updated 3 December");
  });

  it("not after the renewal, and never for the customer's own versions", () => {
    expect(areaUpdatedLine(row, "2027-01-03")).toBeNull();
    expect(areaUpdatedLine({ ...row, origin: "customer" }, "2026-12-03")).toBeNull();
    expect(areaUpdatedLine({ ...row, confirmed_at: null }, "2026-12-03")).toBeNull();
  });
});
