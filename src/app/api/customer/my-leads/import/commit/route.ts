import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  IMPORT_TARGETS,
  normaliseRow,
  resolveDuplicateClaims,
  type ColumnMapping,
  type ImportTarget,
  type SheetRows,
} from "@/lib/leadImport";
import { createOwnedLeads } from "@/lib/customerLeads";
import { analysisQuote, describeIneligibility } from "@/lib/leadAnalysis";
import { normaliseUkMobile } from "@/lib/leadQuality";
import type { Customer, LeadType } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Step two: the customer has confirmed what the columns mean, so import them.
 *
 * The rows are re-derived HERE from the staged payload and the submitted
 * mapping. The preview rows the client is showing are display only and are
 * never sent back to us — the same "client proposes, server re-derives"
 * discipline `/api/customer/filter` uses for the volume forecast, and for the
 * same reason: what gets written must be computed from data we parsed, not
 * from data a browser hands us.
 *
 * `status = 'pending_mapping'` is the idempotency claim. A double-clicked
 * button, a resubmitted form or a stale tab finds the batch already `imported`
 * and gets its tally back rather than a second copy of every lead.
 */
export async function POST(request: NextRequest) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { import_id?: string; mapping?: { index: number; target: string }[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.import_id || !Array.isArray(body.mapping)) {
    return NextResponse.json(
      { error: "import_id and mapping are required" },
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

  const { data: batch } = await admin
    .from("lead_imports")
    .select("*")
    .eq("id", body.import_id)
    .eq("customer_id", (customer as Customer).id)
    .maybeSingle();

  if (!batch) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const staged = batch as {
    id: string;
    lead_type: LeadType;
    status: string;
    headers: string[] | null;
    row_payload: SheetRows | null;
    imported_count: number | null;
    duplicate_count: number | null;
    empty_count: number | null;
  };

  if (staged.status === "imported") {
    return NextResponse.json({
      ok: true,
      already_imported: true,
      imported: staged.imported_count ?? 0,
      duplicates: staged.duplicate_count ?? 0,
      empty: staged.empty_count ?? 0,
    });
  }

  if (staged.status !== "pending_mapping") {
    return NextResponse.json(
      { error: "That import is no longer open", code: "not_pending" },
      { status: 409 }
    );
  }

  const headers = staged.headers ?? [];
  const rows = staged.row_payload ?? [];
  if (!rows.length) {
    return NextResponse.json({ error: "That import has no rows" }, { status: 400 });
  }

  // Rebuild the mapping against OUR headers. A target the client invented, or
  // an index past the end of the sheet, is dropped rather than trusted.
  const submitted = new Map<number, ImportTarget>();
  for (const entry of body.mapping) {
    if (!entry || typeof entry.index !== "number") continue;
    if (entry.index < 0 || entry.index >= headers.length) continue;
    if (!IMPORT_TARGETS.includes(entry.target as ImportTarget)) continue;
    submitted.set(entry.index, entry.target as ImportTarget);
  }

  // The single-claim rule is enforced here, not just proposed in the UI: the
  // customer can set two columns to Phone by hand, and `normaliseRow` would
  // then take the first and silently drop the second. Demoting the loser to
  // `ignore` means it is folded into the lead profile as "Header: value"
  // instead — the data survives where it would otherwise vanish.
  const mapping: ColumnMapping[] = resolveDuplicateClaims(
    headers.map((header, index) => ({
      index,
      header,
      target: submitted.get(index) ?? "ignore",
      confidence: 1,
    }))
  );

  const normalised = rows.map((row) => normaliseRow(row, mapping));

  const { result, error } = await createOwnedLeads(admin, {
    customerId: (customer as Customer).id,
    leadType: staged.lead_type,
    source: "import",
    rows: normalised,
  });

  if (error || !result) {
    await admin
      .from("lead_imports")
      .update({ status: "failed", error: error ?? "unknown", final_mapping: mapping })
      .eq("id", staged.id);
    return NextResponse.json(
      { error: error ?? "Could not import those leads" },
      { status: 400 }
    );
  }

  await admin
    .from("lead_imports")
    .update({
      status: "imported",
      final_mapping: mapping,
      imported_count: result.created,
      duplicate_count: result.duplicates,
      empty_count: result.empty,
      committed_at: new Date().toISOString(),
    })
    .eq("id", staged.id);

  // ── The analysis offer ────────────────────────────────────────────
  //
  // Quoted HERE rather than on the client, and only now, because this is the
  // first moment we know which rows became REAL leads. Quoting before the
  // commit would bill for duplicates (create_customer_leads creates nothing for
  // those) and for blank rows.
  //
  // Best-effort in the strictest sense: the import has already succeeded and
  // the leads are already the customer's. A failure to price the upsell must
  // never turn that into an error — they simply do not see the offer.
  const analysis = await quoteAnalysis(admin, result.leadIds);

  // ── Numbers we could not make sense of ────────────────────────────
  //
  // toRpcRow has already normalised every UK mobile it could recognise, in
  // whatever shape the spreadsheet held it (§36.2). What is left is numbers
  // that are genuinely unusable — a digit short, a landline, a placeholder —
  // and the customer needs to hear that HERE rather than discovering it one
  // lead at a time when a message will not send.
  //
  // Counted after the commit, over the leads actually created, for the same
  // reason the analysis quote is: before it, duplicates and blank rows would
  // be counted as problems the customer cannot act on.
  const unmessageable = await countUnmessageable(admin, result.leadIds);

  return NextResponse.json({
    ok: true,
    imported: result.created,
    duplicates: result.duplicates,
    empty: result.empty,
    total: rows.length,
    analysis,
    unmessageable,
  });
}

/**
 * How many of the new leads carry a phone number nothing can message.
 *
 * Best-effort, like the analysis quote beside it: the import has succeeded and
 * the leads are the customer's, so a failure to count is a missing warning
 * rather than an error. An explicitly FOREIGN number is not counted — a
 * landlord abroad is a fact, and WhatsApp reaches them (§36.2).
 */
async function countUnmessageable(
  admin: ReturnType<typeof createAdminClient>,
  leadIds: string[]
): Promise<number> {
  if (!leadIds.length) return 0;
  try {
    const { data, error } = await admin.from("leads").select("phone").in("id", leadIds);
    if (error || !data) return 0;
    return (data as { phone: string | null }[]).filter((l) => {
      const verdict = normaliseUkMobile(l.phone);
      return !verdict.ok && verdict.reason !== "foreign";
    }).length;
  } catch (err) {
    console.error("import/commit: phone count failed", err);
    return 0;
  }
}

/**
 * What running the figures on the leads just created would cost.
 *
 * Returns null on any failure. The import is done and paid-for by nobody; an
 * upsell that cannot be priced is an upsell that is not offered, not an error.
 */
async function quoteAnalysis(
  admin: ReturnType<typeof createAdminClient>,
  leadIds: string[]
): Promise<{
  eligible_lead_ids: string[];
  amount_pence: number;
  ineligible: Array<{ lead_name: string; reason: string }>;
} | null> {
  if (!leadIds.length) return null;
  try {
    const { data, error } = await admin
      .from("leads")
      .select("id, lead_name, lead_type, address, postcode, bedrooms, gross_annual_income")
      .in("id", leadIds);
    if (error || !data) return null;

    const quote = analysisQuote(
      data as Array<{
        id: string;
        lead_name: string;
        lead_type: LeadType;
        address: string | null;
        postcode: string | null;
        bedrooms: string | null;
        gross_annual_income: number | null;
      }>
    );

    return {
      eligible_lead_ids: quote.eligible.map((l) => l.id),
      amount_pence: quote.amountPence,
      ineligible: quote.ineligible.map((x) => ({
        lead_name: x.lead.lead_name,
        reason: describeIneligibility(x.code),
      })),
    };
  } catch (err) {
    console.error("import/commit: analysis quote failed", err);
    return null;
  }
}
