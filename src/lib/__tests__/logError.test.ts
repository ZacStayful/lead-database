import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describeError } from "@/lib/logError";

/**
 * The line that prompted this was `{ message: '' }` from a head:true count —
 * see logError.ts for why the object really is empty rather than badly
 * serialised, and why the HTTP status is the only thing worth recovering.
 */
describe("describeError", () => {
  it("⚠️ never returns an empty string", () => {
    const shapes: unknown[] = [
      null,
      undefined,
      "",
      "   ",
      {},
      { message: "" },
      { message: "   ", code: "", details: null, hint: undefined },
      new Error(""),
      0,
      false,
      [],
    ];
    for (const s of shapes) {
      expect(describeError(s).trim(), JSON.stringify(s)).not.toBe("");
      expect(describeError(s, 503).trim(), JSON.stringify(s)).not.toBe("");
    }
  });

  it("⚠️ explains the empty head-count error instead of printing nothing", () => {
    const msg = describeError({ message: "" }, 503);
    expect(msg).toContain("HTTP 503");
    expect(msg).toContain("head:true");
    expect(msg).toContain("no body");
  });

  it("still explains it when there is no status to report", () => {
    expect(describeError({ message: "" })).toContain("head:true");
  });

  it("keeps a real Postgrest error whole", () => {
    const msg = describeError({
      message: 'column "nope" does not exist',
      code: "42703",
      details: "some detail",
      hint: "try a different column",
    });
    expect(msg).toContain("42703");
    expect(msg).toContain('column "nope" does not exist');
    expect(msg).toContain("some detail");
    expect(msg).toContain("try a different column");
  });

  it("does not bury a real message under the status", () => {
    // A status alongside a real reason is supporting detail, not the headline.
    const msg = describeError({ message: "permission denied", code: "42501" }, 403);
    expect(msg.indexOf("permission denied")).toBeLessThan(msg.indexOf("HTTP 403"));
  });

  it("reads an Error's name and message, and survives a bare one", () => {
    expect(describeError(new TypeError("boom"))).toBe("TypeError: boom");
    expect(describeError(new Error(""))).toBe("Error");
  });

  it("passes a plain string through", () => {
    expect(describeError("fetch failed")).toBe("fetch failed");
  });

  it("ignores a status that is not one", () => {
    // `status` is 0 on an aborted request — postgrest-js says so itself, and
    // "HTTP 0" reads as a real code.
    expect(describeError({ message: "x" }, 0)).toBe("x");
    expect(describeError({ message: "" }, 0)).not.toContain("HTTP");
  });

  it("handles a partial error without inventing the missing parts", () => {
    expect(describeError({ code: "PGRST301" })).toBe("PGRST301");
    expect(describeError({ message: "just this" })).toBe("just this");
  });
});

/**
 * ⚠️ A repo-wide guard rather than five named files, because the defect is a
 * PROPERTY of the pattern: any `head: true` count whose failure is logged
 * prints `{ message: '' }` unless the status is carried across with it. A new
 * one added tomorrow has the same hole, and naming today's five would not
 * catch it.
 */
describe("every logged head:true count carries its status", () => {
  const SRC = resolve(__dirname, "..", "..");

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") walk(p, out);
      } else if (/\.tsx?$/.test(entry.name)) {
        out.push(p);
      }
    }
    return out;
  }

  /** Sites where a `head: true` count's error reaches a console call. */
  function loggedHeadCounts(): Array<{ file: string; logLine: string }> {
    const found: Array<{ file: string; logLine: string }> = [];
    for (const file of walk(SRC)) {
      const src = readFileSync(file, "utf8");
      if (!src.includes("head: true")) continue;
      let from = 0;
      for (;;) {
        const at = src.indexOf("head: true", from);
        if (at < 0) break;
        from = at + 10;
        const before = src.slice(Math.max(0, at - 400), at);
        const after = src.slice(at, at + 900);
        const re = /const\s*\{([^}]*)\}\s*=\s*await/g;
        let destructured: string | null = null;
        for (let m = re.exec(before); m; m = re.exec(before)) destructured = m[1];
        if (destructured === null) continue;
        const errName = destructured
          .split(",")
          .map((t: string) => t.trim())
          .filter((t: string) => /error/i.test(t))
          .map((t: string) => t.split(":").pop()!.trim())[0];
        if (!errName) continue;
        const log = new RegExp(
          `console\\.(?:error|warn)\\([^;]*${errName}[^;]*\\)`,
          "s"
        ).exec(after);
        if (log) found.push({ file: file.slice(SRC.length + 1), logLine: log[0] });
      }
    }
    return found;
  }

  it("finds the sites at all — the scanner is not silently matching nothing", () => {
    // Without this, deleting describeError everywhere would pass the next test
    // by finding zero sites to check. (§50.9 — a guard that cannot fail.)
    expect(loggedHeadCounts().length).toBeGreaterThanOrEqual(5);
  });

  it("⚠️ each one passes the status, or the line reads `{ message: '' }`", () => {
    const offenders = loggedHeadCounts().filter(
      (s) => !/describeError\(\s*\w+\s*,\s*status\s*\)/.test(s.logLine)
    );
    expect(
      offenders.map((o) => `${o.file}: ${o.logLine.replace(/\s+/g, " ")}`)
    ).toEqual([]);
  });
});
