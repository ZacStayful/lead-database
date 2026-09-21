import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Structural guards on the routes (§65).
 *
 * ⚠️ FILE-TEXT, BECAUSE `vitest.config.mts` IS PURE UNITS ONLY. A route
 * handler reaches Supabase and the model; standing one up in the default suite
 * would cost the property that makes it safe to gate `next build` on. What
 * these assert is what a route DOES NOT DO, which no behavioural test reaches
 * anyway — §42.8's 91 destroyed sequence runs came from a boundary asserted in
 * a pull request and never actually written.
 */
const ROOT = process.cwd();
const ADS_API = "src/app/api/customer/ads";

function routeFiles(): string[] {
  const out = execFileSync("find", [ADS_API, "-name", "route.ts"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
  return out ? out.split("\n").sort() : [];
}

/** ⚠️ Comments stripped: several of these files EXPLAIN the rule (§46). */
function source(path: string): string {
  return readFileSync(join(ROOT, path), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const FILES = routeFiles();

describe("every ad route", () => {
  it("is one of the nine files, carrying twelve handlers", () => {
    expect(FILES).toHaveLength(9);
    expect(FILES).toContain(`${ADS_API}/route.ts`);
    expect(FILES).toContain(`${ADS_API}/[id]/image/[ratio]/route.ts`);
    const handlers = FILES.flatMap((f) =>
      Array.from(source(f).matchAll(/export async function (GET|POST|PUT|DELETE)\b/g)).map(
        (m) => `${f}:${m[1]}`
      )
    );
    expect(handlers).toHaveLength(12);
    // Nothing else. PATCH would be a write nobody had thought about.
    expect(handlers.filter((h) => h.endsWith(":PUT"))).toEqual([`${ADS_API}/profile/route.ts:PUT`]);
  });

  /**
   * ⚠️ ONE GATE, CALLED EVERYWHERE. It would otherwise sit at a dozen call
   * sites, and the day a second customer is let in that is a dozen edits with
   * any miss producing a 404 on a feature just enabled.
   */
  it("goes through the shared session and never re-implements the check", () => {
    for (const f of FILES) {
      const text = source(f);
      expect(text, f).toMatch(/await ad(Write)?Session\(\)/);
      expect(text, f).not.toContain("isOwnerEmail");
      expect(text, f).not.toContain("adsEnabledFor");
    }
  });

  it("runs on node, is never cached, and never static", () => {
    for (const f of FILES) {
      const text = source(f);
      expect(text, f).toContain('export const runtime = "nodejs"');
      expect(text, f).toContain('export const dynamic = "force-dynamic"');
    }
  });

  /**
   * ⚠️ THE COPY PATH SPENDS 60 + 45 SECONDS AND MUST STILL BE ALIVE TO STORE
   * THE RESULT. At 60 it is killed mid-generation and the draft is stranded in
   * `generating` until the stale window — a spinner the operator watches for
   * six minutes.
   */
  it("gives the copy routes the ceiling they need, and nothing else 300", () => {
    for (const f of FILES) {
      const wants300 = f.includes("/answers/") || f.includes("/regenerate/");
      expect(source(f), f).toContain(`export const maxDuration = ${wants300 ? 300 : 60}`);
    }
  });

  /**
   * ⚠️ A WRITE RESOLVES THE CUSTOMER BY user_id, NEVER THROUGH THE VIEW-AS
   * COOKIE. §62's middleware already refuses these, so this is defence in
   * depth — but the rule is the brand route's and the reason holds: an inline
   * lookup can only ever write the caller's own row.
   */
  it("uses the write session for every POST, PUT and DELETE", () => {
    for (const f of FILES) {
      const text = source(f);
      const writes = /export async function (POST|PUT|DELETE)\b/.test(text);
      if (!writes) continue;
      expect(text, f).toContain("await adWriteSession()");
    }
  });

  it("uses the read session for every GET", () => {
    for (const f of FILES) {
      const text = source(f);
      if (!/export async function GET\b/.test(text)) continue;
      expect(text, f).toMatch(/await adSession\(\)/);
    }
  });
});

/**
 * ⚠️ THE LEDGER IS THE DRAFT CAP'S OWN SOURCE, so a route that generates and
 * forgets to record silently hands out an unbounded number of adverts.
 * `generate.ts` deliberately writes nothing, which keeps it unit-testable and
 * makes this the thing that has to be checked.
 */
describe("a generation is always recorded", () => {
  it("every route that generates also records", () => {
    for (const f of FILES) {
      const text = source(f);
      const generates =
        /\bgenerateQuestions\(|\bsimplifyQuestion\(|\bgenerateCopy\(|\bwriteAd\(/.test(text);
      if (!generates) continue;
      // writeAd records on the route's behalf, in one place, for both callers.
      const records = text.includes("recordGenerations") || text.includes("writeAd(");
      expect(records, f).toBe(true);
    }
  });

  it("writeAd itself records, so its two callers cannot each forget", () => {
    expect(source("src/lib/ads/writeAd.ts")).toContain("recordGenerations");
  });
});

describe("the budgets", () => {
  /**
   * ⚠️ NEVER A READ-MODIFY-WRITE. Two tabs both pass a TypeScript `if`, and
   * neither passes a WHERE clause. PostgREST cannot express `x = x + 1`, so
   * the only honest shape is the RPC.
   */
  it("are spent through the RPC and nowhere else", () => {
    for (const f of FILES) {
      const text = source(f);
      expect(text, f).not.toMatch(/template_switches:\s*\w+\s*\+/);
      expect(text, f).not.toMatch(/regenerations:\s*\w+\s*\+/);
      expect(text, f).not.toMatch(/renders:\s*\w+\s*\+/);
    }
    expect(source("src/lib/ads/session.ts")).toContain('rpc("spend_ad_budget"');
  });

  /**
   * ⚠️ ANCHORED ON THE CALL, NOT THE IDENTIFIER. The first draft compared
   * `indexOf("generateQuestions")`, which finds the IMPORT at the top of the
   * file — so it was measuring the wrong pair entirely, and would have gone on
   * measuring it after any reordering of the imports.
   */
  it("are spent before the model is called, not after", () => {
    const text = source(`${ADS_API}/[id]/template/route.ts`);
    expect(text.indexOf("await spendBudget(")).toBeGreaterThan(-1);
    expect(text.indexOf("await spendBudget(")).toBeLessThan(text.indexOf("await generateQuestions("));

    const regen = source(`${ADS_API}/[id]/regenerate/route.ts`);
    expect(regen.indexOf("await spendBudget(")).toBeGreaterThan(-1);
    expect(regen.indexOf("await spendBudget(")).toBeLessThan(regen.indexOf("await writeAd("));
  });

  /** ⚠️ Counted on the append-only ledger, never on a table they can delete. */
  it("counts drafts from the ledger", () => {
    const text = source(`${ADS_API}/route.ts`);
    expect(text).toContain("draftsStartedToday");
    expect(text).not.toMatch(/from\("ad_drafts"\)[\s\S]{0,120}count/);
  });

  /** An unreadable cap is not permission. */
  it("fails closed when the cap cannot be read", () => {
    expect(source(`${ADS_API}/route.ts`)).toMatch(/if \(!started\.ok\)[\s\S]{0,80}503/);
  });
});

describe("the claim", () => {
  /**
   * ⚠️ A DOUBLE-TAPPED SEND PUTS TWO REQUESTS IN FLIGHT. Both pass a
   * TypeScript `if`; only the WHERE clause stops both paying for a generation
   * and racing to store a different advert into the same row.
   */
  it("happens before anything is spent, on both copy routes", () => {
    for (const f of [`${ADS_API}/[id]/answers/route.ts`, `${ADS_API}/[id]/regenerate/route.ts`]) {
      const text = source(f);
      expect(text, f).toContain("claimForGeneration");
      expect(text.indexOf("await claimForGeneration("), f).toBeGreaterThan(-1);
      expect(text.indexOf("await claimForGeneration("), f).toBeLessThan(text.indexOf("await writeAd("));
    }
  });

  it("is an RPC rather than a PostgREST filter on a timestamp", () => {
    const text = source("src/lib/ads/session.ts");
    expect(text).toContain('rpc("claim_ad_draft"');
    expect(text).not.toContain("status.neq.generating");
  });
});

/**
 * ⚠️ NO MODEL CALL ON THE READ PATH. It is the page load AND the poll, so a
 * generation here would be paid for on every refresh and would race the one
 * the answers route is running.
 */
describe("the read path", () => {
  it("never generates", () => {
    for (const f of [`${ADS_API}/[id]/route.ts`, `${ADS_API}/[id]/image/[ratio]/route.ts`]) {
      const text = source(f).split("export async function DELETE")[0];
      expect(text, f).not.toMatch(/generateQuestions|generateCopy|simplifyQuestion|writeAd\(/);
    }
  });

  /**
   * ⚠️ THE PATH COMES FROM ad_creatives, NEVER FROM THE URL SEGMENT. Building
   * it from the request would make the bucket's layout addressable.
   */
  it("signs a stored path rather than one built from the URL", () => {
    const text = source(`${ADS_API}/[id]/image/[ratio]/route.ts`);
    expect(text).toContain('.from("ad_creatives")');
    expect(text).not.toContain("adCreativePath");
  });
});

describe("the render route", () => {
  /**
   * ⚠️ `ImageResponse` SELF-SETS `cache-control: public, immutable,
   * max-age=31536000`. Returning one from a regenerable route would have every
   * proxy between here and the operator hold their first render for a year.
   */
  it("never returns an ImageResponse", () => {
    const text = source(`${ADS_API}/[id]/render/route.ts`);
    expect(text).not.toContain("ImageResponse");
    expect(text).not.toContain("next/og");
  });

  /**
   * ⚠️ THE FIGURE CHECK RUNS OVER THE IMAGE TOO. Every other rule reads copy,
   * but the card renders values of its own — and one put there to look
   * concrete never passes through the model at all.
   */
  it("runs the figure check over the flattened layout", () => {
    const text = source(`${ADS_API}/[id]/render/route.ts`);
    expect(text).toContain("figuresAreSupplied(flattenSpecText(");
  });

  /** Objects first, then the row — the row is the only list of the objects. */
  it("deletes objects before the draft", () => {
    const text = source(`${ADS_API}/[id]/route.ts`);
    expect(text.indexOf("await removeCreatives(")).toBeGreaterThan(-1);
    expect(text.indexOf("await removeCreatives(")).toBeLessThan(
      text.indexOf('.from("ad_drafts")')
    );
  });
});

describe("the profile", () => {
  /** ⚠️ Merged in SQL: two writers exist and the lost edit is the fee. */
  it("is merged rather than read, modified and written", () => {
    const text = source(`${ADS_API}/profile/route.ts`);
    expect(text).toContain("mergeAdProfile");
    expect(text).not.toMatch(/ad_profile:\s*\{\s*\.\.\./);
    expect(source("src/lib/ads/session.ts")).toContain('rpc("merge_ad_profile"');
  });

  /**
   * ⚠️ AN ATTESTATION DATED BY ITS SUBJECT IS NOT AN ATTESTATION. CAP Code 3.7
   * wants documentary evidence held BEFORE publication, and the tick is the
   * record that it is.
   */
  it("stamps the attestation itself rather than taking a date from the body", () => {
    const text = source(`${ADS_API}/profile/route.ts`);
    expect(text).toContain("new Date().toISOString()");
    expect(text).not.toMatch(/stats_confirmed_at.*body\[/);
  });

  /** And the chat may never set one. */
  it("keeps the attestations out of what a chat answer can write", () => {
    const text = source("src/lib/ads/profile.ts");
    const list = text.slice(text.indexOf("CHAT_WRITABLE_SLOTS"), text.indexOf("] as const satisfies"));
    expect(list).not.toContain("review_quote_confirmed");
    expect(list).not.toContain("stats_confirmed_at");
  });
});

/**
 * ⚠️ ONE LAYOUT OVER THE WHOLE SEGMENT, not a check in the page. A page-level
 * check leaves the next page somebody adds ungated, and `dashboard/layout.tsx`
 * is a server component with no pathname so it cannot gate one route.
 */
describe("the pages", () => {
  it("are gated by a segment layout that calls notFound", () => {
    const text = source("src/app/dashboard/ads/layout.tsx");
    expect(text).toContain("adsEnabledFor");
    expect(text).toContain("notFound()");
  });
});
