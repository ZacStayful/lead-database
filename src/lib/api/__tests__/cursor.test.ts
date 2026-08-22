/**
 * Pagination cursors — the two failure modes here are both silent.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SORT,
  cursorFilter,
  decodeCursor,
  encodeCursor,
  isSortKey,
} from "@/lib/api/cursor";

const ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

describe("cursor round-trip", () => {
  it("preserves a microsecond timestamp exactly", () => {
    // The whole reason the cursor carries a string rather than a Date: this
    // value cannot survive `new Date(x).toISOString()`, which truncates to
    // milliseconds, and the lost precision would re-emit or skip rows assigned
    // in the same millisecond as a page boundary.
    const ts = "2026-08-02T10:00:00.123456+00:00";
    const decoded = decodeCursor(encodeCursor("assigned_at", ts, ID), "assigned_at");
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.cursor.ts).toBe(ts);
  });

  it("survives a Date round-trip losing precision, and proves it would differ", () => {
    const ts = "2026-08-02T10:00:00.123456+00:00";
    expect(new Date(ts).toISOString()).not.toBe(ts);
  });

  it("round-trips the other sort mode", () => {
    const ts = "2026-08-03T09:00:00+00:00";
    const decoded = decodeCursor(
      encodeCursor("last_status_change_at", ts, ID),
      "last_status_change_at"
    );
    expect(decoded.ok).toBe(true);
  });
});

describe("cursor rejection", () => {
  it("refuses a cursor minted under a different sort", () => {
    const issued = encodeCursor("assigned_at", "2026-08-02T10:00:00+00:00", ID);
    const decoded = decodeCursor(issued, "last_status_change_at");
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) {
      // Named explicitly, because the caller has to know to restart the walk.
      expect(decoded.reason).toContain("assigned_at");
      expect(decoded.reason).toContain("last_status_change_at");
    }
  });

  it("rejects garbage rather than throwing", () => {
    for (const bad of ["", "not-base64!!", Buffer.from("v1|assigned_at").toString("base64url")]) {
      expect(() => decodeCursor(bad, DEFAULT_SORT)).not.toThrow();
      expect(decodeCursor(bad, DEFAULT_SORT).ok).toBe(false);
    }
  });

  it("rejects a tampered id or timestamp", () => {
    const tamperedId = Buffer.from(
      "v1|assigned_at|2026-08-02T10:00:00+00:00|not-a-uuid"
    ).toString("base64url");
    expect(decodeCursor(tamperedId, "assigned_at").ok).toBe(false);

    const tamperedTs = Buffer.from(`v1|assigned_at|yesterday|${ID}`).toString(
      "base64url"
    );
    expect(decodeCursor(tamperedTs, "assigned_at").ok).toBe(false);
  });

  it("rejects an unknown version prefix", () => {
    const v2 = Buffer.from(`v2|assigned_at|2026-08-02T10:00:00+00:00|${ID}`).toString(
      "base64url"
    );
    expect(decodeCursor(v2, "assigned_at").ok).toBe(false);
  });
});

describe("cursorFilter", () => {
  it("quotes the timestamp and breaks ties on id", () => {
    const ts = "2026-08-02T10:00:00.123456+00:00";
    const filter = cursorFilter({ sort: "assigned_at", ts, id: ID });
    // Quoted: PostgREST's `or` is comma-separated and the value contains
    // `+00:00` and colons.
    expect(filter).toContain(`assigned_at.lt."${ts}"`);
    // The tiebreak is what stops a bulk assign — several rows stamped inside
    // one transaction — losing or repeating rows at a page boundary.
    expect(filter).toContain(`and(assigned_at.eq."${ts}",id.lt.${ID})`);
  });

  it("uses the column belonging to the cursor's own sort", () => {
    const filter = cursorFilter({
      sort: "last_status_change_at",
      ts: "2026-08-02T10:00:00+00:00",
      id: ID,
    });
    expect(filter).toContain("last_status_change_at.lt.");
    expect(filter).not.toContain("assigned_at");
  });
});

describe("isSortKey", () => {
  it("accepts the two modes and nothing else", () => {
    expect(isSortKey("assigned_at")).toBe(true);
    expect(isSortKey("last_status_change_at")).toBe(true);
    expect(isSortKey("price_paid")).toBe(false);
    expect(isSortKey("constructor")).toBe(false);
    expect(isSortKey(null)).toBe(false);
  });
});
