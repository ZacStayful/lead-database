"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Sparkles, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ProductChooser } from "./AddLeadsPanel";
import {
  IMPORT_TARGETS,
  TARGET_LABELS,
  normaliseRow,
  resolveDuplicateClaims,
  type ImportTarget,
  type NormalisedRow,
} from "@/lib/leadImport";
import type { LeadType } from "@/lib/types";

interface PreviewColumn {
  index: number;
  header: string;
  target: ImportTarget;
  confidence: number;
  samples: string[];
}

interface PreviewResponse {
  import_id: string;
  lead_type: LeadType;
  file_name: string;
  row_count: number;
  mapping_source: "claude" | "heuristic";
  header_row_found: boolean;
  columns: PreviewColumn[];
  /** Raw cells, so the preview can be re-derived as the mapping changes. */
  preview_rows: string[][];
}

interface ImportResult {
  imported: number;
  duplicates: number;
  empty: number;
  total: number;
}

/** Below this the mapping is flagged for a look rather than presented as settled. */
const LOW_CONFIDENCE = 0.7;

/**
 * Spreadsheet import: upload, confirm what the columns mean, import.
 *
 * The confirmation step is not a formality and is never skipped, even when
 * every column resolved confidently. It is what lets the parser be generous
 * with a messy file: a wrong guess costs one dropdown change here, where an
 * import that silently guessed wrong puts a landlord's phone number in the
 * address field of two hundred leads.
 */
