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

/** Admin button: pulls sellable leads from the Monday board into the app. */
export function SyncMondayButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function sync() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/monday/sync", { method: "POST" });
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
        {busy ? "Syncing…" : "Sync from Monday"}
      </Button>
      {message && (
        <span className="max-w-xs text-right text-xs text-muted-foreground">
          {message}
        </span>
      )}
    </div>
  );
}
