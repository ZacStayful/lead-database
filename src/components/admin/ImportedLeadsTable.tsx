"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export interface ImportedLeadRow {
  id: string;
  lead_name: string;
  address: string | null;
  postcode_area: string | null;
  bedrooms: string | null;
  lead_type: string;
  owner_source: "import" | "manual" | null;
  created_at: string;
  /** The paid analysis has landed — a gross figure is what every run produces. */
  analysed: boolean;
  has_report: boolean;
  owner_name: string;
}

/**
 * The leads themselves, under the three aggregate views.
 *
 * Client-side only for SEARCH and the source/product toggles, over rows the
 * server has already narrowed. The month and customer filters are links rather
 * than state, because those are the ones that change which rows are FETCHED —
 * filtering thousands of leads in the browser is how a page stays fast right up
 * until the day it doesn't.
 */
export function ImportedLeadsTable({
  leads,
  matching,
  limit,
  filterLabel,
}: {
  leads: ImportedLeadRow[];
  /** How many leads match the server-side filter, before the display cap. */
  matching: number;
  limit: number;
  filterLabel: string | null;
}) {
  const [search, setSearch] = useState("");
  const [source, setSource] = useState<"all" | "import" | "manual">("all");
  const [analysed, setAnalysed] = useState<"all" | "yes" | "no">("all");

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return leads.filter((l) => {
      if (source !== "all" && l.owner_source !== source) return false;
      if (analysed === "yes" && !l.analysed) return false;
      if (analysed === "no" && l.analysed) return false;
      if (!q) return true;
      return (
        l.lead_name.toLowerCase().includes(q) ||
        (l.address ?? "").toLowerCase().includes(q) ||
        l.owner_name.toLowerCase().includes(q)
      );
    });
  }, [leads, search, source, analysed]);

  const truncated = matching > leads.length;

  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-sm font-medium">
            {filterLabel ? `Leads — ${filterLabel}` : "Leads"}
          </p>
          <p className="text-xs text-muted-foreground">
            {truncated ? (
              <>
                showing the {leads.length} most recent of{" "}
                {matching.toLocaleString("en-GB")} — pick a month or a customer
                above to narrow it
              </>
            ) : (
              <>
                {shown.length === leads.length
                  ? `${leads.length.toLocaleString("en-GB")} lead${leads.length === 1 ? "" : "s"}`
                  : `${shown.length} of ${leads.length}`}
              </>
            )}
          </p>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, address or customer"
            className="max-w-xs"
          />
          <Toggle
            value={source}
            onChange={setSource}
            options={[
              ["all", "All sources"],
              ["import", "Spreadsheet"],
              ["manual", "By hand"],
            ]}
          />
          <Toggle
            value={analysed}
            onChange={setAnalysed}
            options={[
              ["all", "All"],
              ["yes", "Analysed"],
              ["no", "Not analysed"],
            ]}
          />
        </div>

        {shown.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">
            {leads.length === 0
              ? "No imported leads here."
              : "Nothing matches that."}
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead>
                <tr className="border-b-[0.5px] border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">Lead</th>
                  <th className="py-2 pr-4 font-medium">Added by</th>
                  <th className="py-2 pr-4 font-medium">Source</th>
                  <th className="py-2 pr-4 font-medium">Product</th>
                  <th className="py-2 pr-4 font-medium">Figures</th>
                  <th className="py-2 font-medium">Added</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((l) => (
                  <tr key={l.id} className="border-b-[0.5px] border-border/60 align-top">
                    <td className="py-2 pr-4">
                      <Link
                        href={`/admin/leads/${l.id}`}
                        className="font-medium underline-offset-2 hover:underline"
                      >
                        {l.lead_name}
                      </Link>
                      {l.address && (
                        <span className="block text-xs text-muted-foreground">
                          {l.address}
                          {l.bedrooms && ` · ${l.bedrooms} bed`}
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-4">{l.owner_name}</td>
                    <td className="py-2 pr-4 text-muted-foreground">
                      {l.owner_source === "manual" ? "By hand" : "Spreadsheet"}
                    </td>
                    <td className="py-2 pr-4 text-muted-foreground">
                      {l.lead_type === "guaranteed_rent" ? "Guaranteed Rent" : "Management"}
                    </td>
                    <td className="py-2 pr-4">
                      {l.analysed ? (
                        <span className="rounded bg-brand/10 px-1.5 py-0.5 text-xs font-medium text-brand">
                          Analysed{l.has_report ? " · PDF" : ""}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="py-2 text-muted-foreground">
                      {formatDate(l.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Toggle<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<[T, string]>;
}) {
  return (
    <div className="inline-flex rounded-md border-[0.5px] border-border">
      {options.map(([key, label], i) => (
        <button
          key={key}
          type="button"
          onClick={() => onChange(key)}
          className={`px-3 py-1.5 text-sm ${
            value === key ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent/50"
          } ${i === 0 ? "rounded-l-md" : ""} ${i === options.length - 1 ? "rounded-r-md" : ""}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Europe/London",
  }).format(new Date(iso));
}
