"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { FileText } from "lucide-react";

interface SweepResult {
  scanned: number;
  parsed: number;
  no_report: number;
  unparsed: number;
  failed: number;
  skipped: number;
  stored: number;
  storage_skipped: number;
  remaining: number;
  remaining_unbackfilled: number;
}

/**
 * Admin button: run the income-report sweep now instead of waiting for 12:00.
 *
 * The route has always accepted an admin session as well as the cron secret,
 * and its comments assumed it could be "triggered by hand from admin exactly as
 * the other crons can" — but there was no way to actually do that, so a backfill
 * meant typing a URL, and on a preview deployment meant signing into the app on
 * that origin first. This is the SyncMondayButton pattern, unchanged.
 *
 * Worth having beyond the one-off backfill: a report format change, or a spell
 * of Monday being unreachable, both leave a backlog somebody will want to drain
 * without waiting a day to find out whether it worked.
 */
export function ParseIncomeReportsButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/cron/parse-income-reports", {
        method: "POST",
      });
      const data = (await res.json()) as SweepResult & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Sweep failed");
      setMessage(
        `Read ${data.scanned} lead${data.scanned === 1 ? "" : "s"}: ` +
          `${data.parsed} newly parsed, ${data.stored} report${
            data.stored === 1 ? "" : "s"
          } stored. ` +
          `${data.remaining_unbackfilled} still to back-fill, ` +
          `${data.remaining} still to parse.`
      );
      router.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Sweep failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button onClick={run} disabled={busy} variant="outline" size="sm">
        <FileText className={"h-4 w-4" + (busy ? " animate-pulse" : "")} />
        {busy ? "Reading reports…" : "Read income reports"}
      </Button>
      {busy && !message && (
        // A first backfill reads ~160 PDFs and can hold this request for a
        // couple of minutes. Saying so is what stops it looking hung.
        <span className="max-w-xs text-right text-xs text-muted-foreground">
          A backlog can take a few minutes — leave this tab open.
        </span>
      )}
      {message && (
        <span className="max-w-xs text-right text-xs text-muted-foreground">
          {message}
        </span>
      )}
    </div>
  );
}
