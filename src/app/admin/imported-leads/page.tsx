import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent } from "@/components/ui/card";
import {
  ImportedLeadsTable,
  type ImportedLeadRow,
} from "@/components/admin/ImportedLeadsTable";
import {
  formatAdminDate as formatDate,
  londonMonthRange,
  monthLabel,
} from "@/lib/importedLeadMonths";

export const dynamic = "force-dynamic";

/**
 * Leads customers brought in themselves.
 *
 * This population is deliberately absent from every marketplace counter
 * (§30.8) — it is not our supply, and counting it would inflate the volume we
 * quote a customer applying a filter, overstate a public claim, and report a
 * backlog no admin action could clear. Right, and it left the leads invisible
 * rather than merely uncounted: nothing anywhere could answer "how many leads
 * have customers brought in".
 *
 * Three readings of one population, because they answer different questions:
 * all time (is this feature used at all), by month (is it growing), and by
 * customer (is it one operator or forty).
 *
 * The counts come from SQL (0106) rather than from counting rows here. One
 * import is capped at 2,000 leads and a customer may run many, so this is the
 * population that grows in thousand-row steps.
 */

/** How many leads the list itself shows before it starts truncating. */
const LIST_LIMIT = 300;

interface Totals {
  total: number;
  from_import: number;
  from_manual: number;
  management: number;
  guaranteed_rent: number;
  analysed: number;
  customers: number;
  first_added: string | null;
  last_added: string | null;
}

interface MonthRow {
  month: string;
  total: number;
  from_import: number;
  from_manual: number;
  management: number;
  guaranteed_rent: number;
  analysed: number;
  customers: number;
}

interface CustomerRow {
  customer_id: string;
  business_name: string;
  total: number;
  from_import: number;
  from_manual: number;
  analysed: number;
  first_added: string | null;
  last_added: string | null;
}

const EMPTY_TOTALS: Totals = {
  total: 0,
  from_import: 0,
  from_manual: 0,
  management: 0,
  guaranteed_rent: 0,
  analysed: 0,
  customers: 0,
  first_added: null,
  last_added: null,
};

