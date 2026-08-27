"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ShieldCheck } from "lucide-react";

interface CheckResult {
  examined: number;
  passed: number;
  failed_blocked: number;
  failed_already_sold_marked_only: number;
  write_errors: number;
  reasons: Record<string, number>;
}

/**
 * Admin button: judge every lead that has not been judged yet (0111).
 *
 * The SyncMondayButton / ParseIncomeReportsButton pattern, unchanged. This is
 * the backfill — it is a button rather than SQL in the migration because the
 * rules live in `src/lib/leadQuality.ts` and running them twice, once in
 * TypeScript and once transcribed into SQL, is the drift this codebase keeps
 * recording (§20, §26.7).
 *
 * Self-draining: it only ever looks at `pending` rows, so pressing it twice
 * does nothing the second time. Worth keeping afterwards for the case where a
 * new ingest path lands without stamping.
 */
export function CheckLeadQualityButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/leads/quality-check", {
        method: "POST",
      });
      const data = (await res.json()) as CheckResult & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Check failed");

      if (data.examined === 0) {
        setMessage("Nothing left to check — every lead has been judged.");
      } else {
        setMessage(
          `Checked ${data.examined} lead${data.examined === 1 ? "" : "s"}: ` +
            `${data.passed} passed, ${data.failed_blocked} blocked` +
            (data.failed_already_sold_marked_only > 0
              ? `, ${data.failed_already_sold_marked_only} already delivered ` +
                `so marked but still routing`
              : "") +
            "."
        );
      }
      router.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Check failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button onClick={run} disabled={busy} variant="outline" size="sm">
        <ShieldCheck className={"h-4 w-4" + (busy ? " animate-pulse" : "")} />
        {busy ? "Checking…" : "Check lead quality"}
      </Button>
      {message && (
        <span className="max-w-xs text-right text-xs text-muted-foreground">
          {message}
        </span>
      )}
    </div>
  );
}
