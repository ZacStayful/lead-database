"use client";

/**
 * The API kill switch, on /admin/api.
 *
 * Turning it OFF is the destructive direction — every customer integration
 * stops — so that direction confirms inline, following the reject confirmation
 * in LeadDetail. Turning it back on does not: restoring service is not
 * something anybody needs protecting from.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";

export function ApiKillSwitch({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function set(next: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/settings/api-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error ?? "Could not change that setting.");
        return;
      }
      setConfirming(false);
      router.refresh();
    } catch {
      setError("Could not change that setting.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={`inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium ${
            enabled
              ? "bg-emerald-50 text-emerald-800"
              : "bg-red-50 text-red-800"
          }`}
        >
          <span
            className={`h-2 w-2 rounded-full ${enabled ? "bg-emerald-600" : "bg-red-600"}`}
          />
          {enabled ? "API and MCP are live" : "API and MCP are switched off"}
        </span>

        {enabled && !confirming && (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={busy}
            className="rounded-md border-[0.5px] border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent disabled:opacity-50"
          >
            Switch off
          </button>
        )}

        {!enabled && (
          <button
            type="button"
            onClick={() => void set(true)}
            disabled={busy}
            className="rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-brand-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Switching on…" : "Switch back on"}
          </button>
        )}
      </div>

      {confirming && (
        <div className="rounded-md border-[0.5px] border-border bg-muted/30 p-4">
          <p className="mb-3 text-sm">
            Switch off the API and MCP server for <strong>every customer</strong>?
            Any workflow, script or AI assistant using a key stops working within
            about 30 seconds and receives a 503. Customers can still sign in, use
            the dashboard, and revoke their own keys.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void set(false)}
              disabled={busy}
              className="rounded-md border-[0.5px] border-red-300 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-700 transition-colors hover:bg-red-100 disabled:opacity-50"
            >
              {busy ? "Switching off…" : "Confirm — switch off"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-md border-[0.5px] border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && <p className="text-sm text-red-700">{error}</p>}
    </div>
  );
}
