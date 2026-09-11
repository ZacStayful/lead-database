"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { SwapLeadControl } from "@/components/admin/SwapLeadControl";

/**
 * The four decisions on a dead-lead claim (CLAUDE.md §51, 0139).
 *
 * ⚠️ "Uphold as goodwill" is a separate button rather than a tick-box on
 * uphold, because the two differ in a way an admin has to CHOOSE between: a
 * plain uphold spends one of the customer's hidden allowance and a goodwill one
 * does not, so a claim that is probably right but unproven can be settled
 * without making the customer's next honest claim harder to get.
 *
 * ⚠️ "Uphold with a replacement" is the 0139 addition, and it is ALWAYS a
 * manual decision — nothing auto-upholds into a swap. It costs two leads rather
 * than one: the reported lead is withdrawn from circulation as well as a
 * replacement being handed over, and management stock is thin (about seventy
 * leads carry a free slot). It also spends no credit, because the customer
 * keeps the slot they already paid for.
 *
 * Arm-then-confirm on decline and on the swap. Upholding costs one credit and
 * is trivially reversible by hand; declining is what the customer reads as an
 * answer, and a swap destroys their notes on the reported lead — neither should
 * be one press.
 */
export function QualityClaimActions({
  claimId,
  assignmentId,
  leadName,
  noteCount = 0,
}: {
  claimId: string;
  /** Nullable since 0139 — a settled swap nulls the claim's pointer. */
  assignmentId?: string | null;
  leadName?: string | null;
  /**
   * ⚠️ Named in the consequences, because a swap DELETES it along with the
   * assignment. A claimed lead is likelier than average to carry notes —
   * reporting one requires having worked it — and the customer never sees the
   * warning the admin does.
   */
  noteCount?: number;
}) {
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

      {/*
        The picker is the same one the customer page uses, so the lead filter
        guard, the matching-first ordering, the hidden off-filter group and the
        named acknowledgement all come for free. Only the SUBMIT differs: a
        claim settles through its own route, in one transaction.
      */}
      {assignmentId && (
        <div className="border-t-[0.5px] border-border pt-2">
          <SwapLeadControl
            assignmentId={assignmentId}
            leadName={leadName ?? null}
            status={null}
            triggerLabel="Uphold with a replacement lead"
            extraConsequence={
              `This settles the report. No credit goes back — the replacement is the answer.` +
              (noteCount > 0
                ? ` Their ${noteCount} note${noteCount === 1 ? "" : "s"} on this lead ${noteCount === 1 ? "is" : "are"} deleted with it.`
                : "")
            }
            submit={async (leadId, allowFilterMismatch) => {
              const res = await fetch(`/api/admin/quality-claims/${claimId}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  action: "uphold_swap",
                  note,
                  new_lead_id: leadId,
                  allow_filter_mismatch: allowFilterMismatch,
                }),
              });
              const payload = (await res.json().catch(() => null)) as {
                ok?: boolean;
                error?: string;
                notified?: boolean;
              } | null;
              return {
                ok: Boolean(res.ok && payload?.ok),
                error: payload?.error,
                notified: payload?.notified,
              };
            }}
          />
        </div>
      )}
    </div>
  );
}
