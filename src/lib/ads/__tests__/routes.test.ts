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
 * ⚠️ THE ORDER OF THE ANSWERS ROUTE, WHICH IS WHAT THE OPERATOR FEELS.
 *
 * It shipped claiming the draft first, so a run missing a slot burned a
 * generation slot to be told what was missing — and `writeAd` then had to
 * release the claim it had just taken. These assert the reordering, each on a
 * literal index rather than a behavioural stand-in, because the route reaches
 * Supabase and the model and cannot run in this suite.
 */
describe("the answers route", () => {
  const text = source(`${ADS_API}/[id]/answers/route.ts`);
  const at = (needle: string) => {
    const i = text.indexOf(needle);
    expect(i, `expected to find ${needle}`).toBeGreaterThan(-1);
    return i;
  };

  it("pre-flights before it claims", () => {
    expect(at("preflight(adContext(")).toBeLessThan(at("claimForGeneration("));
  });

  /** ⚠️ The answers being sent are usually exactly what fills the gap. */
  it("merges the profile before it pre-flights", () => {
    expect(at("mergeAdProfile(")).toBeLessThan(at("preflight(adContext("));
  });

  /** ⚠️ A refusal must never cost the operator their typing. */
  it("files the answers before anything can refuse", () => {
    expect(at("replaceQuestions(")).toBeLessThan(at("preflight(adContext("));
  });

  /**
   * ⚠️ AGAINST THE POST-MERGE PROFILE THE RPC HANDED BACK. Pre-flighting the
   * row the request was handed checks a profile that is already stale by
   * exactly the answers being submitted — it would refuse every run.
   */
  it("pre-flights the merged profile, not the row it was handed", () => {
    expect(text).toContain("merged.profile");
    expect(text).toMatch(/preflight\(adContext\(after,/);
  });

  /**
   * ⚠️ `merged.ok`, NOT `merged`. `mergeAdProfile` returns an object, which is
   * always truthy, so a bare `if (!merged)` is a failure branch that can never
   * run — and the failure it guards is a profile write that silently did not
   * happen.
   */
  it("tests the merge result rather than the object", () => {
    for (const file of [`${ADS_API}/[id]/answers/route.ts`, `${ADS_API}/profile/route.ts`]) {
      const t = source(file);
      expect(t).toMatch(/if \(!merged\.ok\)/);
      expect(t).not.toMatch(/if \(!merged\)/);
    }
  });

  /**
   * ⚠️ NOTHING IS RELEASED ON THE REFUSAL PATH BECAUSE NOTHING IS CLAIMED.
   * The route holds no claim when it refuses, so a `releaseClaim` here would
   * be releasing somebody else's.
   */
  it("takes no claim it has to release", () => {
    expect(text).not.toContain("releaseClaim");
  });
});

/**
 * ⚠️ THE FEE RULE EXISTED AND WAS NEVER CONSULTED AT THE POINT OF WRITING.
 * `resolveSlots` refuses the same number afterwards, so an out-of-range fee was
 * stored, then silently dropped off the ad, with the reason recorded in a
 * `warnings` array nothing rendered.
 */
describe("the fee", () => {
  it("is written through feeVerdict rather than straight from asCount", () => {
    const text = source("src/lib/ads/profile.ts");
    const start = text.indexOf('case "fee_pct"');
    expect(start).toBeGreaterThan(-1);
    const arm = text.slice(start, text.indexOf('case "fee_basis"'));
    expect(arm).toContain("feeVerdict(");
    expect(arm).not.toMatch(/put\(slot, asCount\(raw, \{ max: 99 \}\)\)/);
  });

  /** ⚠️ Never the raw flag key in front of a customer (`slotCopy.ts:114`). */
  it("is reported to the operator as a sentence, from the profile GET", () => {
    const text = source(`${ADS_API}/profile/route.ts`);
    expect(text).toContain("warningSentences(");
    expect(text).not.toMatch(/warnings:\s*resolution\.warnings/);
  });

  it("is shown by the form rather than only sent to it", () => {
    const text = source("src/components/dashboard/ads/AdProfileForm.tsx");
    expect(text).toContain("props.warnings");
    expect(text).toMatch(/\[\.\.\.said, \.\.\.warnings\]/);
  });
});

/**
 * ⚠️ ONE EXPRESSION OF "IS THIS RUNNABLE", AND ONE SENTENCE FOR IT.
 *
 * `preflight` is that expression. Three routes and `writeAd` ask it, and none
 * of them may re-derive the answer from `context.unresolved` — the trap §34
 * and §35 both record, where a hand-written second copy of a live rule drifts
 * and the drift is silent.
 */
describe("the refusal", () => {
  it("is asked of preflight rather than read off the context", () => {
    const files = [
      ...FILES,
      "src/lib/ads/writeAd.ts",
      "src/app/dashboard/ads/[id]/page.tsx",
    ];
    for (const file of files) {
      const text = source(file);
      expect(text, file).not.toMatch(/\.unresolved\.length/);
      expect(text, file).not.toMatch(/unresolved\.map\(slotCopyLabel/);
    }
  });

  /** ⚠️ And worded once, in `copy.ts`. Regenerate wrote its own inline. */
  it("is worded once", () => {
    for (const file of FILES) {
      const text = source(file);
      expect(text, file).not.toMatch(/I still need \$\{/);
    }
    expect(source("src/lib/ads/copy.ts")).toContain("unresolved: (labels: string[])");
  });

  /** ⚠️ The render route showed `generic` for the identical condition. */
  it("names what is missing on the render route too", () => {
    const text = source(`${ADS_API}/[id]/render/route.ts`);
    expect(text).toContain("AD_COPY.errors.unresolved(");
  });
});

/**
 * ⚠️ "ad", NEVER "advert", ON EVERY SURFACE AN OPERATOR READS.
 *
 * Meta's own vocabulary is "ad" and the code has said `ads` throughout since
 * 0156, so the UI was the only thing saying something else — a product that
 * calls one thing two names in two places reads as two features.
 *
 * ⚠️ TWO DELIBERATE EXCEPTIONS, AND NEITHER IS AN OVERSIGHT.
 *
 *   `prompts.ts` and `brief.ts` are MODEL-FACING. Nothing there is read by a
 *   customer, the wording is tuned against what the model produced, and
 *   rewording a prompt to match a UI string is how a retune arrives by
 *   accident.
 *
 *   The privacy policy and §60 are STAYFUL'S OWN advertising. That is legal
 *   copy about our Meta pixel, where "advert" is correct and where §51.11
 *   records what changing published claims carelessly costs.
 */
describe("the word", () => {
  const SURFACES = [
    ...FILES,
    "src/lib/ads/copy.ts",
    "src/lib/ads/slotCopy.ts",
    "src/lib/ads/destination.ts",
    "src/lib/ads/url.ts",
    "src/lib/dashboardNav.ts",
    "src/components/dashboard/ads/AdChat.tsx",
    "src/components/dashboard/ads/AdCreatives.tsx",
    "src/components/dashboard/ads/AdProfileForm.tsx",
    "src/app/dashboard/ads/page.tsx",
    "src/app/dashboard/ads/[id]/page.tsx",
    "src/app/dashboard/ads/profile/page.tsx",
  ];

  it("is ad, not advert, on every ad surface", () => {
    for (const file of SURFACES) {
      // ⚠️ NOT comment-stripped, unlike every other guard in this file. The
      // point is the vocabulary a reader meets, and half of these strings sit
      // in a docblock explaining the copy beneath them.
      //
      // ⚠️ THE NOUN ONLY. "advertising" is an ordinary word — the ASA is the
      // Advertising Standards Authority, which the attestation copy names —
      // and banning it pushes perfectly good sentences into circumlocution to
      // satisfy a test.
      const text = readFileSync(join(ROOT, file), "utf8");
      expect(text, file).not.toMatch(/\badverts?\b/i);
    }
  });

  it("leaves the model's own prompts alone", () => {
    const prompts = readFileSync(join(ROOT, "src/lib/ads/prompts.ts"), "utf8");
    const brief = readFileSync(join(ROOT, "src/lib/ads/brief.ts"), "utf8");
    expect(prompts + brief).toMatch(/\badverts?\b/i);
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
