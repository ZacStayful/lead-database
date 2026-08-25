/**
 * Asking Claude what a customer's spreadsheet columns mean.
 *
 * The heuristics in `leadImport.ts` handle a tidy sheet perfectly well. What
 * they cannot do is read a column called "Ref" that holds "Jane — 3 bed, Croydon",
 * or spot that rows 1–2 are a title block and the real headers are on row 3, or
 * tell that "Contact" means the landlord's name here and the letting agent's
 * name in the next customer's file. That judgement is the whole reason a person
 * would otherwise have to reformat their spreadsheet before uploading it.
 *
 * THE CONTRACT, WHICH IS WHAT MAKES THIS SAFE TO DEPEND ON:
 *
 *   1. This only ever PROPOSES. The customer confirms the mapping against a
 *      preview of their own rows before a single lead is written, so a wrong
 *      guess costs a dropdown change, never bad data.
 *   2. It always degrades to the heuristic result — no API key, a network
 *      failure, a timeout, malformed JSON, a hallucinated field name. The
 *      import must work with the model unavailable; the model makes it better,
 *      it is not load-bearing.
 *   3. Nothing it returns is trusted verbatim. Every proposal is validated
 *      against the target enum and the real column count before it is shown.
 *
 * This is the first model call in the codebase. Everything above is why it can
 * be, without the feature acquiring a hard dependency on an external service.
 */

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  IMPORT_TARGETS,
  TARGET_LABELS,
  proposeMapping,
  resolveDuplicateClaims,
  type ColumnMapping,
  type ImportTarget,
  type SheetRows,
} from "./leadImport";

/** How the mapping shown to the customer was arrived at. */
export type MappingSource = "claude" | "heuristic";

export interface MappingProposal {
  headerRowIndex: number | null;
  columns: ColumnMapping[];
  source: MappingSource;
}

/** Rows of the sheet handed to the model. Enough to judge, few enough to be cheap. */
const SAMPLE_ROWS = 20;
const REQUEST_TIMEOUT_MS = 20_000;

const MappingResponse = z.object({
  header_row_index: z
    .number()
    .int()
    .nullable()
    .describe(
      "0-based index of the row containing column headers, or null if the sheet has no header row and starts straight into data."
    ),
  columns: z
    .array(
      z.object({
        index: z.number().int().describe("0-based column position."),
        target: z
          .enum(IMPORT_TARGETS as [ImportTarget, ...ImportTarget[]])
          .describe("Which lead field this column holds."),
        confidence: z
          .number()
          .describe("0 to 1. How sure you are about this column."),
      })
    )
    .describe("One entry per column in the sheet, in order."),
});

function systemPrompt(): string {
  const glossary = IMPORT_TARGETS.map((t) => `  ${t} — ${TARGET_LABELS[t]}`).join("\n");
  return [
    "You map the columns of a landlord lead spreadsheet onto a fixed set of fields.",
    "",
    "The available targets are:",
    glossary,
    "",
    "Rules:",
    "- Return exactly one entry per column, using 0-based indices.",
    "- Use `ignore` for anything that is not clearly one of the other targets. Never guess: a wrong mapping puts a landlord's phone number in the address field, which is worse than leaving a column out.",
    "- `notes` is the catch-all for free text about the lead or property (comments, requirements, background). Several columns may map to `notes`.",
    "- Every other target may be used at most once. If two columns could be the phone, pick the one that looks like the primary contact and ignore the other.",
    "- Judge by the DATA as much as the header. Headers are often wrong or missing: a column called `Contact` holding `07700 900123` is a phone, not a name.",
    "- `header_row_index` is the row holding the column names. Spreadsheets often open with a title and a blank line, so it is not always row 0. Return null if the sheet has no header row at all and row 0 is already data.",
  ].join("\n");
}

function userPrompt(rows: SheetRows): string {
  const sample = rows.slice(0, SAMPLE_ROWS);
  return [
    "Here are the first rows of the spreadsheet, as a JSON array of rows of cells.",
    "",
    JSON.stringify(sample, null, 1),
  ].join("\n");
}

/**
 * Validate a model proposal against the sheet we actually parsed.
 *
 * Pure and exported so the failure modes are unit-tested without a network
 * call — this is the part that decides whether a hallucinated field name or a
 * column index off the end of the sheet reaches a customer.
 */