export function ImportLeadsPanel({ available }: { available: LeadType[] }) {
  const router = useRouter();
  const [leadType, setLeadType] = useState<LeadType>(available[0] ?? "management");
  const [uploading, setUploading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [mapping, setMapping] = useState<Record<number, ImportTarget>>({});
  const [result, setResult] = useState<ImportResult | null>(null);

  async function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    setUploading(true);
    setError(null);
    setResult(null);

    try {
      const body = new FormData();
      body.append("file", file);
      body.append("lead_type", leadType);

      const res = await fetch("/api/customer/my-leads/import/preview", {
        method: "POST",
        body,
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "Could not read that spreadsheet.");
        return;
      }

      setPreview(data as PreviewResponse);
      setMapping(
        Object.fromEntries(
          (data as PreviewResponse).columns.map((c) => [c.index, c.target])
        )
      );
    } catch {
      setError("Could not upload that file. Please try again.");
    } finally {
      setUploading(false);
      // Let the same file be picked again after a failure.
      event.target.value = "";
    }
  }

  async function commit() {
    if (!preview) return;
    setImporting(true);
    setError(null);

    try {
      const res = await fetch("/api/customer/my-leads/import/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          import_id: preview.import_id,
          mapping: Object.entries(mapping).map(([index, target]) => ({
            index: Number(index),
            target,
          })),
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "Could not import those leads.");
        return;
      }

      setResult(data as ImportResult);
      setPreview(null);
      router.refresh();
    } catch {
      setError("Could not reach the server. Please try again.");
    } finally {
      setImporting(false);
    }
  }

  /**
   * Re-derived from the raw rows on every mapping change, using the same
   * normaliseRow the commit route will run server-side. The point of this
   * screen is to let the customer disagree with our guess, so the preview has
   * to answer "what would this actually import" for THEIR mapping, not ours.
   */
  const previewRows: NormalisedRow[] = useMemo(() => {
    if (!preview) return [];
    const columns = preview.columns.map((c) => ({
      index: c.index,
      header: c.header,
      target: mapping[c.index] ?? "ignore",
      confidence: c.confidence,
    }));
    const resolved = resolveDuplicateClaims(columns);
    return preview.preview_rows.map((row) => normaliseRow(row, resolved));
  }, [preview, mapping]);

  const mappedTargets = Object.values(mapping);
  const hasContactField = mappedTargets.some(
    (t) => t === "name" || t === "email" || t === "phone" || t === "address"
  );

  if (result) {
    return (
      <div className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Import finished</h2>
          <p className="text-sm text-muted-foreground">
            {result.imported} lead{result.imported === 1 ? "" : "s"} added
            {result.duplicates > 0 &&
              `, ${result.duplicates} skipped as duplicates of leads you already had`}
            {result.empty > 0 && `, ${result.empty} blank row${result.empty === 1 ? "" : "s"} ignored`}
            .
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => router.push("/dashboard/leads")}>
            View your leads
          </Button>
          <Button variant="outline" onClick={() => setResult(null)}>
            Import another file
          </Button>
        </div>
      </div>
    );
  }

  if (preview) {
    return (
      <div className="space-y-5">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Check the columns</h2>
          <p className="text-sm text-muted-foreground">
            We read <span className="font-medium">{preview.file_name}</span> and
            found {preview.row_count} row{preview.row_count === 1 ? "" : "s"}.
            Here is what we think each column is — change anything we have got
            wrong before importing.
          </p>
        </div>

        {preview.mapping_source === "claude" && (
          <p className="flex items-start gap-2 rounded-lg border-[0.5px] border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
            <Sparkles className="mt-0.5 h-4 w-4 shrink-0" />
            Your spreadsheet did not have obvious headings for everything, so we
            worked out the columns from the data itself. Worth a quick look.
          </p>
        )}

        {!preview.header_row_found && (
          <p className="flex items-start gap-2 rounded-lg border-[0.5px] border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <span>
              We could not find a heading row, so the columns are named by
              position and the first row is being treated as a lead. If your
              file does have headings, check they line up below.
            </span>
          </p>
        )}

        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b-[0.5px] border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="py-2 pr-4 font-medium">Column in your file</th>
                <th className="py-2 pr-4 font-medium">Example values</th>
                <th className="py-2 font-medium">Import as</th>
              </tr>
            </thead>
            <tbody>
              {preview.columns.map((column) => {
                const chosen = mapping[column.index] ?? "ignore";
                const uncertain =
                  column.confidence < LOW_CONFIDENCE && chosen !== "ignore";
                return (
                  <tr key={column.index} className="border-b-[0.5px] border-border/60">
                    <td className="py-2 pr-4 align-top">
                      <span className="font-medium">{column.header}</span>
                      {uncertain && (
                        <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-700">
                          check this
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-4 align-top text-muted-foreground">
                      {column.samples.length ? (
                        <span className="line-clamp-2 block max-w-xs">
                          {column.samples.join(" · ")}
                        </span>
                      ) : (
                        <span className="italic">empty</span>
                      )}
                    </td>
                    <td className="py-2 align-top">
                      <select
                        value={chosen}
                        onChange={(e) =>
                          setMapping((prev) => ({
                            ...prev,
                            [column.index]: e.target.value as ImportTarget,
                          }))
                        }
                        className="rounded-md border-[0.5px] border-input bg-background px-2 py-1.5 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {IMPORT_TARGETS.map((target) => (
                          <option key={target} value={target}>
                            {TARGET_LABELS[target]}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-muted-foreground">
          Anything left as &ldquo;Don&rsquo;t import&rdquo; that still has
          something in it is kept on the lead&rsquo;s notes, so nothing on your
          spreadsheet is thrown away.
        </p>

        {previewRows.length > 0 && (
          <details className="rounded-lg border-[0.5px] border-border">
            <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
              Preview the first {previewRows.length} lead
              {previewRows.length === 1 ? "" : "s"}
            </summary>
            <div className="overflow-x-auto border-t-[0.5px] border-border">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Name</th>
                    <th className="px-3 py-2 font-medium">Phone</th>
                    <th className="px-3 py-2 font-medium">Email</th>
                    <th className="px-3 py-2 font-medium">Address</th>
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((row, i) => (
                    <tr key={i} className="border-t-[0.5px] border-border/60">
                      <td className="px-3 py-2">{row.name || "—"}</td>
                      <td className="px-3 py-2">{row.phone || "—"}</td>
                      <td className="px-3 py-2">{row.email || "—"}</td>
                      <td className="px-3 py-2">{row.address || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}

        {!hasContactField && (
          <p className="flex items-start gap-2 rounded-lg border-[0.5px] border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <span>
              No column is set to a name, phone, email or address, so every row
              would be skipped as blank. Map at least one before importing.
            </span>
          </p>
        )}

        {error && (
          <p className="rounded-lg border-[0.5px] border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={commit} disabled={importing || !hasContactField}>
            {importing
              ? "Importing…"
              : `Import ${preview.row_count} lead${preview.row_count === 1 ? "" : "s"}`}
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setPreview(null);
              setError(null);
            }}
            disabled={importing}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Import a spreadsheet</h2>
        <p className="text-sm text-muted-foreground">
          Upload an Excel file or CSV and we will work out what the columns
          mean. You get to check and correct that before anything is imported.
        </p>
      </div>

      <ProductChooser
        available={available}
        value={leadType}
        onChange={setLeadType}
        disabled={uploading}
      />

      <div className="rounded-lg border-[0.5px] border-border bg-muted/40 px-4 py-3 text-sm">
        <p className="font-medium">What works best</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
          <li>One row per landlord, with a heading row at the top.</li>
          <li>
            A column each for name, phone, email and address — any of them, in
            any order, named however you like.
          </li>
          <li>
            Anything else you keep is fine. We will ask what to do with it.
          </li>
        </ul>
        <p className="mt-2 text-muted-foreground">
          A messy file is fine too — a title above the headings, odd column
          names, extra columns. That is what the next step is for.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="import-file">Spreadsheet</Label>
        <input
          id="import-file"
          type="file"
          accept=".xlsx,.xls,.csv"
          onChange={onFile}
          disabled={uploading}
          className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-2 file:text-sm file:font-medium file:text-primary-foreground hover:file:opacity-90 disabled:opacity-50"
        />
      </div>

      {uploading && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Upload className="h-4 w-4 animate-pulse" />
          Reading your spreadsheet…
        </p>
      )}

      {error && (
        <p className="rounded-lg border-[0.5px] border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
