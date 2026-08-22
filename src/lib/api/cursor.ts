/**
 * Keyset pagination cursors.
 *
 * NOT OFFSET PAGING. The daily Monday sync inserts assignments while a client is
 * part-way through a walk, and offset paging over a table taking inserts returns
 * duplicates and skips rows. An agent walking pages is exactly the client that
 * would act on the gap without noticing.
 *
 * TWO THINGS HERE ARE EASY TO GET WRONG AND BOTH ARE SILENT:
 *
 * 1. THE TIMESTAMP IS CARRIED VERBATIM. Postgres returns `assigned_at` with
 *    microsecond precision (`...T12:00:00.123456+00:00`); `new Date(x)
 *    .toISOString()` truncates to milliseconds. A cursor built from a
 *    round-tripped Date can therefore re-emit or skip a row assigned in the same
 *    millisecond as the page boundary. The raw string off the row goes in and
 *    the same string comes out.
 *
 * 2. THE CURSOR CARRIES ITS OWN SORT. Paging one ordering with another
 *    ordering's boundary skips rows without erroring, so a cursor minted under
 *    one sort is REFUSED under the other rather than honoured.
 */
export const SORTS = {
  assigned_at: { column: "assigned_at" },
  last_status_change_at: { column: "last_status_change_at" },
} as const;

export type SortKey = keyof typeof SORTS;
export const DEFAULT_SORT: SortKey = "assigned_at";

export function isSortKey(value: unknown): value is SortKey {
  return typeof value === "string" && Object.hasOwn(SORTS, value);
}

export interface Cursor {
  sort: SortKey;
  /** The raw timestamp string exactly as Postgres returned it. */
  ts: string;
  id: string;
}

const VERSION = "v1";

/**
 * Both sort columns are NOT NULL, which is what makes a keyset comparison
 * total: `assigned_at` is NOT NULL by schema (the escalation work depends on
 * it), and `last_status_change_at` is NOT NULL defaulting to now() at insert.
 * A nullable third sort column would silently drop rows at the boundary — do
 * not add one without handling nulls explicitly.
 */

export function encodeCursor(sort: SortKey, ts: string, id: string): string {
  return Buffer.from(`${VERSION}|${sort}|${ts}|${id}`, "utf8").toString(
    "base64url"
  );
}

const TS_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:?\d{2}|Z)?$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DecodeResult =
  | { ok: true; cursor: Cursor }
  | { ok: false; reason: string };

export function decodeCursor(raw: string, expectedSort: SortKey): DecodeResult {
  let text: string;
  try {
    text = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return { ok: false, reason: "The cursor is not valid." };
  }

  const parts = text.split("|");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    return { ok: false, reason: "The cursor is not valid." };
  }

  const [, sort, ts, id] = parts;
  if (!isSortKey(sort)) {
    return { ok: false, reason: "The cursor is not valid." };
  }

  // Refused rather than honoured: see note 2 above.
  if (sort !== expectedSort) {
    return {
      ok: false,
      reason: `This cursor was issued for sort=${sort} and cannot be used with sort=${expectedSort}. Start the walk again without a cursor.`,
    };
  }

  if (!TS_RE.test(ts) || !UUID_RE.test(id)) {
    return { ok: false, reason: "The cursor is not valid." };
  }

  return { ok: true, cursor: { sort, ts, id } };
}

/**
 * The PostgREST filter for "strictly after this cursor" under a descending
 * sort, with the id as the tiebreak.
 *
 * `assigned_at` alone is not unique — a bulk assign stamps several rows inside
 * one transaction — so without the id tiebreak in BOTH the ordering and this
 * filter, ties at a page boundary are silently dropped or repeated.
 *
 * The timestamp is quoted because PostgREST's `or` is a comma-separated
 * mini-language and the value contains `+00:00` and colons.
 */
export function cursorFilter(cursor: Cursor): string {
  const col = SORTS[cursor.sort].column;
  return `${col}.lt."${cursor.ts}",and(${col}.eq."${cursor.ts}",id.lt.${cursor.id})`;
}
