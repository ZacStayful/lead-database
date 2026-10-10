import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  BriefSupplyUnavailableError,
  leadIsSupply,
  loadBriefSupply,
  toOtherBriefs,
  toSupplyLead,
} from "@/lib/leadBrief/supply";

/**
 * loadBriefSupply runs six reads. Four must THROW on an error, because an
 * empty answer is a wrong answer (§58): no leads widens every new brief to its
 * cap, and no filtered areas or other briefs hands out first picks that
 * already belong to someone. Two fail OPEN: contention (as the filter
 * forecast does) and the competition tiers.
 */

type Resp = { data: unknown[] | null; error: { message: string } | null };
const ok = (data: unknown[]): Resp => ({ data, error: null });
const fail = (message: string): Resp => ({ data: null, error: { message } });

interface Reads {
  /** Pages for `.range()`, in order. */
  leads?: Resp[];
  claims?: Resp[];
  contention?: Resp;
  filteredAreas?: Resp;
  briefs?: Resp;
  competition?: Resp;
}

interface Call {
  table: string;
  select: string;
  filters: [string, ...unknown[]][];
}

/**
 * A fake admin client. Chain methods return the chain and are recorded;
 * `.range()` answers from a page queue, and awaiting the chain itself answers
 * the single-shot reads. The two `customers` reads are told apart by what
 * they select: the contention read asks for `filter_status`.
 */
function fakeAdmin(reads: Reads) {
  const queues = { leads: [...(reads.leads ?? [])], lead_assignments: [...(reads.claims ?? [])] };
  const calls: Call[] = [];
  const admin = {
    from(table: string) {
      const call: Call = { table, select: "", filters: [] };
      calls.push(call);
      const chain: Record<string, unknown> = {};
      for (const m of ["eq", "neq", "is", "not", "gte", "in", "order"]) {
        chain[m] = (...args: unknown[]) => {
          call.filters.push([m, ...args]);
          return chain;
        };
      }
      chain.select = (cols: string) => {
        call.select = cols;
        return chain;
      };
      chain.range = () =>
        Promise.resolve(queues[table as keyof typeof queues]?.shift() ?? ok([]));
      chain.then = (resolve: (r: Resp) => unknown, reject: (e: unknown) => unknown) => {
        let r: Resp | undefined;
        if (table === "customers") r = call.select.includes("filter_status") ? reads.contention : reads.filteredAreas;
        else if (table === "customer_lead_briefs") r = reads.briefs;
        else if (table === "area_competition") r = reads.competition;
        return Promise.resolve(r ?? ok([])).then(resolve, reject);
      };
      return chain;
    },
  } as unknown as SupabaseClient;
  return { admin, calls };
}

const ROW = {
  id: "l1",
  postcode: "yo10 5dd",
  postcode_area: " yo ",
  bedrooms: "3 bed",
  lead_type: "management",
  created_at: "2026-08-01T00:00:00Z",
  gross_annual_income: 41000,
  avg_nightly_rate: 150,
  occupancy_rate: "63",
  pool_expired_at: null,
  pool_entered_at: null,
  pool_entry_basis: null,
  stayful_conflict_at: null,
  lead_quality_status: "passed",
  lead_quality_override_at: null,
};

describe("toSupplyLead and leadIsSupply", () => {
  it("reads the outcode off the postcode and every figure as a number", () => {
    expect(toSupplyLead(ROW)).toEqual({
      outcode: "YO10",
      area: "YO",
      bedrooms: 3,
      gross: 41000,
      nightly: 150,
      occupancy: 63,
    });
  });

  it("a missing or unreadable figure is null, never zero", () => {
    expect(
      toSupplyLead({ ...ROW, postcode: null, postcode_area: null, bedrooms: "studio", gross_annual_income: null, avg_nightly_rate: "n/a", occupancy_rate: null })
    ).toEqual({ outcode: null, area: null, bedrooms: null, gross: null, nightly: null, occupancy: null });
  });

  it("keeps a live lead and drops every retired one", () => {
    const none = new Set<string>();
    expect(leadIsSupply(ROW, none)).toBe(true);
    expect(leadIsSupply({ ...ROW, stayful_conflict_at: "2026-09-18" }, none)).toBe(false);
    expect(leadIsSupply({ ...ROW, pool_expired_at: "2026-09-18" }, none)).toBe(false);
    expect(leadIsSupply({ ...ROW, pool_entered_at: "2026-09-18", pool_entry_basis: "ignored" }, none)).toBe(false);
    expect(leadIsSupply(ROW, new Set(["l1"]))).toBe(false);
    // An unassigned-basis pool lead stays in stock (§19.1).
    expect(leadIsSupply({ ...ROW, pool_entered_at: "2026-09-18", pool_entry_basis: "unassigned" }, none)).toBe(true);
  });

  it("⚠️ drops a lead the quality gate blocked, unless an admin overrode it (0111)", () => {
    const none = new Set<string>();
    expect(leadIsSupply({ ...ROW, lead_quality_status: "failed" }, none)).toBe(false);
    expect(leadIsSupply({ ...ROW, lead_quality_status: "failed", lead_quality_override_at: "2026-09-01" }, none)).toBe(true);
    expect(leadIsSupply({ ...ROW, lead_quality_status: "pending" }, none)).toBe(true);
  });
});

