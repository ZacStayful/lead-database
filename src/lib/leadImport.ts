/**
 * Spreadsheet import: turning somebody else's spreadsheet into leads.
 *
 * A customer's own lead list is whatever their business happens to keep. It
 * arrives with a title row above the headers, or no headers at all, or headers
 * spelled "Tel"/"Mobile No."/"Contact Number", with a "Notes from viewing"
 * column we have nowhere to put and three blank spacer rows in the middle. None
 * of that is a malformed file; it is what real spreadsheets look like.
 *
 * So this module is deliberately tolerant, and the confirmation screen is what
 * makes the tolerance safe: everything here PROPOSES, and the customer confirms
 * against a preview of their own data before a single lead is written.
 *
 * Everything is a pure function of its inputs — no network, no database — so it
 * can sit in the build-gating vitest suite.
 */

/** A raw sheet: rows of cells, already stringified by the caller. */
export type SheetRows = string[][];

/**
 * Where a spreadsheet column ends up. Deliberately small.
 *
 * `enquiry_date` is NOT here even though `leads` has the column: it is free
 * text of uneven quality and is displayed nowhere in the app (CLAUDE.md §11),
 * so mapping to it would let a customer believe a date they can see in their
 * sheet will appear somewhere it never will. Lead age is measured from
 * `assigned_at`.
 *
 * `notes` is the catch-all: it lands in `lead_profile`, which is the one field
 * rendered as free prose on both the card and the detail page.
 */
export type ImportTarget =
  | "name"
  | "email"
  | "phone"
  | "address"
  | "postcode"
  | "bedrooms"
  | "notes"
  | "ignore";

export const IMPORT_TARGETS: ImportTarget[] = [
  "name",
  "email",
  "phone",
  "address",
  "postcode",
  "bedrooms",
  "notes",
  "ignore",
];

/** Human labels for the mapping dropdown. */
export const TARGET_LABELS: Record<ImportTarget, string> = {
  name: "Landlord name",
  email: "Email",
  phone: "Phone",
  address: "Address",
  postcode: "Postcode",
  bedrooms: "Bedrooms",
  notes: "Notes / lead profile",
  ignore: "Don't import",
};

/**
 * The targets that may only be claimed once. `notes` is excluded on purpose —
 * a sheet often has several comment columns and concatenating them all into the
 * lead profile is exactly right.
 */
const SINGLE_CLAIM_TARGETS: ImportTarget[] = [
  "name",
  "email",
  "phone",
  "address",
  "postcode",
  "bedrooms",
];

export interface ColumnMapping {
  index: number;
  header: string;
  target: ImportTarget;
  /** 0–1. Drives the "check this one" hint on the confirmation screen. */
  confidence: number;
}

export interface NormalisedRow {
  name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  /**
   * A postcode column of its own, when the sheet keeps one.
   *
   * Separate from `address` because the analyser needs the postcode as a field,
   * and because a customer whose sheet plainly HAS a postcode column should not
   * be told their leads cannot be analysed. Where both exist the address is the
   * street and this is the postcode; where only the address exists this is null
   * and the postcode is read back out of it downstream.
   */
  postcode: string | null;
  bedrooms: string | null;
  profile: string | null;
}

/**
 * Caps. The route rejects an over-cap file rather than truncating it: silently
 * importing the first 2000 rows of a 5000-row sheet is the kind of data loss
 * nobody notices until they go looking for a landlord who was never there.
 */
export const MAX_IMPORT_ROWS = 2000;
export const MAX_IMPORT_BYTES = 4 * 1024 * 1024;

