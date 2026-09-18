import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  fetchLeadVolumeData,
  LeadVolumeUnavailableError,
} from "@/lib/filterPrediction";

/**
 * The lead-volume loader must never turn a database error into an empty book
 * (§58). On production, Supabase gateway timeouts between 9 and 14 Sep 2026
 * made every filtering surface render as though the marketplace had no leads:
 * no map, no picker, no radius search, no forecast, no cost per lead, no
 * cheaper-plan advice, and the apply-now question silently skipped. Nothing
 * was reverted; the loader `break`-ed on error and everything downstream
 * believed it.
 */

type Page = { data: Record<string, unknown>[] | null; error: { message: string } | null };

/**
 * A fake admin client that answers each table's `.range()` calls from a queue
 * of pages. Every other method in the chain returns the chain itself, so the
 * loader's real query shape drives it without the test restating that shape.
 */
function fakeAdmin(pages: Record<string, Page[]>): SupabaseClient {
  const queues: Record<string, Page[]> = Object.fromEntries(
    Object.entries(pages).map(([k, v]) => [k, [...v]])
  );
  return {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      for (const m of ["select", "is", "not", "gte", "order", "eq"]) chain[m] = self;
      chain.range = () =>
        Promise.resolve(
          queues[table]?.shift() ?? { data: [], error: null }
        );
      return chain;
    },
  } as unknown as SupabaseClient;
}

const LEAD = {
  id: "l1",
  postcode_area: "BS",
  bedrooms: "3",
  lead_type: "management",
  created_at: "2026-08-01T00:00:00Z",
  pool_expired_at: null,
  pool_entered_at: null,
  pool_entry_basis: null,
};

describe("fetchLeadVolumeData — an unreadable book is an error, never an empty one", () => {
  it("rejects when the first leads page errors", async () => {
    const admin = fakeAdmin({
      lead_assignments: [{ data: [], error: null }],
      leads: [{ data: null, error: { message: "Gateway Timeout" } }],
    });
    await expect(fetchLeadVolumeData(admin)).rejects.toBeInstanceOf(
      LeadVolumeUnavailableError
    );
  });

  it("rejects when a LATER page errors, rather than returning the half it read", async () => {
    const firstPage = Array.from({ length: 1000 }, (_, i) => ({
      ...LEAD,
      id: `l${i}`,
    }));
    const admin = fakeAdmin({
      lead_assignments: [{ data: [], error: null }],
      leads: [
        { data: firstPage, error: null },
        { data: null, error: { message: "Gateway Timeout" } },
      ],
    });
    await expect(fetchLeadVolumeData(admin)).rejects.toThrow(/Gateway Timeout/);
  });

  it("rejects when the retired-lead read errors", async () => {
    const admin = fakeAdmin({
      lead_assignments: [{ data: null, error: { message: "525" } }],
      leads: [{ data: [LEAD], error: null }],
    });
    await expect(fetchLeadVolumeData(admin)).rejects.toBeInstanceOf(
      LeadVolumeUnavailableError
    );
  });

  it("still resolves an empty aggregate for a genuinely empty book", async () => {
    const admin = fakeAdmin({
      lead_assignments: [{ data: [], error: null }],
      leads: [{ data: [], error: null }],
    });
    const out = await fetchLeadVolumeData(admin);
    expect(out.aggregate.management.totalLeads).toBe(0);
    expect(out.areaCounts).toEqual({});
  });

  it("still aggregates a readable book", async () => {
    const admin = fakeAdmin({
      lead_assignments: [{ data: [], error: null }],
      leads: [{ data: [LEAD, { ...LEAD, id: "l2", postcode_area: "GL" }], error: null }],
    });
    const out = await fetchLeadVolumeData(admin);
    expect(out.aggregate.management.totalLeads).toBe(2);
    expect(out.areaCounts).toEqual({ BS: 1, GL: 1 });
  });

  it("reads a lead in Stayful's own pipeline as retired, never as supply (§64)", async () => {
    const admin = fakeAdmin({
      lead_assignments: [{ data: [], error: null }],
      leads: [
        {
          data: [LEAD, { ...LEAD, id: "l2", stayful_conflict_at: "2026-09-18T00:00:00Z" }],
          error: null,
        },
      ],
    });
    const out = await fetchLeadVolumeData(admin);
    expect(out.aggregate.management.totalLeads).toBe(1);
  });
});

/**
 * File-text guards, the §42.8 discipline: a test that restates the query is a
 * test of the restatement. These read the real files and pin the one-token
 * change that reintroduces the fail-open.
 */
function src(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

function slice(text: string, from: string, to: string): string {
  const a = text.indexOf(from);
  const b = text.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error(`markers not found: ${from} .. ${to}`);
  return text.slice(a, b);
}

describe("fail-open guards (§58)", () => {
  const prediction = src("src/lib/filterPrediction.ts");

  it("fetchLeadVolumeData throws on error and never breaks on it", () => {
    const body = slice(
      prediction,
      "export async function fetchLeadVolumeData",
      "interface RawLeadVolumeRow"
    );
    expect(body).toContain("throw new LeadVolumeUnavailableError");
    expect(body).not.toMatch(/error\s*\|\|\s*!data/);
  });

  it("fetchRetiredLeadIds throws on error and never breaks on it", () => {
    const body = prediction.slice(
      prediction.indexOf("async function fetchRetiredLeadIds")
    );
    expect(body).toContain("throw new LeadVolumeUnavailableError");
    expect(body).not.toMatch(/error\s*\|\|\s*!data/);
  });

  it("the filtering page catches the error and tells the panel", () => {
    const page = src("src/app/dashboard/filtering/page.tsx");
    expect(page).toMatch(/try\s*\{\s*volumeData = await fetchLeadVolumeData/);
    expect(page).toContain("volumeUnavailable = true");
    // Both products' panels carry the flag.
    expect(page.match(/volumeUnavailable,\n\s*\}\);/g)?.length).toBe(2);
  });

  it("the panel refuses to apply while volumes are unavailable, and says so", () => {
    const panel = src("src/components/dashboard/LeadFilteringPanel.tsx");
    expect(panel).toContain(
      "disabled={busy || blocked || props.volumeUnavailable === true}"
    );
    expect(panel).toContain("{VOLUME_UNAVAILABLE}");
    // The empty-book copy is only reachable when the book was actually read.
    expect(panel).toMatch(
      /props\.volumeUnavailable \? \([\s\S]*?\) : availableAreas\.length === 0 \?/
    );
  });

  it("the apply route answers 503 rather than applying against an empty book", () => {
    const route = src("src/app/api/customer/filter/route.ts");
    const block = slice(route, "let aggregate: LeadVolumeAggregate", "const prediction =");
    expect(block).toContain('code: "volume_unavailable"');
    expect(block).toContain("status: 503");
  });

  it("the backfill route refuses to write from an unreadable book", () => {
    const route = src("src/app/api/admin/filters/backfill-forecast/route.ts");
    const block = slice(route, "let aggregate: LeadVolumeAggregate", "const { data, error }");
    expect(block).toContain("status: 503");
  });
});