describe("toOtherBriefs", () => {
  const brief = (over: Record<string, unknown> = {}) => ({
    customer_id: "c1",
    base_outcode: "LS1",
    priority_outcodes: ["BD1", "LS1"] as string[] | null,
    travel_limit_miles: null as number | null,
    service_outcodes: ["LS1"],
    first_pick_outcodes: ["LS2"],
    locked_until: "2026-11-01",
    customer: { is_active: true, subscription_status: "active" },
    ...over,
  });

  it("maps a live brief: its areas base first, its reach from its travel limit", () => {
    expect(toOtherBriefs([brief()])).toEqual([
      {
        customerId: "c1",
        // The base first, and a priority outcode equal to the base only once.
        areaOutcodes: ["LS1", "BD1"],
        // "Anywhere": first picks reach nationwide.
        reachMiles: null,
        serviceOutcodes: ["LS1"],
        firstPickOutcodes: ["LS2"],
        lockedUntil: "2026-11-01",
      },
    ]);
    expect(toOtherBriefs([brief({ travel_limit_miles: 25 })])[0].reachMiles).toBe(25);
    expect(toOtherBriefs([brief({ priority_outcodes: null })])[0].areaOutcodes).toEqual(["LS1"]);
    // Not one of the offered limits (the 0162 CHECK refuses it): read as "anywhere".
    expect(toOtherBriefs([brief({ travel_limit_miles: 30 })])[0].reachMiles).toBeNull();
  });

  it("⚠️ a customer who is no longer subscribed keeps no ground", () => {
    expect(toOtherBriefs([brief({ customer: { is_active: true, subscription_status: "canceled" } })])).toEqual([]);
    expect(toOtherBriefs([brief({ customer: { is_active: false, subscription_status: "active" } })])).toEqual([]);
    expect(toOtherBriefs([brief({ customer: null })])).toEqual([]);
    // A failed card is a billing problem, not a departure.
    expect(toOtherBriefs([brief({ customer: { is_active: true, subscription_status: "past_due" } })])).toHaveLength(1);
  });

  it("⚠️ batch 04: a LONG pause releases the customer's ground, a short one keeps it", () => {
    const paused = (pause_holds_area: boolean | null) =>
      brief({
        customer: {
          is_active: true,
          subscription_status: "active",
          paused_at: "2026-10-01T09:00:00Z",
          pause_holds_area,
        },
      });
    // Locked decision 3: over 4 weeks, their capacity is released at once.
    expect(toOtherBriefs([paused(false)])).toEqual([]);
    // Locked decision 2: up to 4 weeks, they still count.
    expect(toOtherBriefs([paused(true)])).toHaveLength(1);
    // Any other pause (no area flag) is left exactly as before.
    expect(toOtherBriefs([paused(null)])).toHaveLength(1);
    // The flag means nothing once the pause has ended (0167).
    expect(
      toOtherBriefs([
        brief({
          customer: { is_active: true, subscription_status: "active", paused_at: null, pause_holds_area: false },
        }),
      ])
    ).toHaveLength(1);
  });

  it("accepts the embedded customer as an array and null lists as empty", () => {
    const out = toOtherBriefs([
      brief({ customer: [{ is_active: true, subscription_status: "active" }], service_outcodes: null, first_pick_outcodes: null }),
    ]);
    expect(out[0].serviceOutcodes).toEqual([]);
    expect(out[0].firstPickOutcodes).toEqual([]);
  });
});

