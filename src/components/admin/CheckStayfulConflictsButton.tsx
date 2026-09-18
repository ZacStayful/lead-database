"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ShieldAlert } from "lucide-react";

interface SweepResult {
  ok: boolean;
  dry_run: boolean;
  fetched: number;
  examined: number;
  matched: number;
  flagged: number;
  withdrawn: number;
  fulfilled: number;
  owed_waiting: number;
  owed_open: number;
  truncated?: boolean;
  would_flag?: { lead_name: string; matched_by: string; live_assignments: number }[];
  errors: string[];
  skipped?: string;
  error?: string;
}

/**
 * Admin button: run the Stayful-pipeline sweep now (§64).
 *
 * The CheckLeadQualityButton pattern. With the switch OFF it runs a dry run
 * and reports what would be withdrawn — which is how the first run is read
 * before anything is switched on. With it ON the first press is still a dry
 * run; a second, armed press runs for real. Arm-then-confirm, never a modal
 * (§31.9): a single click must never withdraw twenty leads.
 */
export function CheckStayfulConflictsButton({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function run(dryRun: boolean) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(
        `/api/cron/stayful-conflict-sweep${dryRun ? "?dryRun=true" : ""}`,
        { method: "POST" }
      );
      const data = (await res.json()) as SweepResult;
      if (!res.ok) throw new Error(data.error ?? data.errors?.[0] ?? "Check failed");
      if (data.skipped) {
        setMessage("The switch is off — nothing was run.");
        return;
      }

      if (dryRun) {
        const live = (data.would_flag ?? []).reduce((s, r) => s + r.live_assignments, 0);
        setMessage(
          `Dry run: ${data.fetched} pipeline items read, ${data.matched} of ${data.examined} ` +
            `leads match${live > 0 ? ` (${live} live assignment${live === 1 ? "" : "s"} would be withdrawn)` : ""}` +
            (data.owed_open > 0 ? ` · ${data.owed_open} replacement${data.owed_open === 1 ? "" : "s"} still owed` : "") +
            (enabled && data.matched > 0 ? ". Press again to run for real." : ".")
        );
        setArmed(enabled && data.matched > 0);
      } else {
        setMessage(
          `Flagged ${data.flagged}, withdrew ${data.withdrawn}, replaced ${data.fulfilled}` +
            (data.owed_open > 0 ? `, ${data.owed_open} still owed` : "") +
            (data.truncated ? " (stopped on the wall clock — the next tick continues)" : ".") +
            (data.errors.length > 0 ? ` ${data.errors.length} error${data.errors.length === 1 ? "" : "s"}.` : "")
        );
        setArmed(false);
        router.refresh();
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Check failed");
      setArmed(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        onClick={() => run(!armed)}
        disabled={busy}
        variant={armed ? "default" : "outline"}
        size="sm"
      >
        <ShieldAlert className={"h-4 w-4" + (busy ? " animate-pulse" : "")} />
        {busy ? "Checking…" : armed ? "Withdraw and replace now" : "Check Stayful conflicts"}
      </Button>
      {message && (
        <span className="max-w-xs text-right text-xs text-muted-foreground">
          {message}
        </span>
      )}
    </div>
  );
}
