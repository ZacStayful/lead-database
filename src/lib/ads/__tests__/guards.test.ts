import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Structural guards (§65). These assert things no behavioural test can reach:
 * what imports what, and what a file does or does not contain.
 *
 * ⚠️ COMMENTS ARE STRIPPED BEFORE MATCHING. Several of these files EXPLAIN the
 * rule they are being checked against — `render.tsx`'s docblock names
 * `next/og`, and `theme.ts`'s names `var(--sf-*)`. A naive substring check
 * passes on the explanation and fails on the code, which trains the next
 * person to delete the explanation. §46 hit exactly this.
 */
const ROOT = process.cwd();
const ADS = join(ROOT, "src/lib/ads");

function source(path: string): string {
  return readFileSync(join(ROOT, path), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Every file under src/ that imports the given specifier. */
function importersOf(specifier: string): string[] {
  const out = execFileSync(
    "grep",
    ["-rl", "--include=*.ts", "--include=*.tsx", "-F", `from "${specifier}"`, "src"],
    { cwd: ROOT, encoding: "utf8" }
  ).trim();
  return out ? out.split("\n") : [];
}

/**
 * ⚠️ THE GUARDS THEMSELVES NAME WHAT THEY FORBID, so a grep over src/ finds
 * this file and the behavioural suites beside it. Excluding __tests__ is not
 * loosening the guard — a test is not shipped code — but it has to be
 * deliberate, or the first failure trains somebody to delete the assertion.
 */
const NOT_TESTS = "--exclude-dir=__tests__";

function grepOrEmpty(args: string[]): string[] {
  try {
    const out = execFileSync("grep", args, { cwd: ROOT, encoding: "utf8" }).trim();
    return out ? out.split("\n") : [];
  } catch {
    return []; // grep exits 1 on no match
  }
}

describe("⚠️ next/og is quarantined", () => {
  it("is imported by exactly one file, and that file is render.tsx", () => {
    // It drags ~2 MB of resvg.wasm and yoga.wasm, and they fail at FIRST
    // INVOCATION with MODULE_NOT_FOUND rather than at deploy — so a stray
    // import is a bundle that builds, deploys, and 500s somewhere unrelated.
    expect(importersOf("next/og")).toEqual(["src/lib/ads/render.tsx"]);
  });

  it("render.tsx is itself imported by at most one module", () => {
    const importers = grepOrEmpty([
      "-rl", "--include=*.ts", "--include=*.tsx", "-E", 'from "[^"]*ads/render"', "src",
    ]);
    expect(importers.length).toBeLessThanOrEqual(1);
  });
});

describe("⚠️ no barrel in src/lib/ads", () => {
  it("has no index.ts", () => {
    // src/lib/meta carries the reason: "a barrel would drag the server
    // modules into the client bundle through this one import."
    const names = readdirSync(ADS);
    expect(names).not.toContain("index.ts");
    expect(names).not.toContain("index.tsx");
  });
});

describe("⚠️ the client-safe modules stay import-free", () => {
  const IMPORT_FREE = ["copy.ts", "storagePaths.ts", "emphasis.ts", "metaFields.ts", "url.ts", "destination.ts"];

  it("imports nothing at all, so a client component can use them", () => {
    // deadLeadCopy.ts and featureRequest.ts are the precedent: the moment one
    // of these reaches a module that constructs a Supabase or Resend client,
    // every consumer becomes a server component.
    for (const file of IMPORT_FREE) {
      const src = source(`src/lib/ads/${file}`);
      expect(src.match(/^\s*import\s/m), file).toBeNull();
    }
  });

  it("theme.ts and templates.ts import only types", () => {
    for (const file of ["theme.ts", "templates.ts", "slotCopy.ts"]) {
      const src = source(`src/lib/ads/${file}`);
      for (const line of src.split("\n").filter((l) => /^\s*import\s/.test(l))) {
        expect(line, `${file}: ${line}`).toMatch(/import type/);
      }
    }
  });
});

describe("⚠️ satori's constraints are enforced in code, not by memory", () => {
  it("renderSpec sets display:flex through one helper", () => {
    const src = source("src/lib/ads/render.tsx");
    expect(src).toContain('display: "flex"');
    expect(src).toContain("function pruned(");
    // The prune is what stops an explicitly-undefined style value crashing
    // satori with a message that names no property.
    expect(src.match(/pruned\(/g)!.length).toBeGreaterThanOrEqual(4);
  });

  it("no layout module reaches for a CSS custom property", () => {
    for (const file of ["layout.ts", "theme.ts", "render.tsx"]) {
      expect(source(`src/lib/ads/${file}`), file).not.toContain("var(--");
    }
  });

  it("⚠️ no module types a satori style as React.CSSProperties", () => {
    // That type accepts display:'grid', position:'fixed', float and calc() —
    // none supported, two of which throw, the rest silently doing nothing.
    for (const file of ["layout.ts", "render.tsx"]) {
      expect(source(`src/lib/ads/${file}`), file).not.toContain("CSSProperties");
    }
  });

  it("⚠️ the tick is never a typed glyph", () => {
    for (const file of readdirSync(ADS).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))) {
      expect(source(`src/lib/ads/${file}`), file).not.toContain("✓");
      expect(source(`src/lib/ads/${file}`), file).not.toContain("✔");
    }
  });
});

describe("⚠️ the figure primitives are shared, not copied", () => {
  it("the ad validator imports them rather than restating them", () => {
    const src = source("src/lib/ads/validateAdCopy.ts");
    expect(src).toContain('from "@/lib/copyFigures"');
    // A second copy of MONEY_RE is how "percentage" came to slip past the
    // messaging validator and reach a landlord's WhatsApp.
    expect(src).not.toContain("£\\s?([\\d,]");
  });

  it("⚠️ and PRICE_RE is NOT among them", () => {
    // For a cold WhatsApp any price mention is refused; for an ad the rule
    // inverts — T3's fifth angle is "plain facts, fee and what is included".
    expect(source("src/lib/ads/validateAdCopy.ts")).not.toContain("PRICE_RE");
    expect(source("src/lib/copyFigures.ts")).not.toContain("export const PRICE_RE");
  });
});

describe("⚠️ the gate is one function", () => {
  it("nothing on the ad surface re-implements the owner check", () => {
    // ⚠️ Scoped to the ad surface. `isOwnerEmail` legitimately appears in
    // /api/signup and customerEmail.ts, where it means "bypass the payment
    // wall" rather than "may reach the ad builder" — two different questions
    // that happen to read the same column.
    const offenders = grepOrEmpty([
      "-rl", "--include=*.ts", "--include=*.tsx", "-F", "isOwnerEmail", "src/lib/ads",
    ]).filter((f) => !f.endsWith("gate.ts") && !f.includes("__tests__"));
    expect(offenders).toEqual([]);

    // And every ad module that gates does so through adsEnabledFor.
    const gaters = grepOrEmpty([
      "-rl", "--include=*.ts", "--include=*.tsx", "-F", "adsEnabledFor", "src",
    ]);
    expect(gaters).toContain("src/lib/ads/gate.ts");
  });

  it("⚠️ and it does NOT gate on is_active", () => {
    // §27.3 sets that precedent and the OAuth routes follow it — but the
    // zac@stayful.co.uk row is is_active = false (§18D), so copying it here
    // would silently kill the demo this build exists to be.
    expect(source("src/lib/ads/gate.ts")).not.toContain("is_active");
  });
});

describe("⚠️ the fonts are regenerable", () => {
  it("ships the script that produced them", () => {
    const script = source("scripts/fetch-ad-fonts.mjs");
    expect(script).toContain("GPOS");
    expect(script).toContain("Mozilla/4.0");
  });

  it("every font module says it is generated", () => {
    for (const f of readdirSync(join(ADS, "fonts"))) {
      expect(readFileSync(join(ADS, "fonts", f), "utf8")).toContain("GENERATED by scripts/fetch-ad-fonts.mjs");
    }
  });
});

/**
 * ⚠️ A PROMPT CARRIES A BUSINESS'S FEE, ITS REVIEW SCORE AND WHATEVER ITS
 * OWNER TYPED INTO THE BOX. `contactValidation.ts`'s PII rule applies to a
 * model call as much as to a lookup, and a log line is the easiest way to
 * break it by accident — so this is checked on the files rather than on a
 * path, because the failure is what the code COULD log, not what it did.
 */
describe("⚠️ nothing logs a prompt or a completion", () => {
  const files = ["src/lib/ads/generate.ts", "src/lib/ads/ledger.ts"];

  it("never passes a message body or a parsed output to console", () => {
    for (const f of files) {
      const text = source(f);
      for (const line of text.split("\n")) {
        if (!line.includes("console.")) continue;
        for (const forbidden of [
          "parsed_output",
          "messages",
          "content",
          "prompt",
          "account",
          "AD_PACK",
          "rows",
          "params",
        ]) {
          expect(line, `${f}: ${line.trim()}`).not.toContain(forbidden);
        }
      }
    }
  });

  /**
   * The provider's own error object is logged, and that is deliberate: it
   * carries a status code and a request id rather than a body, and without it
   * a 401 from a stale key is indistinguishable from a timeout.
   */
  it("still logs the provider's error, so a bad key is diagnosable", () => {
    expect(source("src/lib/ads/generate.ts")).toContain("console.error(`ads/generate:");
  });

  it("stores a bounded code in the ledger, never a sentence from the model", () => {
    const text = source("src/lib/ads/generate.ts");
    // The retry's plain-English advice is built in prompts.ts and goes to the
    // model; only the code goes to the ledger.
    expect(text).toContain("rejectReason: verdict.reason");
    expect(text).not.toContain("rejectReason: verdict.detail");
  });
});

/**
 * ⚠️ THE ROUTE PERSISTS THE LEDGER, NOT THE GENERATOR. That split keeps
 * `generate.ts` pure enough to unit test — but it means a route that calls a
 * generate function and forgets `recordGenerations` silently spends the draft
 * cap's own source. Asserted on the route files once they exist; until then
 * this proves the shape the routes must follow.
 */
describe("⚠️ a generation is always recordable", () => {
  it("every generate function hands back the rows it earned", () => {
    const text = source("src/lib/ads/generate.ts");
    for (const shape of ["QuestionSet", "SimplifyResult", "CopyResult"]) {
      const block = text.slice(text.indexOf(`export type ${shape} =`));
      expect(block.slice(0, 400), shape).toContain("entries");
    }
  });

  it("the ledger is the only writer of ad_generation_requests", () => {
    const writers = grepOrEmpty([
      "-rl",
      NOT_TESTS,
      "--include=*.ts",
      "--include=*.tsx",
      "-F",
      'from("ad_generation_requests")',
      "src",
    ]);
    expect(writers).toEqual(["src/lib/ads/ledger.ts"]);
  });
});

/**
 * ⚠️ THE CACHE BREAKPOINT WAS MEASURED, NOT ASSUMED — and the thing that would
 * quietly undo it is a varying byte moving above it. Anthropic ignores a
 * breakpoint under ~1024 tokens and ignores a prefix that changed, both
 * silently, so the only tell would be a bill.
 */
describe("⚠️ the cached prefix cannot drift", () => {
  it("the pack is built from the registry, not from a per-call argument", () => {
    const text = source("src/lib/ads/prompts.ts");
    expect(text).toContain("export const AD_PACK: string = [");
    // A function taking the customer would put a varying byte above the
    // breakpoint and turn every call into a cache write.
    expect(text).not.toMatch(/function adPack\s*\(\s*\w/);
  });

  it("systemFor is the only thing that sets cache_control", () => {
    const setters = grepOrEmpty(["-rl", NOT_TESTS, "--include=*.ts", "-F", "cache_control", "src/lib/ads"]);
    expect(setters).toEqual(["src/lib/ads/prompts.ts"]);
  });
});

/**
 * ⚠️ THE ONE BUG IN THIS CHANGE THE COMPILER COULD NOT SEE.
 *
 * `answersToProfile` used to return a bare patch and now returns
 * `{ patch, refusals, notes }`. The answers route broke loudly and tsc named it.
 * The profile route did NOT: it spreads the result into a
 * `Record<string, unknown>`, which type-checks perfectly against the new shape
 * and would have written `refusals` and `notes` into `ad_profile` as keys —
 * silently, on a column every ad surface reads.
 *
 * Nothing behavioural reaches it either, so it is guarded here or not at all.
 */
describe("the profile route takes the patch, not the whole mapping", () => {
  const route = source("src/app/api/customer/ads/profile/route.ts");

  it("never spreads answersToProfile directly", () => {
    expect(route).not.toMatch(/\.\.\.\s*answersToProfile\(/);
  });

  it("names .patch explicitly", () => {
    expect(route).toMatch(/answersToProfile\([^)]*\)/);
    expect(route).toMatch(/\.\.\.\s*mapping\.patch/);
  });

  it("hands the refusals back to the caller", () => {
    // A refusal the operator is never shown is the silence this replaced.
    expect(route).toMatch(/refused:\s*mapping\.refusals/);
  });
});

/**
 * ⚠️ A DECLINED COERCION MUST RECORD WHY. `put` is the only place that decides,
 * and a `put` that dropped the refusal would restore the original failure — an
 * answer given, binned, and then reported missing — with every behavioural test
 * still green for the slots that happen to parse.
 */
describe("no coercion fails in silence", () => {
  const profile = source("src/lib/ads/profile.ts");

  it("put records a refusal on the undefined branch", () => {
    // ⚠️ ANCHORED ON CODE, NOT ON A COMMENT. The first version of this sliced
    // up to "// Array.from" — which `source()` has already stripped — so
    // indexOf returned -1, the slice ran to the end of the file, and it passed
    // on the landing_url branch's own push while `put` recorded nothing. A
    // mutation run caught it; nothing else would have. SEVENTH time this repo
    // has recorded that shape — §50.9 holds two of them, then §53, §55, §57 and
    // §65's own.
    const from = profile.indexOf("const put =");
    const to = profile.indexOf("for (const [slot, raw]");
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    expect(profile.slice(from, to)).toMatch(/refusals\.push\(/);
  });

  it("the landing_url branch uses the verdict's own reason", () => {
    // Flattening every URL failure to "unreadable" loses the three different
    // things that need saying: a scheme, a credential, a sentence.
    expect(profile).toMatch(/reason:\s*verdict\.reason/);
  });

  it("asUrl is gone, so there is one URL rule", () => {
    expect(profile).not.toMatch(/function asUrl\b/);
  });
});

/**
 * ⚠️ BOTH RUNGS, OR THE BUG COMES BACK ON THE ONE IT HAPPENED ON.
 *
 * The production failure was on the SIMPLIFY rung — the operator tapped "Not
 * sure what this means?" and the reworded question offered an answer the schema
 * could not keep. Filtering only the first rung would leave that path exactly as
 * it was, and no behavioural test reaches it without a live model.
 */
describe("the model's options are filtered on every rung", () => {
  const gen = source("src/lib/ads/generate.ts");

  it("filters the question set", () => {
    expect(gen).toMatch(/answerableQuestions\(\s*parsed\.questions/);
  });

  it("filters a simplified question", () => {
    expect(gen).toMatch(/answerableQuestion\(/);
  });

  it("is the only place that normalises them, so there is no third rung", () => {
    // schemas.ts is where `normaliseSimplified` is DEFINED, so it matches its
    // own name — the assertion is about who CALLS it. A second caller is a rung
    // the filter above does not cover.
    const callers = grepOrEmpty([
      "-rl", "--include=*.ts", NOT_TESTS, "-F", "normaliseSimplified(", "src/lib/ads", "src/app",
    ]).filter((f) => f !== "src/lib/ads/schemas.ts");
    expect(callers).toEqual(["src/lib/ads/generate.ts"]);
  });
});

// ---------------------------------------------------------------------------
// ⚠️ Five variants, and the model writing the image lines
// ---------------------------------------------------------------------------

/**
 * ⚠️ THE RULE THIS PR EXISTS FOR, AND IT IS STRUCTURAL RATHER THAN BEHAVIOURAL:
 * IF THE MODEL DID NOT WRITE IT, IT IS NOT AN AD.
 *
 * The ad the owner judged as terrible contained no model output at all.
 * Production's ledger shows both calls recording `not_configured` — the key was
 * unset on that deployment — and the stored copy byte-identical to T7's three
 * `default*` fields, with `aiNotice` ("the words were drafted by AI from what
 * you told us") rendered over it, and `model_id` stamped on the row.
 *
 * So the three fields are gone, and so is every path that could reinstate them.
 */
describe("⚠️ canned text can never be stored as an ad", () => {
  it("no template carries a default primary text, headline or description", () => {
    const t = source("src/lib/ads/templates.ts");
    for (const field of ["defaultPrimaryText", "defaultHeadline", "defaultDescription"]) {
      expect(t, field).not.toContain(`${field}:`);
    }
  });

  it("nothing outside templates.ts's own tombstone comment names one", () => {
    // templates.ts explains why they are gone, and `source()` strips comments —
    // so it is the file that must not name them in CODE, checked above.
    expect(
      grepOrEmpty([
        "-rl", "--include=*.ts", "--include=*.tsx", NOT_TESTS,
        "-E", "default(PrimaryText|Headline|Description)", "src",
      ])
    ).toEqual(["src/lib/ads/templates.ts"]);
  });

  it("⚠️ generate.ts has no fallback copy builder at all", () => {
    const g = source("src/lib/ads/generate.ts");
    expect(g).not.toContain("defaultCopyFor");
    // The one shape it may return on failure carries no copy.
    expect(g).toContain('reason: "not_configured"');
    expect(g).toContain('reason: "rejected"');
  });

  /**
   * ⚠️ `finishDraft` IS WHAT STAMPS `model_id`. Reaching it on a failed
   * generation is how the record came to name a model beside words it never
   * produced — so the failure path must return BEFORE it, and release the
   * draft rather than failing it, so the answers survive for a retry.
   */
  it("writeAd returns before finishDraft when nothing was written", () => {
    const w = source("src/lib/ads/writeAd.ts");
    const guard = w.indexOf("if (!result.ok)");
    const finish = w.indexOf("finishDraft(admin, draft.id");
    expect(guard).toBeGreaterThan(-1);
    expect(finish).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(finish);
    expect(w).toContain('return { ok: false, reason: "not_written"');
    // Released to `collecting`, so Retry costs the operator nothing but the wait.
    expect(w.slice(guard, finish)).toContain('releaseClaim(admin, draft.id, "collecting")');
  });

  /**
   * ⚠️ AND THE LEDGER IS WRITTEN ON BOTH PATHS. A generation that cost two model
   * calls and produced nothing is exactly the run somebody comes looking for,
   * and it used to be recorded only where copy was stored.
   */
  it("records the generations before it decides whether there is an ad", () => {
    const w = source("src/lib/ads/writeAd.ts");
    expect(w.indexOf("recordGenerations")).toBeLessThan(w.indexOf("if (!result.ok)"));
  });

  /**
   * ⚠️ THE CONDITION, NOT THE SYMBOL. The first version of this asserted that
   * `AD_COPY.result.someAngles` appeared in the file — and a mutation replacing
   * the condition with `false` left the symbol sitting inside a dead branch and
   * survived the whole suite. That is the shape CLAUDE.md has now recorded
   * eight times: a test that matches a name rather than the thing the name is
   * guarded by.
   */
  it("⚠️ the chat shows the AI notice only over model-written words", () => {
    const c = source("src/components/dashboard/ads/AdChat.tsx");
    expect(c).toContain("const provenance = copy.provenance ?? null;");
    expect(c).toContain("provenance && provenance.written < provenance.offered");
    expect(c).toContain('provenance?.image === "example"');
    expect(c).toContain("AD_COPY.result.someAngles(provenance.written, provenance.offered)");
    expect(c).toContain("AD_COPY.result.imageFromTemplate");
  });

  /**
   * ⚠️ `provenance` IS STORED IN `copy`, NOT RETURNED IN A ROUTE'S BODY. The
   * chat renders from the server-rendered `draft.copy`, so anything handed back
   * in JSON is gone the moment `router.refresh()` runs — which is what happened
   * to `degraded`, returned by three routes and read by none.
   */
  /**
   * ⚠️ NO ROUTE HANDS BACK A `degraded` FLAG, ON EITHER PATH. It was returned by
   * three of them and read by none — and it could not have been read, because
   * both the create and switch routes navigate and re-render from the row.
   *
   * The copy path stores `provenance` inside `copy`; the questions path folds
   * its sentence into `template_reason`, which was already stored and already
   * rendered. Both survive a `router.refresh()`, which is the whole test.
   */
  it("no route hands back a degraded flag any more", () => {
    for (const f of grepOrEmpty([
      "-rl", "--include=*.ts", NOT_TESTS, "-F", "degraded", "src/app/api/customer/ads",
    ])) {
      expect(source(f), f).not.toMatch(/degraded:\s*(set|result)/);
    }
    expect(source("src/lib/ads/metaFields.ts")).toContain("provenance");
    expect(source("src/app/api/customer/ads/route.ts")).toContain("AD_COPY.chat.standardQuestions");
    expect(source("src/app/api/customer/ads/[id]/template/route.ts")).toContain(
      "AD_COPY.chat.standardQuestions"
    );
  });
});

describe("⚠️ the retry asks only for the angles it lost", () => {
  it("filters the offered list by what survived", () => {
    const g = source("src/lib/ads/generate.ts");
    expect(g).toContain("wanted = offered.filter");
    expect(g).toContain("copyMaxTokens(wanted.length)");
    // The rejection reaches the prompt per angle, not as one response-level code.
    expect(g).toContain("rejected: attempt === 1 ? null : rejected");
  });

  it("the prompt names the angle beside the reason", () => {
    const p = source("src/lib/ads/prompts.ts");
    expect(p).toContain("r.angleKey");
    expect(p).toContain("rejectionAdvice(r.reason)");
  });

  /**
   * ⚠️ NEVER A REGEX SOURCE IN A PROMPT. Four rejection codes used to hand the
   * retry a truncated regular expression as an explanation of what it had done
   * wrong — `(\b(?:earn|make|generate|bring in|take) (?:up)`. A model given that
   * writes the same sentence again with different adjectives.
   */
  it("the detail is a matched span, never re.source", () => {
    const v = source("src/lib/ads/validateAdCopy.ts");
    expect(v).not.toContain("re.source");
    expect(v).toContain("m[0].trim().slice(0, 60)");
  });
});

describe("⚠️ the image is bounded because the canvas is", () => {
  it("the validator checks both the length and the charset", () => {
    const v = source("src/lib/ads/validateAdCopy.ts");
    expect(v).toContain("AD_IMAGE_MAX.headline");
    expect(v).toContain("AD_IMAGE_MAX.sub");
    expect(v).toContain("AD_IMAGE_CHARSET.test");
  });

  /**
   * ⚠️ THE RENDER DRAWS WHAT WAS STORED, NOT THE TEMPLATE'S EXAMPLE. Falling
   * back here would draw a different card from the one the chat showed, on the
   * same draft, with nothing saying which.
   */
  it("the render route draws the stored lines", () => {
    const r = source("src/app/api/customer/ads/[id]/render/route.ts");
    expect(r).toContain("headline: draft.copy.image.headline");
    expect(r).toContain("sub: draft.copy.image.sub");
    expect(r).not.toContain("ctx.example");
  });
});

/**
 * ⚠️ `located_without_targeting` WAS A VALIDATOR RULE READING NOTHING THE MODEL
 * WROTE, so it failed both paid attempts identically and guaranteed the canned
 * text — for anybody whose lead filter is off, which is most of the book.
 */
describe("⚠️ a model-independent condition is not a validator rule", () => {
  it("the validator no longer knows about targeting at all", () => {
    const v = source("src/lib/ads/validateAdCopy.ts");
    expect(v).not.toContain("located_without_targeting");
    expect(v).not.toContain("targeting.kind");
  });

  it("it is a warning the operator can read, with a sentence for it", () => {
    expect(source("src/lib/ads/resolveSlots.ts")).toContain('warnings.push("located_without_targeting")');
    expect(source("src/lib/ads/slotCopy.ts")).toContain("located_without_targeting:");
  });
});

/**
 * ⚠️ THE PROMPT AND THE VALIDATOR MUST NOT CONTRADICT EACH OTHER. `brief.ts`
 * handed the model a bare "15% of gross" and told it to state the fee "exactly
 * that way"; `fee_without_vat_treatment` then rejected exactly that. The
 * customer most likely to hit it was the one who had bothered to publish a fee.
 */
describe("⚠️ no fee phrase is offered that the validator refuses", () => {
  it("feePhrase withholds a fee with no VAT treatment recorded", () => {
    expect(source("src/lib/ads/resolveSlots.ts")).toContain("if (!p.fee_vat) return null;");
  });
});