/** Header synonyms, lowercased and stripped of punctuation before comparison. */
const SYNONYMS: Record<Exclude<ImportTarget, "ignore">, string[]> = {
  name: [
    "name", "landlord", "landlordname", "client", "clientname", "contact",
    "contactname", "fullname", "firstname", "owner", "ownername", "lead",
    "leadname", "customer", "vendor",
  ],
  email: ["email", "emailaddress", "mail", "email1", "contactemail", "eaddress"],
  phone: [
    "phone", "phonenumber", "phoneno", "tel", "telephone", "mobile",
    "mobileno", "mobilenumber", "contactnumber", "number", "cell", "cellphone",
    "contactno", "telno",
  ],
  address: [
    "address", "propertyaddress", "property", "fulladdress", "addressline1",
    "addressline", "location", "street", "streetaddress", "houseaddress",
    "propertylocation",
  ],
  // "postcode" used to live in the address list above, which meant a sheet with
  // BOTH an Address and a Postcode column had them fight over one single-claim
  // target: the loser was demoted to `ignore` and folded into the lead profile
  // as a "Postcode: BS1 5TR" line. Harmless while the postcode was only ever
  // read back out of the address — and the difference between a lead that can
  // be analysed and one that cannot, now that it is a field in its own right.
  postcode: [
    "postcode", "postcodes", "postal", "postalcode", "poscode", "pcode",
    "zip", "zipcode", "outcode", "outwardcode",
  ],
  bedrooms: [
    "bedrooms", "beds", "bedroom", "noofbedrooms", "numberofbedrooms", "br",
    "bed", "bedcount", "size",
  ],
  notes: [
    "notes", "note", "comments", "comment", "profile", "leadprofile",
    "details", "description", "info", "information", "remarks", "background",
    "requirements", "summary",
  ],
};

