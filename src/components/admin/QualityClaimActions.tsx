"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Uphold or decline one dead-lead claim.
 *
 * Upholding runs the same resolution as the automatic path: the credit goes
 * back and is spent on a different lead where one is available. "Uphold as
 * goodwill" does the same but without spending the customer's hidden
 * allowance, for the cases that were plainly our fault.
 */
export function QualityClaimActions({ claimId }: { claimId: string }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(upheld: boolean, consumesAllowance: boolean) {
    if (busy) return;
    if (!upheld && note.trim().length === 0) {
      setError("Give a reason — the customer sees it.");
      return;
    }
    setBusy(upheld ? (consumesAllowance ? "uphold" : "goodwill") : "decline");
    setError(null);
    try {
      const res = await fetch(`/api/admin/quality-claims/${claimId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          upheld,
          note: note.trim() || undefined,
          consumes_allowance: consumesAllowance,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setError(data?.error ?? "Could not save that. Please try again.");
        setBusy(null);
        return;
      }
      router.refresh();
    } catch {
      setError("Could not save that. Please try again.");
      setBusy(null);
    }
  }

  return (
    <div className="space-y-2">
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        disabled={busy !== null}
        rows={2}
        placeholder="Note to the customer (required when declining)"
        className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm outline-none focus:border-brand disabled:opacity-60"
      />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => decide(true, true)}
          disabled={busy !== null}
          className="rounded-md bg-brand px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60"
        >
          {busy === "uphold" ? "Saving…" : "Uphold"}
        </button>
        <button
          type="button"
          onClick={() => decide(true, false)}
          disabled={busy !== null}
          className="rounded-md border border-black/10 px-3 py-1.5 text-xs font-medium text-muted-foreground disabled:opacity-60"
        >
          {busy === "goodwill" ? "Saving…" : "Uphold as goodwill"}
        </button>
        <button
          type="button"
          onClick={() => decide(false, false)}
          disabled={busy !== null}
          className="rounded-md border border-red-200 px-3 py-1.5 text-xs font-medium text-red-700 disabled:opacity-60"
        >
          {busy === "decline" ? "Saving…" : "Decline"}
        </button>
      </div>
      {error && (
        <p className="text-xs text-red-600" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
