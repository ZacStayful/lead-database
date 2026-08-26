import { NextResponse, type NextRequest } from "next/server";
import * as XLSX from "xlsx";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { availableLeadTypes } from "@/lib/products";
import {
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ROWS,
  detectHeaderRow,
  normaliseRow,
  syntheticHeaders,
  trimTrailingBlankRows,
  type ColumnMapping,
  type SheetRows,
} from "@/lib/leadImport";
import { proposeMappingWithClaude } from "@/lib/claudeMapping";
import { analysisQuote } from "@/lib/leadAnalysis";
import type { Customer, LeadType } from "@/lib/types";

export const runtime = "nodejs";
// Parsing a couple of thousand rows and then asking a model about them does not
// fit in the default 10 seconds.
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const ALLOWED_EXTENSIONS = [".xlsx", ".xls", ".csv"];
const PREVIEW_ROWS = 10;

/**
 * Step one of a spreadsheet import: parse the file, propose what each column
 * means, and stage the rows for the commit.
 *
 * Nothing is created here. The customer sees the proposed mapping beside a
 * preview of their own data and confirms or corrects it, which is what makes it
 * safe for the mapping to be a guess in the first place.
 *
 * The file arrives as multipart form data rather than through Supabase Storage.
 * The storage round-trip exists for files that must PERSIST (lead attachments);
 * a spreadsheet is needed for exactly as long as it takes to parse, and staging
 * the parsed rows in `lead_imports` means the commit works from the bytes we
 * already read. Uploading it to a bucket would add a policy and an
 * orphan-cleanup problem to buy nothing.
 */
export async function POST(request: NextRequest) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected a file upload" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file was uploaded" }, { status: 400 });
  }

  const leadType: LeadType =
    form.get("lead_type") === "guaranteed_rent" ? "guaranteed_rent" : "management";

  const name = file.name.toLowerCase();
  if (!ALLOWED_EXTENSIONS.some((ext) => name.endsWith(ext))) {
    return NextResponse.json(
      { error: "Upload a spreadsheet (.xlsx, .xls or .csv)" },
      { status: 400 }
    );
  }

  if (file.size > MAX_IMPORT_BYTES) {
    return NextResponse.json(
      { error: "That file is too large. Split it into smaller files and try again." },
      { status: 400 }
    );
  }

  const admin = createAdminClient();
  const { data: customer } = await admin
    .from("customers")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!customer) {
    return NextResponse.json({ error: "No customer record" }, { status: 404 });
  }

  // Held or previously held — see the note on the manual-add route. The commit
  // half needs no equivalent check: it re-reads lead_type off the staged
  // lead_imports row rather than taking it from the request.
  if (!availableLeadTypes(customer as Customer).includes(leadType)) {
    return NextResponse.json(
      { error: "You do not hold that product" },
      { status: 403 }
    );
  }

  // `raw: false` is load-bearing: it gives us Excel's OWN formatted text, so a
  // phone number stored as a number keeps the leading zero it is displayed
  // with. Reading raw values would turn "07700 900123" into 7700900123.
  let rows: SheetRows;
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const workbook = XLSX.read(buffer, { type: "buffer", raw: false });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
      return NextResponse.json({ error: "That file has no sheets in it" }, { status: 400 });
    }
    const sheet = workbook.Sheets[sheetName];
    const parsed = XLSX.utils.sheet_to_json<string[]>(sheet, {
      header: 1,
      raw: false,
      defval: "",
      blankrows: true,
    });
    rows = trimTrailingBlankRows(
      parsed.map((row) => (Array.isArray(row) ? row.map((c) => String(c ?? "")) : []))
    );
  } catch {
    return NextResponse.json(
      { error: "That file could not be read as a spreadsheet" },
      { status: 400 }
    );
  }

  if (!rows.length) {
    return NextResponse.json({ error: "That spreadsheet is empty" }, { status: 400 });
  }

  const headerRowIndex = detectHeaderRow(rows);
  const width = Math.max(...rows.map((r) => r.length), 0);
  const headers =
    headerRowIndex === null
      ? syntheticHeaders(width)
      : Array.from({ length: width }, (_, i) => {
          const cell = String(rows[headerRowIndex]?.[i] ?? "").trim();
          return cell || syntheticHeaders(width)[i];
        });

  const dataRows = headerRowIndex === null ? rows : rows.slice(headerRowIndex + 1);

  // Rejected, not truncated. Importing the first 2000 rows of a longer file is
  // the kind of loss nobody notices until they go looking for a landlord who
  // was never there.
  if (dataRows.length > MAX_IMPORT_ROWS) {
    return NextResponse.json(
      {
        error: `That file has ${dataRows.length} rows and the limit is ${MAX_IMPORT_ROWS}. Split it and import the parts separately.`,
      },
      { status: 400 }
    );
  }

  if (!dataRows.length) {
    return NextResponse.json(
      { error: "That spreadsheet has headings but no rows underneath them" },
      { status: 400 }
    );
  }

  const proposal = await proposeMappingWithClaude(headers, dataRows, headerRowIndex, rows);

  const { data: batch, error: batchError } = await admin
    .from("lead_imports")
    .insert({
      customer_id: (customer as Customer).id,
      lead_type: leadType,
      file_name: file.name,
      status: "pending_mapping",
      headers,
      row_payload: dataRows,
      proposed_mapping: proposal.columns,
      mapping_source: proposal.source,
      row_count: dataRows.length,
    })
    .select("id")
    .single();

  if (batchError || !batch) {
    return NextResponse.json(
      { error: batchError?.message ?? "Could not stage the import" },
      { status: 400 }
    );
  }

  // The RAW rows go back alongside the proposal so the confirmation screen can
  // re-derive its preview as the customer changes a dropdown. Sending only the
  // normalised rows would freeze the preview at our first guess, which is the
  // one thing that screen exists to let them disagree with.
  const rawPreviewRows = dataRows.slice(0, PREVIEW_ROWS);

  return NextResponse.json({
    ok: true,
    import_id: (batch as { id: string }).id,
    lead_type: leadType,
    file_name: file.name,
    row_count: dataRows.length,
    mapping_source: proposal.source,
    header_row_found: proposal.headerRowIndex !== null,
    columns: proposal.columns.map((c) => ({
      ...c,
      samples: dataRows
        .slice(0, 3)
        .map((row) => String(row?.[c.index] ?? "").trim())
        .filter(Boolean),
    })),
    preview_rows: rawPreviewRows,
    /**
     * What running the figures on this file would cost, over EVERY row rather
     * than the ten sampled above — a ten-row sample would report "8 of 10 look
     * ready" for a two-hundred-row sheet, which is a wrong number dressed as a
     * precise one.
     *
     * Non-binding, and stated as such: it is computed under the mapping we are
     * PROPOSING, so the confirmation screen hides it the moment the customer
     * changes a dropdown that could affect it. The binding quote is priced
     * after the import, against the leads that were actually created.
     */
    analysis_estimate: estimateAnalysis(dataRows, proposal.columns),
  });
}

function estimateAnalysis(
  dataRows: SheetRows,
  columns: ColumnMapping[]
): { runnable: number; blocked: number; amount_pence: number } {
  const rows = dataRows
    .map((row) => normaliseRow(row, columns))
    .filter((r) => r.name || r.email || r.phone || r.address);
  const quote = analysisQuote(rows);
  return {
    runnable: quote.eligible.length,
    blocked: quote.ineligible.length,
    amount_pence: quote.amountPence,
  };
}