/** Lowercase, drop everything that is not a letter or digit. */
export function normaliseHeader(header: string): string {
  return String(header ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Deliberately loose: a sheet may hold "07700 900123", "+44 7700 900123" or
// "(01179) 123456". Seven or more digits is the same floor normalised_phone
// uses in the database (0070), so the two agree about what could be a number.
const PHONE_RE = /^[+()\d][\d\s()+.-]{5,}$/;
const POSTCODE_IN_TEXT = /[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}/i;
// Anchored: the WHOLE cell is a postcode and nothing else. That is what
// separates a postcode column from an address column, which merely contains one.
const POSTCODE_ONLY = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
const BEDROOM_RE = /^\s*\d{1,2}\s*(bed|beds|bedroom|bedrooms)?\s*$/i;

/**
 * Score a column by what is IN it, not what it is called.
 *
 * This is what rescues an unlabelled export: a column of things containing "@"
 * is an email column whatever the header says, and a column of UK postcodes is
 * an address column even when it is headed "Column D". It is also the tiebreak
 * that stops a column called "Contact" being read as a name when it is full of
 * phone numbers.
 */
export function scoreColumnContent(values: string[]): Partial<Record<ImportTarget, number>> {
  const filled = values.map((v) => String(v ?? "").trim()).filter(Boolean);
  if (!filled.length) return {};

  const share = (pred: (v: string) => boolean) =>
    filled.filter(pred).length / filled.length;

  const scores: Partial<Record<ImportTarget, number>> = {};
  const emailShare = share((v) => EMAIL_RE.test(v));
  if (emailShare > 0.5) scores.email = emailShare;

  const phoneShare = share(
    (v) => PHONE_RE.test(v) && (v.replace(/\D/g, "").length >= 7)
  );
  if (phoneShare > 0.5) scores.phone = phoneShare;

  // Checked BEFORE the address test, and exclusive of it. A column of bare
  // postcodes satisfies both, so scoring it for both would leave the winner to
  // whichever key happened to come out of Object.entries first.
  const postcodeOnlyShare = share((v) => POSTCODE_ONLY.test(v));
  if (postcodeOnlyShare > 0.7) {
    scores.postcode = postcodeOnlyShare;
  } else {
    const postcodeShare = share((v) => POSTCODE_IN_TEXT.test(v));
    if (postcodeShare > 0.4) scores.address = Math.max(postcodeShare, 0.6);
  }

  const bedroomShare = share((v) => BEDROOM_RE.test(v));
  if (bedroomShare > 0.7) scores.bedrooms = bedroomShare;

  return scores;
}

/**
 * Find the header row.
 *
 * Scans the first few rows rather than assuming row 0, because a spreadsheet
 * exported from a CRM or hand-made by an operator very often opens with a title
 * ("Landlord leads — March") and a blank line. Returns null when nothing looks
 * like a header, which is a real case (a bare CSV of values) and is handled by
 * synthesising column names instead of stealing the first row of data.
 */
export function detectHeaderRow(rows: SheetRows, scanDepth = 10): number | null {
  let best: { index: number; score: number } | null = null;

  for (let i = 0; i < Math.min(rows.length, scanDepth); i++) {
    const row = rows[i] ?? [];
    const cells = row.map((c) => String(c ?? "").trim());
    const filled = cells.filter(Boolean);
    // A header row names most of its columns.
    if (filled.length < 2) continue;

    // Anything that looks like DATA is disqualifying: real headers are not
    // email addresses, phone numbers or postcodes.
    const dataish = filled.filter(
      (c) => EMAIL_RE.test(c) || PHONE_RE.test(c) || POSTCODE_IN_TEXT.test(c)
    ).length;
    if (dataish > 0) continue;

    const known = filled.filter((c) => synonymTarget(normaliseHeader(c)) !== null).length;
    const shortLabels = filled.filter((c) => c.length <= 30).length;
    const unique = new Set(filled.map((c) => c.toLowerCase())).size === filled.length;

    const score =
      known * 3 +
      (shortLabels / filled.length) * 2 +
      (unique ? 1 : 0) +
      Math.min(filled.length / 4, 1);

    // A header must actually name something we recognise, or be a plausible
    // row of short unique labels. One stray word above the data is not a header.
    if (known === 0 && filled.length < 3) continue;

    if (!best || score > best.score) best = { index: i, score };
  }

  // Require a minimum standard, so a headerless sheet reports null rather than
  // consuming its own first lead as column names.
  if (!best || best.score < 3) return null;
  return best.index;
}

/** The target a header name maps to by synonym, or null. */
function synonymTarget(normalised: string): Exclude<ImportTarget, "ignore"> | null {
  if (!normalised) return null;
  for (const [target, words] of Object.entries(SYNONYMS)) {
    if (words.includes(normalised)) return target as Exclude<ImportTarget, "ignore">;
  }
  // Fall back to containment, so "landlordmobilenumber" still resolves. Longest
  // synonym wins, which is what stops "phone" matching before "phonenumber".
  let match: { target: Exclude<ImportTarget, "ignore">; len: number } | null = null;
  for (const [target, words] of Object.entries(SYNONYMS)) {
    for (const w of words) {
      if (w.length >= 4 && normalised.includes(w)) {
        if (!match || w.length > match.len) {
          match = { target: target as Exclude<ImportTarget, "ignore">, len: w.length };
        }
      }
    }
  }
  return match?.target ?? null;
}

/**
 * Propose a mapping from headers and (optionally) the data beneath them.
 *
 * Header synonyms first because a named column is the strongest signal we have;
 * content scoring fills the gaps and breaks ties. Where two columns claim the
 * same single-claim target the higher confidence keeps it and the other is
 * demoted to `ignore` — a sheet with "Phone" and "Phone 2" should import one
 * number, not silently overwrite one with the other.
 */
export function proposeMapping(headers: string[], dataRows: SheetRows = []): ColumnMapping[] {
  const mappings: ColumnMapping[] = headers.map((header, index) => {
    const column = dataRows.map((r) => r?.[index] ?? "");
    const contentScores = scoreColumnContent(column);
    const bySynonym = synonymTarget(normaliseHeader(header));

    if (bySynonym) {
      // A header that disagrees with its own contents is usually a header
      // that has drifted ("Contact" holding phone numbers). Trust the data.
      const contentBest = bestContentTarget(contentScores);
      if (
        contentBest &&
        contentBest.target !== bySynonym &&
        contentBest.score > 0.8 &&
        // Names and notes are unconstrained free text, so content can never
        // out-argue an explicit header for them.
        bySynonym !== "notes"
      ) {
        return { index, header, target: contentBest.target, confidence: 0.75 };
      }
      return { index, header, target: bySynonym, confidence: 0.95 };
    }

    const contentBest = bestContentTarget(contentScores);
    if (contentBest) {
      return { index, header, target: contentBest.target, confidence: Math.min(contentBest.score, 0.8) };
    }

    return { index, header, target: "ignore", confidence: 0.2 };
  });

  return resolveDuplicateClaims(mappings);
}

function bestContentTarget(
  scores: Partial<Record<ImportTarget, number>>
): { target: ImportTarget; score: number } | null {
  let best: { target: ImportTarget; score: number } | null = null;
  for (const [target, score] of Object.entries(scores)) {
    if (typeof score !== "number") continue;
    if (!best || score > best.score) best = { target: target as ImportTarget, score };
  }
  return best;
}

/**
 * Two columns cannot both be "the" phone. Highest confidence wins; ties go to
 * the leftmost, which is almost always the primary column in a real sheet.
 */
export function resolveDuplicateClaims(mappings: ColumnMapping[]): ColumnMapping[] {
  const winners = new Map<ImportTarget, ColumnMapping>();
  for (const m of mappings) {
    if (!SINGLE_CLAIM_TARGETS.includes(m.target)) continue;
    const held = winners.get(m.target);
    if (!held || m.confidence > held.confidence) winners.set(m.target, m);
  }
  return mappings.map((m) => {
    if (!SINGLE_CLAIM_TARGETS.includes(m.target)) return m;
    return winners.get(m.target) === m ? m : { ...m, target: "ignore", confidence: 0.2 };
  });
}

/** Synthesised names for a sheet with no header row: "Column A", "Column B"… */
export function syntheticHeaders(count: number): string[] {
  return Array.from({ length: count }, (_, i) => {
    let n = i;
    let label = "";
    do {
      label = String.fromCharCode(65 + (n % 26)) + label;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return `Column ${label}`;
  });
}

/**
 * Apply a mapping to one raw row.
 *
 * Two things here are load-bearing:
 *
 *  - Everything stays TEXT. A phone number is not a number — "07700 900123"
 *    parsed as one loses its leading zero and becomes unusable. The caller
 *    reads the sheet with `raw: false` so Excel's own formatting survives, and
 *    nothing here is coerced afterwards.
 *  - Columns mapped to `notes`, AND columns the customer left as `ignore` that
 *    still hold data, are folded into the lead profile as "Header: value"
 *    lines. The brief was that the import populates whatever is on the sheet;
 *    dropping a column because we have no dedicated field for it would lose
 *    exactly the operator's own annotations, which are often the reason they
 *    kept the spreadsheet in the first place.
 */
export function normaliseRow(
  row: string[],
  mappings: ColumnMapping[],
  options: { keepUnmapped?: boolean } = {}
): NormalisedRow {
  const keepUnmapped = options.keepUnmapped ?? true;
  const cell = (i: number) => String(row?.[i] ?? "").trim();

  const pick = (target: ImportTarget): string | null => {
    const m = mappings.find((x) => x.target === target);
    if (!m) return null;
    return cell(m.index) || null;
  };

  const profileParts: string[] = [];
  for (const m of mappings) {
    const value = cell(m.index);
    if (!value) continue;
    if (m.target === "notes") {
      profileParts.push(value);
    } else if (m.target === "ignore" && keepUnmapped) {
      profileParts.push(`${m.header}: ${value}`);
    }
  }

  return {
    name: pick("name"),
    email: pick("email"),
    phone: pick("phone"),
    address: pick("address"),
    postcode: pick("postcode"),
    bedrooms: pick("bedrooms"),
    profile: profileParts.length ? profileParts.join("\n") : null,
  };
}

/**
 * A row with no way to reach or identify anybody is a spreadsheet artefact — a
 * spacer, a totals line, a stray comment — not a lead. Notes alone do not make
 * one: there is nobody to ring.
 *
 * Mirrors the same test inside create_customer_leads, which is the authority.
 */
export function isEmptyRow(row: NormalisedRow): boolean {
  return !row.name && !row.email && !row.phone && !row.address;
}

/** Drop blank rows from the end of a sheet (Excel loves to add them). */
export function trimTrailingBlankRows(rows: SheetRows): SheetRows {
  let end = rows.length;
  while (end > 0 && (rows[end - 1] ?? []).every((c) => !String(c ?? "").trim())) end--;
  return rows.slice(0, end);
}
