/**
 * Derives the feedback system's CLAUDE.md index from CLAUDE.md itself.
 *
 * WHY GENERATE RATHER THAN READ AT RUNTIME: CLAUDE.md sits at the repo root and
 * is not traced into the Vercel serverless bundle, so a readFileSync at request
 * time works locally and returns ENOENT in production. Generating a committed
 * .ts file puts the content in the bundle by ordinary import.
 *
 * WHY GENERATE RATHER THAN HAND-MAINTAIN: the whole point of the context pack
 * is that it stays true as the app changes. `sectionIndex.test.ts` re-runs this
 * derivation and fails if the committed file has drifted, and `npm run build`
 * runs vitest first — so a new CLAUDE.md section cannot ship with a stale index.
 *
 * Usage: node scripts/generate-section-index.mjs [--check]
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const OUT = join(ROOT, "src/lib/feedback/sectionIndex.ts");

/** `## 37. The operator's own branding *(0112)*` → {n, title, migrations}. */
function sections(md) {
  const out = [];
  for (const line of md.split("\n")) {
    const m = /^## (\d+)\.\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const [, n, rest] = m;
    // The marker is USUALLY trailing but not always: §7 reads
    // "Soft reclaim *(0046)* — SUPERSEDED by §18". Match it anywhere.
    const mig = /\*\((.+?)\)\*/.exec(rest);
    out.push({
      n: Number(n),
      title: rest.replace(/\s*\*\(.+?\)\*/, " ").replace(/\s+/g, " ").trim(),
      migrations: mig ? mig[1] : null,
    });
  }
  return out;
}

/** The body of one `## N.` section, verbatim, heading and trailing rule removed. */
function body(md, n) {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^## ${n}\\.\\s`).test(l));
  if (start === -1) throw new Error(`CLAUDE.md has no section ${n}`);
  let end = start + 1;
  while (end < lines.length && !/^## /.test(lines[end])) end++;
  return lines
    .slice(start + 1, end)
    .join("\n")
    .replace(/\n*---\n*$/, "")
    .trim();
}

/** Top-level bullets of a section, flattened to one line each. */
function bullets(md, n, cap = 200) {
  const out = [];
  let current = null;
  for (const line of body(md, n).split("\n")) {
    if (/^- /.test(line)) {
      if (current) out.push(current);
      current = line.slice(2);
    } else if (current !== null && /^\s+\S/.test(line)) {
      current += " " + line.trim();
    } else if (current) {
      out.push(current);
      current = null;
    }
  }
  if (current) out.push(current);
  return out.map((b) => {
    const flat = b.replace(/\s+/g, " ").replace(/\*\*/g, "").replace(/`/g, "").trim();
    return flat.length > cap ? flat.slice(0, cap - 1).trimEnd() + "…" : flat;
  });
}

/**
 * The highest committed migration, and therefore the next free number.
 *
 * Read from the directory rather than from CLAUDE.md: a migration exists the
 * moment its file does, and 0100a (§36.8) proves the numbering is not always
 * what the prose says. The trailing-letter form sorts as its own number.
 */
function migrations(root) {
  const nums = readdirSync(join(root, "supabase/migrations"))
    .map((f) => /^(\d{4})[a-z]?_/.exec(f))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  const latest = Math.max(...nums);
  return { latest, next: String(latest + 1).padStart(4, "0") };
}

function render(md) {
  const q = (s) => JSON.stringify(s);
  const list = sections(md)
    .map((s) => `  { n: ${s.n}, title: ${q(s.title)}, migrations: ${s.migrations ? q(s.migrations) : "null"} },`)
    .join("\n");
  const bl = (n) => bullets(md, n).map((b) => `  ${q(b)},`).join("\n");
  const mig = migrations(ROOT);
  return `// GENERATED FILE — DO NOT EDIT BY HAND.
// Run \`npm run gen:context\` after changing CLAUDE.md.
// \`sectionIndex.test.ts\` fails the build if this has drifted.

export type ClaudeSection = { n: number; title: string; migrations: string | null };

/** Every \`## N.\` heading in CLAUDE.md, with the migrations it names. */
export const CLAUDE_SECTIONS: ClaudeSection[] = [
${list}
];

/**
 * §9 verbatim. The highest-value few hundred words in the repository for this
 * purpose: it is the list of things that LOOK like bugs and are not. Without it
 * in front of a model, "reject does not refund" reads as a billing fault and
 * gets helpfully fixed.
 */
export const INVARIANTS = ${q(body(md, 9))};

/** §11, one line per entry. */
export const KNOWN_ISSUES: string[] = [
${bl(11)}
];

/** §12, one line per entry. A feature request matching one of these is a decision, not a build. */
export const DEFERRED: string[] = [
${bl(12)}
];

/** Highest committed migration, from the directory rather than the prose. */
export const LATEST_MIGRATION = ${mig.latest};

/** The number a new migration must take. Migrations deploy BEFORE the code that reads them. */
export const NEXT_MIGRATION = ${q(mig.next)};
`;
}

const md = readFileSync(join(ROOT, "CLAUDE.md"), "utf8");
const next = render(md);

if (process.argv.includes("--check")) {
  const current = readFileSync(OUT, "utf8");
  if (current !== next) {
    console.error("sectionIndex.ts is stale. Run: npm run gen:context");
    process.exit(1);
  }
  console.log("sectionIndex.ts is current.");
} else {
  writeFileSync(OUT, next);
  console.log(`wrote ${OUT}`);
}
