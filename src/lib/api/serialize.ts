/**
 * Turning database rows into API responses.
 *
 * EVERYTHING HERE IS DERIVED FROM src/lib/api/schema.ts. There is no hand-written
 * object literal and, critically, NO SPREAD of a database row anywhere in this
 * file. A `{ ...lead }` would publish every column the table happens to have,
 * including the ones a future migration adds, and that is the single most
 * likely way this API leaks something internal.
 *
 * Because both the select string and the output are generated from one spec,
 * the output keys are exactly the spec keys — an omission is impossible by
 * construction, and an addition has to be made deliberately in schema.ts.
 */
import {
  ASSIGNMENT_FIELDS,
  LEAD_FIELDS,
  NOTE_FIELDS,
  type ApiFieldSpec,
} from "@/lib/api/schema";

type Row = Record<string, unknown>;

/** Distinct columns a spec needs, in order, de-duplicated. */
function columnsFor(spec: readonly ApiFieldSpec[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of spec) {
    if (!seen.has(f.column)) {
      seen.add(f.column);
      out.push(f.column);
    }
  }
  return out;
}

function serializeWith(spec: readonly ApiFieldSpec[], row: Row): Row {
  const out: Row = {};
  for (const f of spec) {
    const value = row[f.column];
    out[f.field] = f.derive ? f.derive(value, row) : (value ?? null);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Select strings
 * ------------------------------------------------------------------ */

export const LEAD_COLUMNS = columnsFor(LEAD_FIELDS).join(", ");
export const NOTE_COLUMNS = columnsFor(NOTE_FIELDS).join(", ");

/**
 * Assignment columns plus the embedded lead.
 *
 * PostgREST resolves `lead:leads(...)` through the foreign key, so the whole
 * page is one query rather than an N+1 over leads.
 *
 * ⚠️ THE `!inner` IS LOAD-BEARING — do not drop it to "simplify" the select.
 *
 * Filtering on a NON-inner embedded resource filters the EMBEDDED RESOURCE, not
 * the parent rows: every assignment still comes back, and the ones that do not
 * match simply arrive with the lead nulled. `?product=` in listAssignments
 * filters on `lead.lead_type`, so without this the filter silently returns the
 * caller's entire book with half the rows carrying `"lead": null` — a 200 that
 * paginates normally and is wrong, which an automated sync would ingest for
 * weeks before anybody noticed.
 *
 * `lead_assignments.lead_id` is nullable by declaration (0001 never added the
 * constraint) though no row has ever been null — 0 of 330 today. So an inner
 * join could in principle drop an assignment with no lead where a left join
 * would have kept it. That is the better behaviour rather than a regression: an
 * assignment pointing at no lead carries nothing a caller can use, and the
 * serializer would emit `"lead": null` for it either way.
 */
export const ASSIGNMENT_COLUMNS = `${columnsFor(ASSIGNMENT_FIELDS).join(
  ", "
)}, lead:leads!inner(${LEAD_COLUMNS})`;

/**
 * Sort columns must also be selected, because the cursor is built from the
 * value on the row. Both are already in ASSIGNMENT_FIELDS (`assigned_at`,
 * `last_status_change_at`), which is asserted in the tests so that dropping one
 * from the spec cannot silently break pagination.
 */

/* ------------------------------------------------------------------ *
 * Serializers
 * ------------------------------------------------------------------ */

export function serializeLead(row: Row | null | undefined): Row | null {
  if (!row) return null;
  return serializeWith(LEAD_FIELDS, row);
}

export function serializeAssignment(row: Row): Row {
  const out = serializeWith(ASSIGNMENT_FIELDS, row);
  out.lead = serializeLead(row.lead as Row | null);
  return out;
}

export function serializeNote(row: Row): Row {
  return serializeWith(NOTE_FIELDS, row);
}

/** Field names the serializers emit — used by the tests and the OpenAPI doc. */
export const LEAD_FIELD_NAMES = LEAD_FIELDS.map((f) => f.field);
export const ASSIGNMENT_FIELD_NAMES = [
  ...ASSIGNMENT_FIELDS.map((f) => f.field),
  "lead",
];
export const NOTE_FIELD_NAMES = NOTE_FIELDS.map((f) => f.field);
