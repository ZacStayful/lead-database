"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  NOT_FOR_ME_COPY,
  NOT_FOR_ME_REASONS,
  type NotForMeReason,
} from "@/lib/leadBrief/labelCopy";

/**
 * "Not for me" (Lead Brief Phase 5, D10): a brief customer passing on a Strong
 * match or Nearby opportunity in two clicks.
 *
 * It is the EXISTING reject — the same route, the same SQL, the same rules
 * (cold stage only, not won, not already rejected, not their own lead) — with
 * three of its reasons preset. Final and chargeable, exactly as reject is, and
 * nothing here mentions a replacement (A12.2, D10).
 *
 * ⚠️ Only the contact panel's "Why" panel renders it. Never on the card, and
 * never beside "report a dead lead": a chargeable and a refundable control a
 * click apart get used interchangeably (§51.6, §51.10).
 */
export function NotForMe({
  onReject,
}: {
  onReject: (reason: NotForMeReason, detail: string) => Promise<void> | void;
}) {
  const [step, setStep] = useState<"idle" | "choose" | "confirm">("idle");
  const [reason, setReason] = useState<NotForMeReason | null>(null);
  const [busy, setBusy] = useState(false);

  if (step === "idle") {
    return (
      <div>
        <Button variant="outline" size="sm" onClick={() => setStep("choose")}>
          {NOT_FOR_ME_COPY.button}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-md border border-line bg-white p-3">
      <p className="font-medium text-ink">{NOT_FOR_ME_COPY.prompt}</p>
      <div className="flex flex-col gap-1.5">
        {NOT_FOR_ME_REASONS.map((r) => (
          <label key={r} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="not-for-me-reason"
              checked={reason === r}
              onChange={() => {
                setReason(r);
                setStep("confirm");
              }}
            />
            {NOT_FOR_ME_COPY.reasons[r]}
          </label>
        ))}
      </div>
      {step === "confirm" && reason && (
        <>
          <p className="text-ink-2">{NOT_FOR_ME_COPY.consequence}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onReject(reason, "");
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? NOT_FOR_ME_COPY.working : NOT_FOR_ME_COPY.confirm}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setReason(null);
                setStep("idle");
              }}
            >
              {NOT_FOR_ME_COPY.cancel}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
