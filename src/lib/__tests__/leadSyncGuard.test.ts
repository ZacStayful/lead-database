import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  LEAD_POLL_MAX_INGEST,
  LEAD_SETTLE_MS,
  pickItemsToIngest,
} from "@/lib/leadSync";
import { sellableStatusIndex, type RecentLeadItem } from "@/lib/monday";
import { MESSAGING_SETTINGS } from "@/lib/messaging/adminSettings";

/**
 * Guards on the five-minute lead poll (§63.1) and the fresh-lead window
 * (§63.3). The route and the fetchers reach Monday and the database, so the
 * shape §63 argues for is pinned on the real files (§42.8), comments stripped
 * so a guard cannot be satisfied by its own explanation:
 *
 *   - the cron is scheduled every five minutes, parsed not matched (Vercel
 *     compacts vercel.json before the build runs — lapsePastDueGuard's lesson);
 *   - maxDuration is 60, not 300, on a five-minute schedule;
 *   - a failed settings read is a 500, ABOVE the kill switch (§18.3);
 *   - the poll never calls the full-board walkers;
 *   - it reads which ids it already holds in one query and hands the rest to
 *     ingestLead, unchanged;
 *   - the settle constant is pinned to a LITERAL, not derived (§57's lesson);
 *   - migration 0154 seeds both switches OFF and its three-argument overload
 *     carries no default.
 */
const route = readFileSync("src/app/api/cron/monday-lead-sync/route.ts", "utf8");
const lib = readFileSync("src/lib/leadSync.ts", "utf8");
const monday = readFileSync("src/lib/monday.ts", "utf8");
const migration = readFileSync("supabase/migrations/0154_fresh_lead_release.sql", "utf8");
const vercel = readFileSync("vercel.json", "utf8");

const code = (src: string) => src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
const sql = (src: string) => src.replace(/^\s*--.*$/gm, "");

const item = (id: string, updatedAgoMs: number, now: Date): RecentLeadItem => ({
  payload: { monday_item_id: id, lead_name: `Lead ${id}` },
  createdAt: new Date(now.getTime() - updatedAgoMs - 1000).toISOString(),
  updatedAt: new Date(now.getTime() - updatedAgoMs).toISOString(),
});

describe("the poll route", () => {
  it("is scheduled every five minutes", () => {
    const crons = JSON.parse(vercel).crons as { path: string; schedule: string }[];
    const entry = crons.find((c) => c.path === "/api/cron/monday-lead-sync");
    expect(entry).toBeDefined();
    expect(entry?.schedule).toBe("*/5 * * * *");
  });

  it("keeps a 60-second ceiling on a five-minute schedule", () => {
    expect(code(route)).toMatch(/export const maxDuration = 60;/);
  });

  it("reads its switch through the settings gate and aborts with a 500 above the kill switch", () => {
    const c = code(route);
    expect(c).toContain("resolveSettingsGate(");
    const gate = c.indexOf('gate.reason === "read_failed"');
    const abort = c.indexOf("status: 500", gate);
    const kill = c.indexOf('config.get("lead_sync_enabled")');
    expect(gate).toBeGreaterThan(-1);
    expect(abort).toBeGreaterThan(gate);
    expect(kill).toBeGreaterThan(abort);
  });

  it("never walks the whole board", () => {
    const c = code(route) + code(lib);
    expect(c).not.toContain("fetchMondayLeads(");
    expect(c).not.toContain("fetchGuaranteedRentLeads(");
  });
});

describe("the poll library", () => {
  it("reads which ids it already holds in one query and hands the rest to ingestLead", () => {
    const c = code(lib);
    expect(c).toContain('.in("monday_item_id", allIds)');
    expect(c).toContain("ingestLead(item.payload)");
  });

  it("pins the settle window to a literal", () => {
    // Derived expectations move with the constant they test (§57's lesson).
    expect(LEAD_SETTLE_MS).toBe(120_000);
    expect(LEAD_POLL_MAX_INGEST).toBe(10);
  });

  it("drops known ids, defers unsettled items, ingests oldest first and caps", () => {
    const now = new Date("2026-09-18T10:00:00Z");
    const page = [
      item("new-3", 5 * 60_000, now), // newest-updated first, as Monday returns
      item("settling", 30_000, now),
      item("known", 10 * 60_000, now),
      item("new-2", 20 * 60_000, now),
      item("new-1", 60 * 60_000, now),
    ];
    const picked = pickItemsToIngest(page, new Set(["known"]), now, LEAD_SETTLE_MS, 10);
    expect(picked.known).toBe(1);
    expect(picked.deferred).toBe(1);
    expect(picked.ingest.map((i) => i.payload.monday_item_id)).toEqual(["new-1", "new-2", "new-3"]);

    const capped = pickItemsToIngest(page, new Set(), now, LEAD_SETTLE_MS, 2);
    expect(capped.ingest.map((i) => i.payload.monday_item_id)).toEqual(["new-1", "new-2"]);
  });

  it("orders the board read by last update, not creation", () => {
    const c = code(monday);
    expect(c).toContain('const MONDAY_LAST_UPDATED_COLUMN = "__last_updated__";');
    for (const fn of ["fetchRecentManagementLeads", "fetchRecentGuaranteedRentLeads"]) {
      const start = c.indexOf(`export async function ${fn}`);
      expect(start).toBeGreaterThan(-1);
      const slice = c.slice(start, start + 4000);
      expect(slice).toContain('order_by: [{ column_id: "${MONDAY_LAST_UPDATED_COLUMN}", direction: desc }]');
      expect(slice).not.toContain("__creation_log__");
    }
  });
});