export function validateMappingResponse(
  raw: unknown,
  headers: string[]
): { headerRowIndex: number | null; columns: ColumnMapping[] } | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;
  const list = body.columns;
  if (!Array.isArray(list)) return null;

  const byIndex = new Map<number, ColumnMapping>();
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const index = typeof e.index === "number" ? Math.trunc(e.index) : NaN;
    // An index off the end of the real sheet is the clearest sign the model has
    // lost track of the shape; drop it rather than shifting everything along.
    if (!Number.isFinite(index) || index < 0 || index >= headers.length) continue;
    const target = e.target;
    if (typeof target !== "string" || !IMPORT_TARGETS.includes(target as ImportTarget)) {
      continue;
    }
    const rawConfidence = typeof e.confidence === "number" ? e.confidence : 0.5;
    const confidence = Math.max(0, Math.min(1, rawConfidence));
    // First claim on a column wins; a repeated index is a malformed response.
    if (byIndex.has(index)) continue;
    byIndex.set(index, {
      index,
      header: headers[index],
      target: target as ImportTarget,
      confidence,
    });
  }

  if (!byIndex.size) return null;

  // Any column the model failed to mention is left alone rather than assumed.
  const columns: ColumnMapping[] = headers.map(
    (header, index) =>
      byIndex.get(index) ?? { index, header, target: "ignore" as ImportTarget, confidence: 0.2 }
  );

  const headerRowIndex =
    typeof body.header_row_index === "number" && Number.isFinite(body.header_row_index)
      ? Math.trunc(body.header_row_index)
      : null;

  // The single-claim rule is enforced here too: the prompt asks for it, and a
  // prompt is not a guarantee.
  return { headerRowIndex, columns: resolveDuplicateClaims(columns) };
}

/**
 * True when the heuristics have left enough doubt to be worth asking about.
 *
 * A sheet whose headers all resolve confidently needs no model call — it would
 * cost money and latency to confirm what we already know. Ambiguity means: a
 * column we could not place that still holds data, or no header row found.
 */
export function mappingNeedsHelp(
  columns: ColumnMapping[],
  headerRowIndex: number | null,
  dataRows: SheetRows
): boolean {
  if (headerRowIndex === null) return true;
  return columns.some((c) => {
    if (c.target !== "ignore" && c.confidence >= 0.7) return false;
    // An unplaced column only matters if there is actually something in it.
    return dataRows.some((row) => String(row?.[c.index] ?? "").trim() !== "");
  });
}

export function isClaudeMappingConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * Propose a mapping, using Claude where it helps and heuristics where it does
 * not. NEVER THROWS — every failure returns the heuristic proposal.
 */
export async function proposeMappingWithClaude(
  headers: string[],
  dataRows: SheetRows,
  headerRowIndex: number | null,
  allRows: SheetRows
): Promise<MappingProposal> {
  const heuristic = proposeMapping(headers, dataRows);
  const fallback: MappingProposal = {
    headerRowIndex,
    columns: heuristic,
    source: "heuristic",
  };

  if (!isClaudeMappingConfigured()) return fallback;
  if (!mappingNeedsHelp(heuristic, headerRowIndex, dataRows)) return fallback;

  try {
    const client = new Anthropic({ timeout: REQUEST_TIMEOUT_MS });
    const response = await client.messages.parse({
      model: "claude-opus-5",
      max_tokens: 8000,
      system: systemPrompt(),
      // A column mapping is a small, well-specified judgement — it does not
      // need deep reasoning, and the customer is waiting on the response.
      output_config: {
        effort: "low",
        format: zodOutputFormat(MappingResponse),
      },
      messages: [{ role: "user", content: userPrompt(allRows) }],
    });

    const validated = validateMappingResponse(response.parsed_output, headers);
    if (!validated) return fallback;

    return {
      // The model may have spotted a header row the heuristic missed, but a
      // row index outside the sheet is nonsense; keep ours in that case.
      headerRowIndex:
        validated.headerRowIndex !== null &&
        validated.headerRowIndex >= 0 &&
        validated.headerRowIndex < allRows.length
          ? validated.headerRowIndex
          : headerRowIndex,
      columns: validated.columns,
      source: "claude",
    };
  } catch (error) {
    // Deliberately swallowed. An import that fails because a model was
    // unreachable would be a worse feature than one that occasionally proposes
    // a duller mapping, and the customer confirms either way.
    console.error("claudeMapping: falling back to heuristics", error);
    return fallback;
  }
}
