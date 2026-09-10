"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { isDeadLeadReason, MIN_DETAIL_LENGTH } from "@/lib/quality/claimPolicy";
import type { RejectReason } from "@/lib/types";

export type RejectOutcome = "processed" | "pending" | "denied";

type RejectResult = {
  outcome: RejectOutcome;
  message: string;
  claimDenied: boolean;
};

const REASONS: { value: RejectReason; label: string; hint?: string }[] = [
  { value: "not_a_fit", label: "Does not fit my needs" },
  { value: "invalid_contact", label: "Invalid email or mobile" },
  {
    value: "already_with_operator",
    label: "Already signed with another operator",
    hint: "The landlord had appointed someone else before you got to them.",
  },
  {
    value: "no_longer_interested",
    label: "No longer wants to let the property",
    hint: "They have changed their mind or taken the property off the market.",
  },
  {
    value: "unreachable",
    label: "Could not reach them at all",
    hint: "Several attempts across more than one channel, no response.",
  },
];

const GENERIC_ERROR = "Something went wrong. Please try again.";

/**
 * Reject-reason dialog.
 *
 * Two shapes behind one trigger. The original two reasons submit immediately:
 * 'not_a_fit' is chargeable, 'invalid_contact' runs live phone/email lookups
 * server-side. The three dead-lead reasons open a short report — what the
 * landlord said and when you spoke to them — because a claim that the lead was
 * already gone cannot be verified by any external service, so the detail is
 * what makes it reviewable.
 *
 * On a completed request it hands the result to the parent and closes. An
 * 'ineligible' response (for example, no note on the lead yet) is shown inline
 * with the specific thing that is missing, and the dialog stays open.
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
  const [detail, setDetail] = useState("");
  const [contactedOn, setContactedOn] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsReport = reason !== null && isDeadLeadReason(reason);
  const reportComplete =
    detail.trim().length >= MIN_DETAIL_LENGTH && contactedOn !== "";
  const canSubmit =
    reason !== null && !submitting && (!needsReport || reportComplete);

  function reset() {
    setReason(null);
    setDetail("");
    setContactedOn("");
    setError(null);
  }

  function handleOpenChange(next: boolean) {
    // Don't allow closing mid-request. Reset state when the dialog closes.
    if (submitting) return;
    if (!next) reset();
    onOpenChange(next);
  }

  function pickReason(next: RejectReason) {
    setReason(next);
    setError(null);
  }

  async function handleSubmit() {
    if (!canSubmit || !reason) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/leads/${leadId}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assignment_id: assignmentId,
          reason,
          ...(needsReport
            ? { detail: detail.trim(), contacted_on: contactedOn }
            : {}),
        }),
      });

      const data = (await res.json().catch(() => null)) as
        | { outcome?: string; message?: string; claimDenied?: boolean }
        | null;

      // Not actionable yet — the message names what is missing, so keep the
      // dialog open rather than treating it as a failure.
      if (res.ok && data?.outcome === "ineligible") {
        setError(data.message || GENERIC_ERROR);
        setSubmitting(false);
        return;
      }

      if (
        !res.ok ||
        !data ||
        (data.outcome !== "processed" &&
          data.outcome !== "pending" &&
          data.outcome !== "denied")
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
      reset();
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
                onClick={() => pickReason(option.value)}
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
                {option.hint && selected && (
                  <span className="mt-1 block text-xs font-normal text-[#6b6a67]">
                    {option.hint}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {needsReport && (
          <div className="flex flex-col gap-3 rounded-lg border border-black/10 p-3">
            <p className="text-xs text-[#6b6a67]">
              We look into every one of these to work out where the lead went
              wrong, so the more you can tell us the better.
            </p>

            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-[#52514e]">
                What did the landlord say?
              </span>
              <textarea
                value={detail}
                onChange={(e) => setDetail(e.target.value)}
                disabled={submitting}
                rows={3}
                placeholder="e.g. They told me they signed with another agent two weeks ago."
                className="rounded-lg border border-black/10 px-3 py-2 text-sm outline-none focus:border-[#3B6D11] disabled:opacity-60"
              />
              {detail.trim().length > 0 &&
                detail.trim().length < MIN_DETAIL_LENGTH && (
                  <span className="text-xs text-[#6b6a67]">
                    A little more detail, please.
                  </span>
                )}
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-[#52514e]">
                When did you speak to them?
              </span>
              <input
                type="date"
                value={contactedOn}
                onChange={(e) => setContactedOn(e.target.value)}
                disabled={submitting}
                className="rounded-lg border border-black/10 px-3 py-2 text-sm outline-none focus:border-[#3B6D11] disabled:opacity-60"
              />
            </label>
          </div>
        )}

        {error && (
          <p className="text-sm text-red-600" role="alert">
            {error}
          </p>
        )}

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => handleSubmit()}
            disabled={!canSubmit}
            className="flex-1 rounded-lg bg-[#3B6D11] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#2d5409] disabled:opacity-60"
          >
            {submitting
              ? "Checking…"
              : needsReport
                ? "Report this lead"
                : "Confirm rejection"}
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
