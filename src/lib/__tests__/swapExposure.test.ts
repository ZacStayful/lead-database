import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const MIGRATION = "supabase/migrations/0147_pending_swap_exposure.sql";
const HEALTH = "src/lib/serviceHealth.ts";
const PANEL = "src/components/admin/ServiceHealthPanel.tsx";

/**
 * ⚠️ COMMENTS STRIPPED AND WHITESPACE COLLAPSED, and both halves are part of
 * the guard rather than tidying.
 *
 * Every file here explains in prose the thing it must not do, so a naive scan
 * matches the explanation and passes — §46 hit exactly that. And prettier wraps
 * this code at 80 columns, so a phrase this file looks for is routinely split
 * across a newline and ten spaces of indentation; §51.11 records a guard that
 * reported a page clean while the banned sentence sat in it, for that reason
 * alone. A line break is enough to defeat this class of test.
 */
function code(path: string): string {
  return read(path)
    .replace(/^\s*--.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s+/g, " ");
}

/** The body of get_service_capacity as 0147 defines it, comments stripped. */
function capacityBody(): string {
  const sql = code(MIGRATION);
  const start = sql.indexOf("create or replace function public.get_service_capacity()");
  expect(start).toBeGreaterThan(-1);
  const end = sql.indexOf("$function$;", start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe("the exposure figure is reported and never added", () => {
  // ⚠️ THE ASSERTION THIS FILE EXISTS FOR, and the only one enforced in CI.
  // The SQL suite proves the ceilings as identities, but nothing runs it on a
  // deploy — `vercel.json`'s buildCommand runs vitest and `next build` and
  // there is no Postgres in that step. So the one place a "just subtract it
  // from the serviceable figure" edit can be caught automatically is here.
  it("mentions swaps_now exactly twice in the whole function", () => {
    const body = capacityBody();
    const uses = body.match(/s\.swaps_now/g) ?? [];
    expect(uses).toHaveLength(2);
  });

  it("and both of those are the two new output columns, not a ceiling", () => {
    const body = capacityBody();
    // The count, then the count times the average withdrawal cost. Neither
    // divides an allocation or adjusts a supply total.
    expect(body).toContain("s.swaps_now, round(s.swaps_now * s.withdrawal_cost, 1)");
  });

  it("leaves the serviceable total as slots plus recycling alone", () => {
    expect(capacityBody()).toContain("round(s.slots_pm + s.recycled_pm, 1),");
  });

  it("does not charge the replacement lead a second time in the slot figure", () => {
    // The replacement half is already inside avg_alloc_with_swaps (§53.11), so
    // the product is the count times the withdrawal cost and nothing else.
    const body = capacityBody();
    expect(body).not.toMatch(/swaps_now \* \(s\.withdrawal_cost/);
    expect(body).not.toMatch(/swaps_now \* \(1 \+/);
  });
});

describe("the entitlement is the one in deadLeadPolicy, transcribed", () => {
  // `holdsProduct` is an OR on the management side, and the served CTE beside
  // this one is an AND. A customer whose account_status is active while their
  // subscription_status is not can still claim, and a figure built on the
  // served population would miss them.
  it("admits a holder on the OR, not the AND", () => {
    expect(capacityBody()).toContain(
      "case when (c.account_status = 'active' or c.subscription_status in ('active', 'past_due'))",
    );
  });

  // 0142's earned bonus is half of the published rule (§53.8). Dropping it
  // would under-report the exposure of exactly the customers who have earned
  // the most headroom.
  it("includes the earned bonus and its cap of two", () => {
    expect(capacityBody()).toContain(
      "least(floor(coalesce(c.clean_leads_streak, 0) / 10)::integer, 2)",
    );
  });

  // ⚠️ A reviewed uphold can push the counter past the entitlement (§53), so
  // the clamp is the rule and not decoration. There is deliberately no
  // `remaining > 0` short-circuit in the join below it: it would make this
  // clamp unobservable, which is a guard no test could ever fail.
  it("clamps a spent-past entitlement at zero rather than going negative", () => {
    const body = capacityBody();
    expect(body).toContain("- coalesce(c.quality_claims_this_cycle, 0), 0)::integer as remaining");
    expect(body).not.toContain("where e.remaining > 0");
  });

  it("excludes archived customers", () => {
    expect(capacityBody()).toContain("from public.customers c where c.is_active");
  });
});

describe("the claim rule is delegated, not restated", () => {
  // ⚠️ Calling the real predicate with its own default window is what keeps
  // the 14 from being written down twice and the owner bar from being
  // hand-copied — §34 and §35's fifth-copy trap, and the reason 0143 tests
  // lead_retired_from_allocation rather than reproducing one of its arms.
  it("calls claimable_dead_lead_assignments with no window argument", () => {
    const body = capacityBody();
    expect(body).toContain("public.claimable_dead_lead_assignments(e.id) cda");
    expect(body).not.toMatch(/claimable_dead_lead_assignments\(e\.id, \d+\)/);
  });

  it("does not restate the owner bar or the worked-evidence test", () => {
    const body = capacityBody();
    const pending = body.slice(body.indexOf("pending as ("), body.indexOf("paused_side as ("));
    expect(pending).not.toContain("owner_customer_id");
    expect(pending).not.toContain("lead_events");
  });
});

describe("a paused management customer is not exposure", () => {
  // admin_swap_lead_assignment raises on one, so their entitlement cannot be
  // spent on management. §21 excludes paused customers from every allocation
  // metric on the same reasoning, management branch only (invariant 6) — GR
  // keeps flowing to a paused management customer and has no pause of its own.
  it("excludes them from the management row and only that row", () => {
    expect(capacityBody()).toContain(
      "where (l.lead_type = 'guaranteed_rent' or e.paused_at is null)",
    );
  });
});

describe("the daily series carries both columns", () => {
  // ⚠️ The on-conflict list is the one that gets forgotten, and forgetting it
  // fails silently: the day's first capture writes them and every same-day
  // re-run leaves them stale, with no error. The escalation cron does re-run.
  it("names them in all three lists", () => {
    const sql = code(MIGRATION);
    const cap = sql.slice(sql.indexOf("create or replace function public.capture_service_capacity()"));
    expect(cap).toContain("swaps_available_now, swap_slots_now )");
    expect(cap).toContain("c.swaps_available_now, c.swap_slots_now");
    expect(cap).toContain("swaps_available_now = excluded.swaps_available_now");
    expect(cap).toContain("swap_slots_now = excluded.swap_slots_now");
  });
});

describe("the application reads and states it", () => {
  it("parses both columns off the capacity row", () => {
    const health = code(HEALTH);
    expect(health).toContain("swapsAvailableNow: Number(r.swaps_available_now ?? 0)");
    expect(health).toContain("swapSlotsNow: Number(r.swap_slots_now ?? 0)");
  });

  // ⚠️ The panel must say the figure is not in the supply above. Without that
  // sentence an admin reading a ceiling and a slot cost on consecutive lines
  // reasonably subtracts one from the other by hand, which is the very
  // double-count the column was shaped to avoid.
  it("renders it and says it is not counted in the supply figures", () => {
    const panel = code(PANEL);
    expect(panel).toContain("c.swapsAvailableNow");
    expect(panel).toContain("c.swapSlotsNow");
    expect(panel).toContain("Not counted above");
  });

  it("never arithmetically combines it with a ceiling", () => {
    const panel = code(PANEL);
    expect(panel).not.toMatch(/swapSlotsNow\s*[-+]\s*c\./);
    expect(panel).not.toMatch(/c\.\w+\s*[-+]\s*c\.swapSlotsNow/);
    expect(panel).not.toMatch(/sustainableCustomers\w*\s*[-+]\s*c\.swapsAvailableNow/);
  });
});
