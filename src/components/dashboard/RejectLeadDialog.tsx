"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type RejectReason = "not_a_fit" | "invalid_contact";

type RejectResult = {
  outcome: "processed" | "denied";
  message: string;
  claimDenied: boolean;
};

const REASONS: { value: RejectReason; label: string }[] = [
  { value: "not_a_fit", label: "Does not fit my needs" },
  { value: "invalid_contact", label: "Invalid email or mobile" },
];

const GENERIC_ERROR = "Something went wrong. Please try again.";

/**
 * Reject-reason dialog. Opens from the existing "Reject this lead" trigger and
 * captures a required reason before hitting the reject route. The
 * invalid_contact path runs live external lookups server-side, so the submit
 * button shows a loading state while the request is in flight.
 *
 * On a completed request (processed or denied) it hands the result to the
 * parent (which shows the message and updates the lead) and closes. On an error
 * outcome or a failed request it shows a generic error inline, re-enables submit
 * and stays open so the customer can retry.
 */
export function RejectLeadDialog({
  open,
  onOpenChange,
  leadId,
  assignmentId,
  onResult,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadId: string;
  assignmentId: string;
  onResult: (result: RejectResult) => void;
}) {
  const [reason, setReason] = useState<RejectReason | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleOpenChange(next: boolean) {
    // Don't allow closing mid-request. Reset state when the dialog closes.
    if (submitting) return;
    if (!next) {
      setReason(null);
      setError(null);
    }
    onOpenChange(next);
  }

  async function handleSubmit() {
    if (!reason || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/leads/${leadId}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignment_id: assignmentId, reason }),
      });

      const data = (await res.json().catch(() => null)) as
        | { outcome?: string; message?: string; claimDenied?: boolean }
        | null;

      if (
        !res.ok ||
        !data ||
        data.outcome === "error" ||
        (data.outcome !== "processed" && data.outcome !== "denied")
      ) {
        setError(data?.message || GENERIC_ERROR);
        setSubmitting(false);
        return;
      }

      // Completed cleanly — hand the outcome up and close.
      onResult({
        outcome: data.outcome,
        message: data.message || "",
        claimDenied: Boolean(data.claimDenied),
      });
      setReason(null);
      setSubmitting(false);
      onOpenChange(false);
    } catch {
      // The request itself didn't complete (dropped network, etc.).
      setError(GENERIC_ERROR);
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Why are you rejecting this lead?</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          {REASONS.map((option) => {
            const selected = reason === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => setReason(option.value)}
                disabled={submitting}
                aria-pressed={selected}
                className={
                  "w-full rounded-lg border px-4 py-3 text-left text-sm font-medium transition-colors disabled:opacity-60 " +
                  (selected
                    ? "border-[#3B6D11] bg-[#3B6D11]/5 text-[#1a1a1a]"
                    : "border-black/10 text-[#52514e] hover:bg-gray-50")
                }
              >
                {option.label}
              </button>
            );
          })}
        </div>

        {error && (
          <p className="text-sm text-red-600" role="alert">
            {error}
          </p>
        )}

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => handleSubmit()}
            disabled={!reason || submitting}
            className="flex-1 rounded-lg bg-[#3B6D11] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#2d5409] disabled:opacity-60"
          >
            {submitting ? "Checking…" : "Confirm rejection"}
          </button>
          <button
            type="button"
            onClick={() => handleOpenChange(false)}
            disabled={submitting}
            className="flex-1 rounded-lg border border-black/10 px-4 py-2.5 text-sm font-medium text-[#52514e] transition-colors hover:bg-gray-50 disabled:opacity-60"
          >
            Cancel
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
