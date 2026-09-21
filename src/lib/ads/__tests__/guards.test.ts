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
  const IMPORT_FREE = ["copy.ts", "storagePaths.ts", "emphasis.ts", "metaFields.ts"];

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
