"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";

interface SyncResult {
  fetched: number;
  created: number;
  duplicates: number;
  assignments: number;
  errors?: string[];
}

/**
 * Admin button: pulls sellable leads from a Monday board into the app.
 * Defaults to the management board; pass `endpoint`/`label` for the GR board.
 */
export function SyncMondayButton({
  endpoint = "/api/monday/sync",
  label = "Sync from Monday",
}: {
  endpoint?: string;
  label?: string;
} = {}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function sync() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(endpoint, { method: "POST" });
      const data = (await res.json()) as SyncResult & { error?: string };
      if (!res.ok) {
        throw new Error(data.error ?? "Sync failed");
      }
      setMessage(
        `Synced ${data.fetched} lead${data.fetched === 1 ? "" : "s"}: ` +
          `${data.created} new, ${data.duplicates} already imported, ` +
          `${data.assignments} assignment${data.assignments === 1 ? "" : "s"}.`
      );
      router.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button onClick={sync} disabled={busy} variant="outline" size="sm">
        <RefreshCw className={"h-4 w-4" + (busy ? " animate-spin" : "")} />
        {busy ? "Syncing…" : label}
      </Button>
      {message && (
        <span className="max-w-xs text-right text-xs text-muted-foreground">
          {message}
        </span>
      )}
    </div>
  );
}
