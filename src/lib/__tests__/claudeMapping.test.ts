import { describe, expect, it } from "vitest";
import { mappingNeedsHelp, validateMappingResponse } from "../claudeMapping";
import type { ColumnMapping } from "../leadImport";

const HEADERS = ["Name", "Email", "Phone"];

describe("validateMappingResponse", () => {
  it("accepts a well-formed proposal", () => {
    const out = validateMappingResponse(
      {
        header_row_index: 0,
        columns: [
          { index: 0, target: "name", confidence: 0.9 },
          { index: 1, target: "email", confidence: 0.95 },
          { index: 2, target: "phone", confidence: 0.9 },
        ],
      },
      HEADERS
    );
    expect(out?.headerRowIndex).toBe(0);
    expect(out?.columns.map((c) => c.target)).toEqual(["name", "email", "phone"]);
    // The header text comes from OUR parse, never from the model.
    expect(out?.columns.map((c) => c.header)).toEqual(HEADERS);
  });

  it("drops a hallucinated field name rather than trusting it", () => {
    const out = validateMappingResponse(
      {
        header_row_index: 0,
        columns: [
          { index: 0, target: "landlord_mobile", confidence: 0.99 },
          { index: 1, target: "email", confidence: 0.9 },
        ],
      },
      HEADERS
    );
    expect(out?.columns[0].target).toBe("ignore");
    expect(out?.columns[1].target).toBe("email");
  });

  it("drops a column index that is off the end of the real sheet", () => {
    const out = validateMappingResponse(
      {
        header_row_index: 0,
        columns: [
          { index: 0, target: "name", confidence: 0.9 },
          { index: 99, target: "phone", confidence: 0.9 },
        ],
      },
      HEADERS
    );
    expect(out?.columns).toHaveLength(3);
    expect(out?.columns.some((c) => c.target === "phone")).toBe(false);
  });

  it("clamps confidence into 0..1", () => {
    const out = validateMappingResponse(
      { header_row_index: 0, columns: [{ index: 0, target: "name", confidence: 7 }] },
      HEADERS
    );
    expect(out?.columns[0].confidence).toBe(1);

    const low = validateMappingResponse(
      { header_row_index: 0, columns: [{ index: 0, target: "name", confidence: -3 }] },
      HEADERS
    );
    expect(low?.columns[0].confidence).toBe(0);
  });

  it("leaves an unmentioned column as ignore instead of shifting the others", () => {
    const out = validateMappingResponse(
      { header_row_index: 0, columns: [{ index: 2, target: "phone", confidence: 0.9 }] },
      HEADERS
    );
    expect(out?.columns.map((c) => c.target)).toEqual(["ignore", "ignore", "phone"]);
  });

  it("enforces the single-claim rule even when the model ignores it", () => {
    const out = validateMappingResponse(
      {
        header_row_index: 0,
        columns: [
          { index: 0, target: "phone", confidence: 0.6 },
          { index: 2, target: "phone", confidence: 0.95 },
        ],
      },
      HEADERS
    );
    const phones = out?.columns.filter((c) => c.target === "phone") ?? [];
    expect(phones).toHaveLength(1);
    expect(phones[0].index).toBe(2);
  });

  it("returns null for junk so the caller falls back", () => {
    expect(validateMappingResponse(null, HEADERS)).toBeNull();
    expect(validateMappingResponse("not json", HEADERS)).toBeNull();
    expect(validateMappingResponse({}, HEADERS)).toBeNull();
    expect(validateMappingResponse({ columns: "nope" }, HEADERS)).toBeNull();
    // Every entry invalid means nothing usable came back.
    expect(
      validateMappingResponse({ columns: [{ index: 50, target: "name" }] }, HEADERS)
    ).toBeNull();
  });

  it("treats a missing header_row_index as null rather than 0", () => {
    const out = validateMappingResponse(
      { columns: [{ index: 0, target: "name", confidence: 0.9 }] },
      HEADERS
    );
    expect(out?.headerRowIndex).toBeNull();
  });
});

describe("mappingNeedsHelp", () => {
  const confident = (targets: ColumnMapping["target"][]): ColumnMapping[] =>
    targets.map((target, index) => ({
      index,
      header: HEADERS[index] ?? `Column ${index}`,
      target,
      confidence: 0.95,
    }));

  it("does not call the model for a clean, fully-resolved sheet", () => {
    expect(
      mappingNeedsHelp(confident(["name", "email", "phone"]), 0, [["a", "b", "c"]])
    ).toBe(false);
  });

  it("asks for help when a populated column could not be placed", () => {
    const cols = confident(["name", "email", "phone"]);
    cols[2] = { ...cols[2], target: "ignore", confidence: 0.2 };
    expect(mappingNeedsHelp(cols, 0, [["Jane", "j@e.com", "something odd"]])).toBe(true);
  });

  it("ignores an unplaced column that is entirely empty", () => {
    const cols = confident(["name", "email", "phone"]);
    cols[2] = { ...cols[2], target: "ignore", confidence: 0.2 };
    expect(mappingNeedsHelp(cols, 0, [["Jane", "j@e.com", "   "]])).toBe(false);
  });

  it("always asks for help when no header row was found", () => {
    expect(
      mappingNeedsHelp(confident(["name", "email", "phone"]), null, [["a", "b", "c"]])
    ).toBe(true);
  });
});