describe("loadBriefSupply", () => {
  const NOW = new Date("2026-09-30T00:00:00Z"); // 91 days, 13 weeks, after 1 July

  it("assembles the snapshot from all six reads", async () => {
    const { admin, calls } = fakeAdmin({
      claims: [ok([{ lead_id: "claimed" }])],
      leads: [ok([ROW, { ...ROW, id: "claimed" }, { ...ROW, id: "blocked", lead_quality_status: "failed" }])],
      contention: ok([{ id: "f1", filter_areas: ["LS"], filter_status: "active", filter_min_gross: null }]),
      filteredAreas: ok([
        { id: "f1", filter_areas: [" ls ", "YO"] },
        { id: "f2", filter_areas: ["LS"] },
        { id: "f3", filter_areas: null },
      ]),
      briefs: ok([
        {
          customer_id: "c1",
          base_outcode: "HG1",
          priority_outcodes: [],
          travel_limit_miles: 25,
          service_outcodes: ["HG1"],
          first_pick_outcodes: [],
          locked_until: null,
          customer: { is_active: true, subscription_status: "active" },
        },
      ]),
      competition: ok([
        { area_kind: "outcode", area_code: "YO10", tier: "low" },
        { area_kind: "postcode_area", area_code: "LS", tier: "high" },
        { area_kind: "outcode", area_code: "YO1", tier: "extreme" },
      ]),
    });
    const s = await loadBriefSupply(admin, { now: NOW });

    expect(s.weeks).toBeCloseTo(13, 5);
    expect(s.leads).toHaveLength(1);
    expect(s.leads[0].outcode).toBe("YO10");
    expect(s.contention?.byBand.LS).toBeDefined();
    // Trimmed, upper-cased, deduped and sorted; a bedroom-only filter names none.
    expect(s.filteredAreas).toEqual(["LS", "YO"]);
    expect(s.otherBriefs).toEqual([
      { customerId: "c1", areaOutcodes: ["HG1"], reachMiles: 25, serviceOutcodes: ["HG1"], firstPickOutcodes: [], lockedUntil: null },
    ]);
    // Only the three real tiers survive.
    expect(s.competition).toEqual({ "outcode:YO10": "low", "postcode_area:LS": "high" });

    const leadsCall = calls.find((c) => c.table === "leads")!;
    expect(leadsCall.filters).toEqual(
      expect.arrayContaining([
        ["eq", "lead_type", "management"],
        ["is", "owner_customer_id", null],
        ["order", "id", { ascending: true }],
      ])
    );
    expect(leadsCall.select).toContain("postcode");
    expect(leadsCall.select).toContain("lead_quality_status");
    expect(calls.find((c) => c.table === "customer_lead_briefs")!.filters).toContainEqual(["eq", "status", "active"]);
    // Batch 04: the pause columns toOtherBriefs releases a long pause on.
    expect(calls.find((c) => c.table === "customer_lead_briefs")!.select).toMatch(
      /customers!inner\([^)]*\bpaused_at\b[^)]*\bpause_holds_area\b[^)]*\)/
    );
    expect(calls.find((c) => c.table === "area_competition")!.filters).toContainEqual(["eq", "source", "admin"]);
  });

  it("leaves the customer it is computing for out of the contention, the filters and the other briefs", async () => {
    const { admin, calls } = fakeAdmin({});
    await loadBriefSupply(admin, { excludeCustomerId: "me", now: NOW });
    const customerReads = calls.filter((c) => c.table === "customers");
    expect(customerReads).toHaveLength(2);
    for (const c of customerReads) expect(c.filters).toContainEqual(["neq", "id", "me"]);
    expect(calls.find((c) => c.table === "customer_lead_briefs")!.filters).toContainEqual(["neq", "customer_id", "me"]);
  });

  it("reads every page of leads", async () => {
    const page = Array.from({ length: 1000 }, (_, i) => ({ ...ROW, id: `p1-${i}` }));
    const { admin } = fakeAdmin({ leads: [ok(page), ok([{ ...ROW, id: "p2" }])] });
    expect((await loadBriefSupply(admin, { now: NOW })).leads).toHaveLength(1001);
  });

  it.each<[string, Reads]>([
    ["the first leads page", { leads: [fail("Gateway Timeout")] }],
    [
      "a later leads page",
      { leads: [ok(Array.from({ length: 1000 }, (_, i) => ({ ...ROW, id: `x${i}` }))), fail("Gateway Timeout")] },
    ],
    ["the pool-claim read", { claims: [fail("525")] }],
    ["the filtered-area read", { filteredAreas: fail("525") }],
    ["the other briefs", { briefs: fail("525") }],
  ])("⚠️ throws when %s fails, never reads it as empty", async (_name, reads) => {
    const { admin } = fakeAdmin(reads);
    await expect(loadBriefSupply(admin, { now: NOW })).rejects.toBeInstanceOf(BriefSupplyUnavailableError);
  });

  it("fails OPEN on contention, as the filter forecast does", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { admin } = fakeAdmin({ contention: fail("525"), leads: [ok([ROW])] });
    const s = await loadBriefSupply(admin, { now: NOW });
    expect(s.contention?.byBand).toEqual({});
    expect(s.leads).toHaveLength(1);
    err.mockRestore();
  });

  it("fails OPEN on competition tiers: none means nothing is called low competition", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { admin } = fakeAdmin({ competition: fail("525") });
    expect((await loadBriefSupply(admin, { now: NOW })).competition).toEqual({});
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