export default async function AdminImportedLeadsPage({
  searchParams,
}: {
  searchParams: { month?: string; customer?: string };
}) {
  const admin = createAdminClient();

  const [totalsRes, monthsRes, customersRes] = await Promise.all([
    admin.rpc("get_imported_lead_totals"),
    admin.rpc("get_imported_lead_months"),
    admin.rpc("get_imported_lead_customers"),
  ]);

  const totals =
    ((Array.isArray(totalsRes.data) ? totalsRes.data[0] : totalsRes.data) as Totals | null) ??
    EMPTY_TOTALS;
  const months = (monthsRes.data ?? []) as MonthRow[];
  const customers = (customersRes.data ?? []) as CustomerRow[];

  // ── The list, filtered by whichever view the admin drilled into ───
  //
  // Filtered in the QUERY rather than in the page, so picking a month reads
  // 300 rows instead of every lead ever imported. The month bounds are built
  // in Europe/London to match the buckets they came from — a UTC window would
  // put a lead added at half past midnight in the wrong list.
  const selectedMonth = months.find((m) => m.month === searchParams.month) ?? null;
  const selectedCustomer =
    customers.find((c) => c.customer_id === searchParams.customer) ?? null;

  let query = admin
    .from("leads")
    .select(
      "id, lead_name, address, postcode_area, bedrooms, lead_type, owner_source, created_at, gross_annual_income, income_report_path, owner:customers!leads_owner_customer_id_fkey(id, business_name)",
      { count: "exact" }
    )
    .not("owner_customer_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(LIST_LIMIT);

  if (selectedMonth) {
    // The window is built in Europe/London to match the buckets it came from —
    // half-open, so a lead created at exactly midnight on the 1st belongs to
    // one month and not both. See src/lib/importedLeadMonths.ts.
    const { startIso, endIso } = londonMonthRange(selectedMonth.month);
    query = query.gte("created_at", startIso).lt("created_at", endIso);
  }
  if (selectedCustomer) {
    query = query.eq("owner_customer_id", selectedCustomer.customer_id);
  }

  const { data: leadData, count } = await query;

  const leads: ImportedLeadRow[] = (
    (leadData ?? []) as unknown as Array<{
      id: string;
      lead_name: string;
      address: string | null;
      postcode_area: string | null;
      bedrooms: string | null;
      lead_type: string;
      owner_source: "import" | "manual" | null;
      created_at: string;
      gross_annual_income: number | null;
      income_report_path: string | null;
      owner: { id: string; business_name: string } | null;
    }>
  ).map((l) => ({
    id: l.id,
    lead_name: l.lead_name,
    address: l.address,
    postcode_area: l.postcode_area,
    bedrooms: l.bedrooms,
    lead_type: l.lead_type,
    owner_source: l.owner_source,
    created_at: l.created_at,
    analysed: l.gross_annual_income != null,
    has_report: Boolean(l.income_report_path),
    owner_name: l.owner?.business_name ?? "—",
  }));

  const matching = count ?? leads.length;

  const stats = [
    { label: "Imported all time", value: totals.total.toLocaleString("en-GB") },
    {
      label: "From a spreadsheet",
      value: totals.from_import.toLocaleString("en-GB"),
    },
    { label: "Typed in one at a time", value: totals.from_manual.toLocaleString("en-GB") },
    { label: "Customers who have imported", value: totals.customers.toLocaleString("en-GB") },
    {
      label: "Analysed (paid)",
      value: `${totals.analysed.toLocaleString("en-GB")}${
        totals.total > 0
          ? ` · ${Math.round((totals.analysed / totals.total) * 100)}%`
          : ""
      }`,
    },
    {
      label: "Management / Guaranteed Rent",
      value: `${totals.management.toLocaleString("en-GB")} / ${totals.guaranteed_rent.toLocaleString("en-GB")}`,
    },
  ];

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold">Imported leads</h1>
        <p className="text-sm text-muted-foreground">
          Leads customers brought in themselves, by spreadsheet or by hand. These
          are never sold, escalated or pooled, and are excluded from every
          marketplace figure — so this is the only place they are counted.
        </p>
      </div>

      {/* ── All time ─────────────────────────────────────────────── */}
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm font-medium">All time</p>
          <dl className="mt-3 grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
            {stats.map((s) => (
              <div key={s.label}>
                <dt className="text-xs text-muted-foreground">{s.label}</dt>
                <dd className="mt-0.5 text-2xl font-semibold">{s.value}</dd>
              </div>
            ))}
          </dl>
          {totals.first_added && (
            <p className="mt-4 text-xs text-muted-foreground">
              First imported {formatDate(totals.first_added)}
              {totals.last_added && <> · most recent {formatDate(totals.last_added)}</>}
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── By month ─────────────────────────────────────────────── */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm font-medium">By month</p>
            {(selectedMonth || selectedCustomer) && (
              <Link href="/admin/imported-leads" className="text-sm underline underline-offset-2">
                Clear filter
              </Link>
            )}
          </div>
          {months.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">
              No customer has imported a lead yet.
            </p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b-[0.5px] border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">Month</th>
                    <th className="py-2 pr-4 text-right font-medium">Total</th>
                    <th className="py-2 pr-4 text-right font-medium">Spreadsheet</th>
                    <th className="py-2 pr-4 text-right font-medium">By hand</th>
                    <th className="py-2 pr-4 text-right font-medium">Mgmt</th>
                    <th className="py-2 pr-4 text-right font-medium">GR</th>
                    <th className="py-2 pr-4 text-right font-medium">Analysed</th>
                    <th className="py-2 text-right font-medium">Customers</th>
                  </tr>
                </thead>
                <tbody>
                  {months.map((m) => {
                    const active = selectedMonth?.month === m.month;
                    return (
                      <tr
                        key={m.month}
                        className={`border-b-[0.5px] border-border/60 ${active ? "bg-accent" : ""}`}
                      >
                        <td className="py-2 pr-4">
                          <Link
                            href={`/admin/imported-leads?month=${m.month}`}
                            className="font-medium underline-offset-2 hover:underline"
                          >
                            {monthLabel(m.month)}
                          </Link>
                        </td>
                        <td className="py-2 pr-4 text-right font-semibold">{m.total}</td>
                        <td className="py-2 pr-4 text-right text-muted-foreground">{m.from_import}</td>
                        <td className="py-2 pr-4 text-right text-muted-foreground">{m.from_manual}</td>
                        <td className="py-2 pr-4 text-right text-muted-foreground">{m.management}</td>
                        <td className="py-2 pr-4 text-right text-muted-foreground">{m.guaranteed_rent}</td>
                        <td className="py-2 pr-4 text-right text-muted-foreground">{m.analysed}</td>
                        <td className="py-2 text-right text-muted-foreground">{m.customers}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── By customer ──────────────────────────────────────────── */}
      {customers.length > 0 && (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm font-medium">By customer</p>
            <p className="mt-1 text-xs text-muted-foreground">
              One operator importing four hundred is a different business from
              forty importing ten.
            </p>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b-[0.5px] border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">Customer</th>
                    <th className="py-2 pr-4 text-right font-medium">Total</th>
                    <th className="py-2 pr-4 text-right font-medium">Spreadsheet</th>
                    <th className="py-2 pr-4 text-right font-medium">By hand</th>
                    <th className="py-2 pr-4 text-right font-medium">Analysed</th>
                    <th className="py-2 text-right font-medium">Last added</th>
                  </tr>
                </thead>
                <tbody>
                  {customers.map((c) => {
                    const active = selectedCustomer?.customer_id === c.customer_id;
                    return (
                      <tr
                        key={c.customer_id}
                        className={`border-b-[0.5px] border-border/60 ${active ? "bg-accent" : ""}`}
                      >
                        <td className="py-2 pr-4">
                          <Link
                            href={`/admin/imported-leads?customer=${c.customer_id}`}
                            className="font-medium underline-offset-2 hover:underline"
                          >
                            {c.business_name}
                          </Link>
                        </td>
                        <td className="py-2 pr-4 text-right font-semibold">{c.total}</td>
                        <td className="py-2 pr-4 text-right text-muted-foreground">{c.from_import}</td>
                        <td className="py-2 pr-4 text-right text-muted-foreground">{c.from_manual}</td>
                        <td className="py-2 pr-4 text-right text-muted-foreground">{c.analysed}</td>
                        <td className="py-2 text-right text-muted-foreground">
                          {c.last_added ? formatDate(c.last_added) : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── The leads themselves ─────────────────────────────────── */}
      <ImportedLeadsTable
        leads={leads}
        matching={matching}
        limit={LIST_LIMIT}
        filterLabel={
          selectedMonth
            ? monthLabel(selectedMonth.month)
            : selectedCustomer
              ? selectedCustomer.business_name
              : null
        }
      />
    </div>
  );
}
