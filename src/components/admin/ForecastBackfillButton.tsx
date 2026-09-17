"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Gauge } from "lucide-react";

interface BackfillResult {
  mode: "dry-run" | "applied";
  customers: number;
  would_write: {
    email: string;
    product: string;
    expected: number;
    likelihood_pct: number | null;
    cost_per_lead_pence: number | null;
  }[];
  written: { email: string; product: string; expected: number }[];
  failed: { email: string; product: string; reason: string }[];
  skipped: { email: string; product: string; reason: string }[];
  error?: string;
}

function productShort(p: string) {
  return p === "guaranteed_rent" ? "GR" : "Mgmt";
}

/**
 * Admin button: store a forecast for every active filter that has none (§58).
 *
 * The LeadInterestBackfillButton pattern — dry run first, always, then an
 * arm-then-confirm write. What is being written is the "at least N a month,
 * P% likely, £X a lead" line on a customer's own filtering page, so the list
 * is worth reading before it lands.
 */
export function ForecastBackfillButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<BackfillResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function run(apply: boolean) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(
        "/api/admin/filters/backfill-forecast" + (apply ? "?apply=1" : ""),
        { method: "POST" }
      );
      const data = (await res.json()) as BackfillResult;
      if (!res.ok) throw new Error(data.error ?? "Backfill failed");

      if (apply) {
        setPending(null);
        const failedNote = data.failed.length
          ? `, ${data.failed.length} failed (${data.failed
              .map((f) => f.reason)
              .join(", ")})`
          : "";
        setMessage(
          data.written.length === 0
            ? "Nothing needed writing."
            : `Stored a forecast on ${data.written.length} filter${
                data.written.length === 1 ? "" : "s"
              }${failedNote}.`
        );
        router.refresh();
      } else if (data.would_write.length === 0) {
        setPending(null);
        const notOfferable = data.skipped.filter((s) =>
          s.reason.startsWith("not_offerable")
        ).length;
        setMessage(
          "Nothing to write — every active filter already carries a figure" +
            (notOfferable > 0
              ? `, apart from ${notOfferable} with too little history to forecast.`
              : ".")
        );
      } else {
        setPending(data);
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Backfill failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        onClick={() => run(false)}
        disabled={busy}
        variant="outline"
        size="sm"
      >
        <Gauge className={"h-4 w-4" + (busy ? " animate-pulse" : "")} />
        {busy ? "Checking…" : "Fill in filter forecasts"}
      </Button>

      {pending && (
        <div className="mt-1 w-full max-w-md rounded-md border border-input p-3 text-left">
          <p className="text-sm font-medium">
            Store a forecast on {pending.would_write.length} filter
            {pending.would_write.length === 1 ? "" : "s"}?
          </p>
          <ul className="mt-2 max-h-48 space-y-0.5 overflow-y-auto text-xs text-muted-foreground">
            {pending.would_write.map((w) => (
              <li key={`${w.email}:${w.product}`}>
                {w.email} ({productShort(w.product)}) →{" "}
                <span className="font-medium">
                  at least {w.expected}/month
                  {w.likelihood_pct != null ? `, ${w.likelihood_pct}% likely` : ""}
                  {w.cost_per_lead_pence != null
                    ? `, £${(w.cost_per_lead_pence / 100).toFixed(2)} a lead`
                    : ""}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">
            Filters that already carry a figure are left exactly as they are,
            and nobody is marked as having acknowledged anything.
          </p>
          <div className="mt-3 flex gap-2">
            <Button onClick={() => run(true)} disabled={busy} size="sm">
              {busy ? "Writing…" : "Store forecasts"}
            </Button>
            <Button
              onClick={() => setPending(null)}
              disabled={busy}
              variant="ghost"
              size="sm"
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {message && (
        <span className="max-w-xs text-right text-xs text-muted-foreground">
          {message}
        </span>
      )}
    </div>
  );
}
