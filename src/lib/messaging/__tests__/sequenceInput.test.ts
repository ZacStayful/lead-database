/**
 * What an operator is allowed to build.
 *
 * The limits are about the LANDLORD, not about us. Six steps three days apart
 * is a fortnight of being messaged by a stranger who has not replied once; past
 * that, chasing stops being follow-up and starts being the behaviour that gets
 * a number reported — and the number is the operator's own.
 */
import { describe, it, expect } from "vitest";
import { validateSequenceInput, MAX_STEPS, MAX_DELAY_DAYS } from "../sequenceInput";

const ok = (steps: { delay_days: number; brief?: string | null }[]) =>
  validateSequenceInput({ name: "Chase", steps });

describe("validateSequenceInput", () => {
  it("accepts a plain three-step ladder", () => {
    const v = ok([{ delay_days: 0 }, { delay_days: 3 }, { delay_days: 5 }]);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.steps.map((s) => s.delay_days)).toEqual([0, 3, 5]);
  });

  it("allows the FIRST step to be zero — the 'as soon as it is assigned' case", () => {
    expect(ok([{ delay_days: 0 }]).ok).toBe(true);
  });

  it("refuses a zero delay on any LATER step, which would be a burst", () => {
    const v = ok([{ delay_days: 0 }, { delay_days: 0 }]);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/at least a day/i);
  });

  it("refuses more than the maximum number of steps", () => {
    const v = ok(Array.from({ length: MAX_STEPS + 1 }, () => ({ delay_days: 3 })));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain(String(MAX_STEPS));
  });

  it("accepts exactly the maximum", () => {
    expect(ok(Array.from({ length: MAX_STEPS }, () => ({ delay_days: 3 }))).ok).toBe(true);
  });

  it("refuses a gap longer than the ceiling", () => {
    expect(ok([{ delay_days: 0 }, { delay_days: MAX_DELAY_DAYS + 1 }]).ok).toBe(false);
    expect(ok([{ delay_days: 0 }, { delay_days: MAX_DELAY_DAYS }]).ok).toBe(true);
  });

  it("refuses a fractional or non-numeric delay rather than rounding it", () => {
    expect(ok([{ delay_days: 1.5 }]).ok).toBe(false);
    expect(validateSequenceInput({ name: "x", steps: [{ delay_days: "soon" }] }).ok).toBe(false);
  });

  it("refuses a negative first step", () => {
    expect(ok([{ delay_days: -1 }]).ok).toBe(false);
  });

  it("refuses an empty ladder — a sequence that sends nothing", () => {
    expect(validateSequenceInput({ name: "Chase", steps: [] }).ok).toBe(false);
    expect(validateSequenceInput({ name: "Chase" }).ok).toBe(false);
  });

  it("requires a name", () => {
    expect(validateSequenceInput({ name: "   ", steps: [{ delay_days: 0 }] }).ok).toBe(false);
  });

  it("trims a brief to null rather than storing whitespace", () => {
    const v = ok([{ delay_days: 0, brief: "   " }]);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.steps[0].brief).toBeNull();
  });

  it("truncates an over-long brief instead of refusing the whole ladder", () => {
    const v = ok([{ delay_days: 0, brief: "x".repeat(1000) }]);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.steps[0].brief!.length).toBe(200);
  });
});
