"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * The three decisions on a dead-lead claim (CLAUDE.md §51).
 *
 * ⚠️ "Uphold as goodwill" is a separate button rather than a tick-box on
 * uphold, because the two differ in a way an admin has to CHOOSE between: a
 * plain uphold spends one of the customer's hidden allowance and a goodwill one
 * does not, so a claim that is probably right but unproven can be settled
 * without making the customer's next honest claim harder to get.
 *
 * Arm-then-confirm on decline only. Upholding costs one credit and is trivially
 * reversible by hand; declining is what the customer reads as an answer, and it
 * needs the note typed before it can fire.
 */
export function QualityClaimActions({ claimId }: { claimId: string }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [arming, setArming] = useState(false);

  async function decide(action: "uphold" | "uphold_goodwill" | "decline") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/quality-claims/${claimId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, note }),
      });
      const payload = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !payload.ok) {
        setError(payload.error ?? "Could not record that decision.");
        return;
      }
      router.refresh();
    } catch {
      setError("Could not record that decision.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 space-y-2">
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        placeholder="Note — shown to the customer on a decline."
        className="w-full rounded-md border-[0.5px] border-border bg-background px-2 py-1.5 text-sm"
      />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => decide("uphold")}
          disabled={busy}
          className="rounded-md bg-[#5D8156] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
        >
          Uphold
        </button>
        <button
          onClick={() => decide("uphold_goodwill")}
          disabled={busy}
          className="rounded-md border-[0.5px] border-border px-3 py-1.5 text-sm font-medium disabled:opacity-60"
        >
          Uphold as goodwill
        </button>
        {!arming ? (
          <button
            onClick={() => setArming(true)}
            disabled={busy}
            className="rounded-md border-[0.5px] border-border px-3 py-1.5 text-sm font-medium text-muted-foreground disabled:opacity-60"
          >
            Decline
          </button>
        ) : (
          <>
            <button
              onClick={() => decide("decline")}
              disabled={busy || note.trim().length === 0}
              className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
            >
              Confirm decline
            </button>
            <button
              onClick={() => setArming(false)}
              disabled={busy}
              className="rounded-md border-[0.5px] border-border px-3 py-1.5 text-sm"
            >
              Cancel
            </button>
          </>
        )}
      </div>
      {arming && note.trim().length === 0 && (
        <p className="text-xs text-muted-foreground">
          A decline needs a note — it is what the customer is shown.
        </p>
      )}
    </div>
  );
}
