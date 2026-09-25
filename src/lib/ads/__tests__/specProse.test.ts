import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { AD_SPEC_PROSE } from "../specProse";
import { AD_TEMPLATES } from "../templates";

/**
 * ⚠️ THE ANTI-STALENESS GUARD, AND THE REASON THE PROSE CAN BE TRUSTED AS THE
 * SPEC'S WORDS RATHER THAN SOMEBODY'S RECOLLECTION OF THEM.
 *
 * `specProse.ts` is generated from `docs/landlord-ad-template-pack-v1.md` and
 * committed, because docs/ is not traced into the Vercel bundle and a
 * readFileSync at request time works locally and throws ENOENT in production
 * (§50.5). A committed derivative rots silently, so this re-runs the derivation
 * and fails if the two have parted.
 *
 * §42.8's lesson: it shells out to the REAL generator rather than restating its
 * parsing. A test that reimplements the thing it checks asserts a version that
 * was never the one running.
 */
describe("the spec prose", () => {
  it("matches the spec document", () => {
    expect(() =>
      execFileSync("node", ["scripts/generate-ad-spec-prose.mjs", "--check"], {
        cwd: process.cwd(),
        stdio: "pipe",
      })
    ).not.toThrow();
  });

  /**
   * ⚠️ A `--check` THAT WRITES INSTEAD OF COMPARING PASSES ITS OWN TEST.
   *
   * Mutating the branch to `if (false)` makes `--check` fall through to
   * `writeFileSync`, which — against an already-current file — produces
   * identical bytes and exits 0. The behavioural assertion above cannot tell
   * the two apart, so the branch itself is asserted: it compares, it exits
   * non-zero, and it does not write. `sectionIndex.test.ts` has the same
   * latent weakness and the same fix would apply there.
   */
  it("⚠️ the --check branch compares and exits, it does not write", () => {
    const script = readFileSync("scripts/generate-ad-spec-prose.mjs", "utf8");
    const start = script.indexOf('if (process.argv.includes("--check"))');
    expect(start).toBeGreaterThan(-1);
    const branch = script.slice(start, script.indexOf("} else {", start));
    expect(branch).toContain("current !== next");
    expect(branch).toContain("process.exit(1)");
    expect(branch).not.toContain("writeFileSync");
  });

  it("covers every shipped template and nothing else", () => {
    expect(Object.keys(AD_SPEC_PROSE).sort()).toEqual(AD_TEMPLATES.map((t) => t.id).sort());
  });

  /**
   * ⚠️ A PARSER THAT SILENTLY MATCHED NOTHING WOULD EMIT AN EMPTY STRING, and an
   * empty rationale is exactly the silent degradation this feature replaces:
   * the model would go back to reading a bullet list and nobody would know.
   */
  it("found real paragraphs, not empty strings", () => {
    for (const [id, text] of Object.entries(AD_SPEC_PROSE)) {
      expect(text.length, id).toBeGreaterThan(200);
      expect(text, id).toContain("What this template must never do:");
    }
  });

  /**
   * ⚠️ VERBATIM, ASSERTED AGAINST THE DOCUMENT RATHER THAN AGAINST ITSELF.
   * §65 records four errors that came from paraphrasing this spec, one of which
   * would have published a false AI-disclosure value on a live ad.
   */
  it("quotes the document word for word", () => {
    const md = readFileSync("docs/landlord-ad-template-pack-v1.md", "utf8");
    for (const [id, text] of Object.entries(AD_SPEC_PROSE)) {
      for (const para of text.split("\n\n")) {
        const quoted = para.replace(/^What this template must never do: /, "");
        expect(md, `${id}: ${quoted.slice(0, 40)}`).toContain(quoted);
      }
    }
  });

  /**
   * ⚠️ THE RATIONALE, NOT THE WHOLE SECTION. "Static layout" and "Video"
   * describe artwork the model does not draw, and the field table restates
   * inputs the brief already carries — ~400 tokens a call to say it twice.
   */
  it("leaves out the artwork and the field table", () => {
    for (const [id, text] of Object.entries(AD_SPEC_PROSE)) {
      expect(text, id).not.toContain("| Field |");
      expect(text, id).not.toContain("Static layout");
      expect(text, id).not.toContain("### Video");
      expect(text, id).not.toContain("**Hook**");
    }
  });

  it("stays small enough to send uncached on every copy call", () => {
    // A pessimistic five characters to the token, the same floor `AD_PACK` uses.
    for (const [id, text] of Object.entries(AD_SPEC_PROSE)) {
      expect(Math.floor(text.length / 5), id).toBeLessThan(400);
    }
  });
});
