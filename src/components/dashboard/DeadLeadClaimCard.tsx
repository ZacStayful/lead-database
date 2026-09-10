"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle } from "lucide-react";
import {
  DEAD_LEAD_REASON_LABELS,
  DEAD_LEAD_REASONS,
  MIN_DETAIL_LENGTH,
  type DeadLeadReason,
} from "@/lib/quality/deadLeadCopy";

/**
 * Report a lead that was already gone before the operator reached it (§51).
 *
 * ⚠️ WORDED AS REPORTING, NEVER AS REJECTING. Reject is the settled, chargeable
 * outcome on a lead the operator worked and did not win, and nothing about it
 * changes here. This is a different claim entirely — that the lead was void
 * when we sold it — and two controls a click apart that read alike would be
 * used interchangeably, which is exactly the fishing this feature has to avoid.
 *
 * ⚠️ NOTHING HERE MENTIONS THE ALLOWANCE, and no copy added to it ever may.
 * The whole mechanism rests on the number being discovered rather than
 * announced (§51), and this card is the only surface a customer sees it from.
 * The two outcomes are deliberately worded so that an operator whose claim was
 * upheld automatically and one whose claim went to review cannot tell from the
 * wording which of them was over the line.
 *
 * It renders only when the route would actually accept a claim — the page
 * resolves that through `deadLeadClaimState`, which fails closed. An offered
 * control that 400s reads as a bug (§18E).
 */
export function DeadLeadClaimCard({
  assignmentId,
  claimable,
  claimStatus,
}: {
  assignmentId: string;
  claimable: boolean;
  /** Set when this assignment already carries a claim. One per assignment, ever. */
  claimStatus: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<DeadLeadReason | "">("");
  const [detail, setDetail] = useState("");
  const [contactedOn, setContactedOn] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (claimStatus) {
    const settled =
      claimStatus === "auto_upheld" || claimStatus === "upheld"
        ? "You reported this lead and we have credited it back."
        : claimStatus === "declined"
          ? "You reported this lead. We looked into it and it stands."
          : "You reported this lead. We are looking into it.";
    return (
      <p className="mt-3 text-center text-xs text-muted-foreground">{settled}</p>
    );
  }

  if (!claimable) return null;

  if (done) {
    return (
      <p className="mt-3 rounded-lg border border-black/10 bg-white p-3 text-sm text-[#52514e]">
        {done}
      </p>
    );
  }

  const ready =
    reason !== "" &&
    detail.trim().length >= MIN_DETAIL_LENGTH &&
    contactedOn !== "";

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/customer/dead-lead-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assignment_id: assignmentId,
          reason,
          detail: detail.trim(),
          contacted_on: contactedOn,
        }),
      });
      const payload = (await res.json()) as {
        ok?: boolean;
        message?: string;
      };
      if (!res.ok || !payload.ok) {
        setError(payload.message ?? "We could not record that. Please try again.");
        return;
      }
      setDone(payload.message ?? "Thanks — we have that.");
      router.refresh();
    } catch {
      setError("We could not record that. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3">
      {!open ? (
        <button
          onClick={() => setOpen(true)}
          className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-black/10 px-6 py-2.5 text-sm font-medium text-[#898781] transition-colors hover:bg-gray-50"
        >
          <AlertCircle className="h-4 w-4" />
          This landlord was already gone
        </button>
      ) : (
        <div className="rounded-xl border border-black/10 bg-white p-4">
          <p className="mb-3 text-sm text-[#52514e]">
            If the landlord had already appointed someone, or was no longer
            letting, before you reached them, tell us and we will look into where
            the lead came from.
          </p>

          <label className="mb-1 block text-xs font-medium text-[#52514e]">
            What did they say?
          </label>
          <select
            value={reason}
            onChange={(e) => setReason(e.target.value as DeadLeadReason)}
            className="mb-3 w-full rounded-lg border border-black/10 px-3 py-2 text-sm"
          >
            <option value="">Choose one</option>
            {DEAD_LEAD_REASONS.map((r) => (
              <option key={r} value={r}>
                {DEAD_LEAD_REASON_LABELS[r]}
              </option>
            ))}
          </select>

          <label className="mb-1 block text-xs font-medium text-[#52514e]">
            In their words
          </label>
          {/*
            The detail is the whole basis for tracing a dead lead back to the
            source that produced it, which is the half of this that improves the
            leads rather than merely crediting them. Hence the floor, and hence
            asking for what the landlord said rather than for a category.
          */}
          <textarea
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            rows={3}
            placeholder="e.g. Said they signed with another agent about two weeks ago."
            className="mb-1 w-full rounded-lg border border-black/10 px-3 py-2 text-sm"
          />
          <p className="mb-3 text-xs text-muted-foreground">
            {detail.trim().length < MIN_DETAIL_LENGTH
              ? `A sentence is plenty — ${MIN_DETAIL_LENGTH - detail.trim().length} more characters.`
              : "Thanks, that is enough to go on."}
          </p>

          <label className="mb-1 block text-xs font-medium text-[#52514e]">
            When did you speak to them?
          </label>
          <input
            type="date"
            value={contactedOn}
            onChange={(e) => setContactedOn(e.target.value)}
            className="mb-3 w-full rounded-lg border border-black/10 px-3 py-2 text-sm"
          />

          {error && (
            <p className="mb-3 text-sm text-red-600">{error}</p>
          )}

          <div className="flex gap-2">
            <button
              onClick={() => submit()}
              disabled={busy || !ready}
              className="flex-1 rounded-lg bg-[#5D8156] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#4c6b47] disabled:opacity-60"
            >
              Send it to us
            </button>
            <button
              onClick={() => setOpen(false)}
              disabled={busy}
              className="flex-1 rounded-lg border border-black/10 px-4 py-2 text-sm font-medium text-[#52514e] transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
