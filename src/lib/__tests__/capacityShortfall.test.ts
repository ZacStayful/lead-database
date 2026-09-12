import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { oversupplyShortfall, type ProductCapacity } from "../serviceHealth";

const ROOT = join(__dirname, "..", "..", "..");
const PANEL = "src/components/admin/ServiceHealthPanel.tsx";

/** Comments stripped and whitespace collapsed — §46 and §51.11's lesson. */
function code(path: string): string {
  return readFileSync(join(ROOT, path), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s+/g, " ");
}

const at = (demand: number, slots: number) =>
  ({ demandPerMonth: demand, slotsPerMonth: slots }) as ProductCapacity;

describe("oversupplyShortfall", () => {
  // ⚠️ The case that was live on /admin: 250 − 248.6 is 1.4000000000000057.
  it("does not print a floating-point tail", () => {
    expect(oversupplyShortfall(at(250, 248.6))).toBe(1.4);
    expect(String(oversupplyShortfall(at(250, 248.6)))).toBe("1.4");
  });

  it("leaves a whole number whole", () => {
    expect(String(oversupplyShortfall(at(260, 248))).includes(".")).toBe(false);
  });

  // The smallest difference that can reach the sentence: the panel renders it
  // only when `borrowingFromInventory`, i.e. demand > slots, and slots carries
  // one decimal place. So rounding to 1dp can never yield a bare "0".
  it("survives the smallest difference that reaches the sentence", () => {
    expect(oversupplyShortfall(at(249, 248.9))).toBe(0.1);
    expect(oversupplyShortfall(at(249, 248.9))).toBeGreaterThan(0);
  });

  it("is zero or below when nothing is promised over the supply", () => {
    expect(oversupplyShortfall(at(200, 248.6))).toBeLessThan(0);
    expect(oversupplyShortfall(at(248.6, 248.6))).toBe(0);
  });
});

describe("the panel", () => {
  // ⚠️ Every other figure on that panel is rounded by get_service_capacity
  // before it leaves Postgres. This one is subtracted afterwards, so it is the
  // only place the tail can appear — and an inline subtraction brings it back.
  it("uses the helper rather than subtracting inline", () => {
    const src = code(PANEL);
    expect(src).toContain("const short = oversupplyShortfall(c);");
    expect(src).not.toContain("c.demandPerMonth - c.slotsPerMonth");
  });
});