describe("the status rule takes the label index", () => {
  // The shape Monday's settings_str carries for a status column: an id→text
  // map. Captured from board 18420117742's status5 column while building §63.
  const settings = JSON.stringify({
    labels: {
      "0": "Special offer applied",
      "1": "Dead",
      "5": "Un Qualified Lead",
      "13": "Qualified lead",
      "16": "Lead for sale",
      "108": "Web meeting booked",
    },
    labels_positions_v2: { "16": 14 },
  });

  it("resolves the index from the column settings", () => {
    expect(sellableStatusIndex(settings, "Lead for sale")).toBe(16);
    expect(sellableStatusIndex(settings, "Web meeting booked")).toBe(108);
  });

  it("returns null for a label that is not there, and never guesses", () => {
    expect(sellableStatusIndex(settings, "Lead For Sale")).toBeNull();
    expect(sellableStatusIndex(settings, "Sellable")).toBeNull();
    expect(sellableStatusIndex("not json", "Lead for sale")).toBeNull();
    expect(sellableStatusIndex("{}", "Lead for sale")).toBeNull();
  });

  it("accepts the array shape the board-info API returns too", () => {
    const arr = JSON.stringify({ labels: [{ id: 16, label: "Lead for sale" }, { id: 1, label: "Dead" }] });
    expect(sellableStatusIndex(arr, "Lead for sale")).toBe(16);
  });

  it("filters the page on the resolved index AND re-checks the text", () => {
    const c = code(monday);
    const start = c.indexOf("export async function fetchRecentManagementLeads");
    const slice = c.slice(start, start + 4000);
    expect(slice).toContain("compare_value: [${sellableIndexCache}]");
    expect(slice).toContain("textFor(item, COLUMN_MAP.status) !== SELLABLE_STATUS");
  });
});

describe("the switches and the migration", () => {
  it("both keys are on the closed allow-list and ship off", () => {
    const poll = MESSAGING_SETTINGS.find((s) => s.key === "lead_sync_enabled");
    const fresh = MESSAGING_SETTINGS.find((s) => s.key === "release_fresh_hours");
    expect(poll?.kind).toBe("boolean");
    expect(poll?.fallback).toBe("false");
    expect(fresh?.kind).toBe("number");
    expect(fresh?.fallback).toBe("0");
    // 0 is OFF and is the safe value here, so the floor is 0 (unlike
    // release_max_per_day, where 0 refuses every lead for everyone).
    expect(fresh?.min).toBe(0);
  });

  it("0154 seeds both switches off", () => {
    const s = sql(migration);
    expect(s).toContain("('release_fresh_hours', '0')");
    expect(s).toContain("('lead_sync_enabled', 'false')");
  });

  it("0154's three-argument overload carries no default", () => {
    const s = sql(migration);
    const sig = s.indexOf("p_lead_created_at timestamptz");
    expect(sig).toBeGreaterThan(-1);
    // The whole three-argument signature: from its create line to its `)`.
    const start = s.lastIndexOf("create or replace function public.customer_release_allows(", sig);
    const end = s.indexOf(")", sig);
    expect(s.slice(start, end)).not.toContain("default");
  });

  it("0154 bypasses only the curve — the hold, the entitlement and the cap stay", () => {
    const s = sql(migration);
    expect(s).toContain("if not v_fresh and v_received >= v_allowance then");
    // The hold and entitlement checks precede the fresh clause and do not read it.
    const hold = s.indexOf("if v_hold is not null and v_today < v_hold then");
    const ent = s.indexOf("if v_e <= 0 then");
    const curve = s.indexOf("if not v_fresh and v_received >= v_allowance then");
    const cap = s.indexOf("return v_today_n < v_max_per_day;");
    expect(hold).toBeGreaterThan(-1);
    expect(ent).toBeGreaterThan(hold);
    expect(curve).toBeGreaterThan(ent);
    expect(cap).toBeGreaterThan(curve);
  });

  it("both candidate functions pass the lead's own created_at", () => {
    const s = sql(migration);
    expect(s).toContain("public.customer_release_allows(c.id, p_lead_type, l.created_at)");
    expect(s).toContain("(select l2.created_at from public.leads l2 where l2.id = p_lead_id)");
  });
});
