"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Tags } from "lucide-react";

interface BackfillResult {
  mode: "dry-run" | "applied";
  customers: number;
  would_write: { email: string; value: string; cached: string | null }[];
  written: { email: string; value: string }[];
  failed: { email: string; reason: string }[];
  skipped: { email: string; reason: string }[];
  error?: string;
}

/**
 * Admin button: fill in "What kind of leads" on the Monday enquiries board for
 * every customer who already holds a product (§47).
 *
 * The SyncMondayButton / CheckLeadQualityButton pattern, with one addition:
 * DRY RUN FIRST, ALWAYS. This writes to somebody else's board, once per
 * customer, and the whole reason the route defaults to a dry run is that a
 * person should read the list before that happens. So the first press asks and
 * the second writes — arm-then-confirm, not a modal (§31.9), and the armed
 * state is dropped the moment the run finishes so it cannot be pressed twice by
 * accident.
 *
 * Self-draining: a customer whose cell already agrees is skipped on the cached
 * value, so pressing it again writes nothing.
 */
export function LeadInterestBackfillButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<BackfillResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function run(apply: boolean) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(
        "/api/admin/monday-lead-interest" + (apply ? "?apply=1" : ""),
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
            : `Wrote ${data.written.length} item${
                data.written.length === 1 ? "" : "s"
              }${failedNote}.`
        );
        router.refresh();
      } else if (data.would_write.length === 0) {
        setPending(null);
        setMessage(
          `Nothing to write — ${data.skipped.length} of ${data.customers} ` +
            "customers were skipped, which is expected: prospects and people " +
            "who have left keep whatever their cell says."
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
        <Tags className={"h-4 w-4" + (busy ? " animate-pulse" : "")} />
        {busy ? "Checking…" : "Fill in lead interest"}
      </Button>

      {pending && (
        <div className="mt-1 w-full max-w-md rounded-md border border-input p-3 text-left">
          <p className="text-sm font-medium">
            Write &ldquo;What kind of leads&rdquo; on {pending.would_write.length}{" "}
            Monday item
            {pending.would_write.length === 1 ? "" : "s"}?
          </p>
          <ul className="mt-2 max-h-48 space-y-0.5 overflow-y-auto text-xs text-muted-foreground">
            {pending.would_write.map((w) => (
              <li key={w.email}>
                {w.email} → <span className="font-medium">{w.value}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">
            {pending.skipped.length} other customer
            {pending.skipped.length === 1 ? " is" : "s are"} skipped — nobody who
            holds neither product has their cell touched.
          </p>
          <div className="mt-3 flex gap-2">
            <Button onClick={() => run(true)} disabled={busy} size="sm">
              {busy ? "Writing…" : "Write to Monday"}
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
