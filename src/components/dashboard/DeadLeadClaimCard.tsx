"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle } from "lucide-react";
import {
  DEAD_LEAD_CONFIRM_CONSEQUENCE,
  DEAD_LEAD_CONTROL_LABEL,
  DEAD_LEAD_PROMPT_BODY,
  DEAD_LEAD_PROMPT_DISMISS,
  DEAD_LEAD_PROMPT_HEADING,
  DEAD_LEAD_REASON_LABELS,
  DEAD_LEAD_REASONS,
  REASON_DETAIL_PROMPT,
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
 *
 * ## The three variants (§51.10)
 *
 * ONE form, three places it can sit. The form body is `ClaimForm` below, in
 * this same file so no new import surface appears and
 * `deadLeadPolicy.test.ts`'s tripwire — which fails if this component ever
 * imports the policy module and drags `plans.ts` into the browser — keeps
 * passing.
 *
 * | variant | where | when |
 * |---|---|---|
 * | `prominent` | a block at the top of the lead | three opens AND a contact attempt |
 * | `panel` | a row inside the outcome panel | eligible, not prompted |
 * | `solo` | its own button (the original) | the only outcome available |
 *
 * ⚠️ The caller renders it in exactly ONE place at a time. Two copies would be
 * §51.6's own warning turned on itself.
 */
/**
 * Which reasons this lead can be reported under.
 *
 * ⚠️ Declared here rather than imported from `deadLeadPolicy.ts`. This is a
 * client component and that module reaches `plans.ts` through `products.ts`;
 * `deadLeadPolicy.test.ts` has a tripwire that fails if this file ever imports
 * it. A structural type costs nothing and keeps the plan tables out of the
 * browser bundle (§21.8).
 */
export type ReasonVerdicts = Record<
  string,
  { available: boolean; because: string | null }
>;

export function DeadLeadClaimCard({
  assignmentId,
  claimable,
  claimStatus,
  variant = "solo",
  onDismiss,
  reasons,
  defaultOpen = false,
}: {
  assignmentId: string;
  claimable: boolean;
  /** Set when this assignment already carries a claim. One per assignment, ever. */
  claimStatus: string | null;
  variant?: "prominent" | "panel" | "solo";
  /** `prominent` only — moves the option into the panel rather than removing it. */
  onDismiss?: () => void;
  /** Per-reason availability, so the seven-day rule is visible in the select. */
  reasons?: ReasonVerdicts;
  /**
   * Open the form straight away. Set when the operator arrived from the leads
   * list, which deep-links here rather than carrying claim state per card.
   */
  defaultOpen?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(defaultOpen);
  const [done, setDone] = useState<string | null>(null);

  if (claimStatus) {
    const settled =
      claimStatus === "auto_upheld" || claimStatus === "upheld"
        ? "You reported this lead and we have credited it back."
        : claimStatus === "declined"
          ? "You reported this lead. We looked into it and it stands."
          : "You reported this lead. We are looking into it.";
    // In the prominent slot it keeps the shell, so the node does not move when
    // router.refresh() lands — see `done` below.
    return variant === "prominent" ? (
      <div className="rounded-xl border border-black/10 bg-white p-4">
        <p className="text-sm text-[#52514e]">{settled}</p>
      </div>
    ) : (
      <p className="mt-3 text-center text-xs text-muted-foreground">
        {settled}
      </p>
    );
  }

  if (!claimable) return null;

  if (done) {
    // ⚠️ Rendered in the SAME slot the trigger was in. `submit` calls
    // router.refresh(), and if the placement moved between renders this node
    // would remount somewhere else and destroy the message mid-read — the one
    // place the credit is named at all.
    return (
      <p className="mt-3 rounded-lg border border-black/10 bg-white p-3 text-sm text-[#52514e]">
        {done}
      </p>
    );
  }

  function finish(message: string) {
    setDone(message);
    router.refresh();
  }

  if (open) {
    const form = (
      <ClaimForm
        assignmentId={assignmentId}
        onDone={finish}
        onCancel={() => setOpen(false)}
        reasons={reasons}
      />
    );
    return variant === "prominent" ? (
      <div>{form}</div>
    ) : (
      <div className="mt-3">{form}</div>
    );
  }

  if (variant === "prominent") {
    return (
      <div className="rounded-xl border border-[#5D8156]/30 bg-[#f4f8f2] p-4">
        <p className="mb-1 text-sm font-semibold text-[#2f3b2c]">
          {DEAD_LEAD_PROMPT_HEADING}
        </p>
        <p className="mb-3 text-sm text-[#52514e]">{DEAD_LEAD_PROMPT_BODY}</p>
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={() => setOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#5D8156] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#4c6b47]"
          >
            <AlertCircle className="h-4 w-4" />
            {DEAD_LEAD_CONTROL_LABEL}
          </button>
          {onDismiss && (
            <button
              onClick={onDismiss}
              className="text-sm text-[#898781] underline underline-offset-4 transition-colors hover:text-[#52514e]"
            >
              {DEAD_LEAD_PROMPT_DISMISS}
            </button>
          )}
        </div>
      </div>
    );
  }

  if (variant === "panel") {
    // Deliberately NOT button-weight. Same-shaped controls under different
    // headings still read as one list, and this one is the option that returns
    // money — it gets a different affordance, not merely a different heading.
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full rounded-lg px-3 py-2 text-left transition-colors hover:bg-gray-50"
      >
        <span className="block text-sm font-medium text-[#2f3b2c] underline underline-offset-4">
          {DEAD_LEAD_CONTROL_LABEL}
        </span>
      </button>
    );
  }

  return (
    <div className="mt-3">
      <button
        onClick={() => setOpen(true)}
        className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-black/10 px-6 py-2.5 text-sm font-medium text-[#898781] transition-colors hover:bg-gray-50"
      >
        <AlertCircle className="h-4 w-4" />
        {DEAD_LEAD_CONTROL_LABEL}
      </button>
    </div>
  );
}

/**
 * The form itself — one definition, whichever variant opened it.
 */
function ClaimForm({
  assignmentId,
  onDone,
  onCancel,
  reasons,
}: {
  assignmentId: string;
  onDone: (message: string) => void;
  onCancel: () => void;
  reasons?: ReasonVerdicts;
}) {
  const [reason, setReason] = useState<DeadLeadReason | "">("");
  // Why the chosen reason cannot be used, when it cannot.
  const chosenBecause = reason && reasons ? (reasons[reason]?.because ?? null) : null;
  const [detail, setDetail] = useState("");
  const [contactedOn, setContactedOn] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready =
    reason !== "" &&
    // ⚠️ Not just "a reason is chosen" — one that can actually be used. A
    // disabled <option> is still selectable by keyboard in some browsers, and
    // the route would refuse it with a 400 the operator cannot act on.
    (!reasons || reasons[reason]?.available !== false) &&
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
      const payload = (await res.json()) as { ok?: boolean; message?: string };
      if (!res.ok || !payload.ok) {
        setError(
          payload.message ?? "We could not record that. Please try again.",
        );
        return;
      }
      onDone(payload.message ?? "Thanks — we have that.");
    } catch {
      setError("We could not record that. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-black/10 bg-white p-4">
      <p className="mb-3 text-sm text-[#52514e]">
        If the landlord had already appointed someone, or was no longer letting,
        before you reached them, tell us and we will look into where the lead
        came from.
      </p>

      <label className="mb-1 block text-xs font-medium text-[#52514e]">
        What did they say?
      </label>
      {/*
        ⚠️ Every reason is LISTED, and the ones that cannot be used are
        disabled rather than absent. This is where the seven-day rule becomes
        legible: on a ten-day-old lead the competitor reason is greyed with its
        explanation, and the other five are live. Dropping it from the list
        instead would leave an operator who knows it exists hunting for it.
      */}
      <select
        value={reason}
        onChange={(e) => setReason(e.target.value as DeadLeadReason)}
        className="mb-1 w-full rounded-lg border border-black/10 px-3 py-2 text-sm"
      >
        <option value="">Choose one</option>
        {DEAD_LEAD_REASONS.map((r) => (
          <option key={r} value={r} disabled={reasons ? !reasons[r]?.available : false}>
            {DEAD_LEAD_REASON_LABELS[r]}
          </option>
        ))}
      </select>
      {chosenBecause ? (
        <p className="mb-3 text-xs text-[#a8620f]">{chosenBecause}</p>
      ) : (
        <div className="mb-3" />
      )}

      <label className="mb-1 block text-xs font-medium text-[#52514e]">
        {reason ? REASON_DETAIL_PROMPT[reason] : "What happened?"}
      </label>
      {/*
        The detail is the whole basis for tracing a dead lead back to the
        source that produced it, which is the half of this that improves the
        leads rather than merely crediting them. Hence the floor.

        ⚠️ The QUESTION varies by reason and the floor does not. "In their
        words" is nonsense for `wrong_details` — that reason exists precisely
        because there was no landlord to quote — and often for `property_sold`
        too. Asking it anyway produces "n/a" padded to twenty characters, which
        poisons exactly the dataset the floor exists to protect.
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

      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

      {/*
        ⚠️ Stated BEFORE the send, not after. Until §51.10 the credit was first
        named in the success message, so an operator consented without being
        told the outcome. It reads the same whether the claim will auto-uphold
        or go to review — those two paths are deliberately indistinguishable.
      */}
      <p className="mb-3 text-xs text-muted-foreground">
        {DEAD_LEAD_CONFIRM_CONSEQUENCE}
      </p>

      <div className="flex gap-2">
        <button
          onClick={() => submit()}
          disabled={busy || !ready}
          className="flex-1 rounded-lg bg-[#5D8156] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#4c6b47] disabled:opacity-60"
        >
          Send it to us
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          className="flex-1 rounded-lg border border-black/10 px-4 py-2 text-sm font-medium text-[#52514e] transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
