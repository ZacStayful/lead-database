"use client";

import { useState } from "react";
import {
  OUTCOME_COPY,
  OUTCOME_ENTRY_HINT,
  OUTCOME_ENTRY_LABEL,
  OUTCOME_GROUPS,
  OUTCOME_REASONS,
  type LeadOutcomes,
  type OutcomeKey,
} from "@/lib/leadOutcomes";
import { CLOSE_REASONS } from "@/lib/closeReasons";
import { OUTCOME_DETAIL_MAX } from "@/lib/outcomeReasons";
import { DeadLeadClaimCard } from "@/components/dashboard/DeadLeadClaimCard";

/**
 * The one way to end a lead (§51.10).
 *
 * Before this, `LeadDetail` rendered Reject, Discard, "Didn't work out" and the
 * §51 report as four separate grey outline buttons scattered down the page,
 * each explaining its consequence only AFTER it was clicked. Measured on
 * production: of 126 assignments eligible to report, 85 showed the chargeable
 * verb and the refundable one as adjacent grey buttons — §51.6's "two controls
 * a click apart that read alike" made real.
 *
 * ⚠️ IT RENDERS FROM THE DATA — `OUTCOME_GROUPS`, `OUTCOME_COPY`,
 * `OUTCOME_REASONS` — and never from labels written here. That is the
 * load-bearing rule of this component, not a style preference: the grouping,
 * the order and the consequence lines are asserted in `leadOutcomes.test.ts`,
 * and every one of those assertions is decorative if this file can quietly
 * hard-code something else. `leadOutcomes.test.ts` reads this file and fails if
 * the literal labels appear in it.
 *
 * ⚠️ CHOOSING AN OPTION REPLACES THE LIST. All four confirms used to expand in
 * place while their neighbours stayed clickable; in one box that is a mis-click
 * into a different money outcome.
 *
 * "Mark as signed" and "Delete this lead" are deliberately NOT here. A win and
 * the deletion of your own data are different acts, and delete is gated on
 * `isOwnLead`, which none of these four share.
 */
export function LeadOutcomePanel({
  outcomes,
  busy,
  deadLead,
  onReject,
  onDiscard,
  onClose,
}: {
  outcomes: LeadOutcomes;
  busy: boolean;
  /**
   * Null only when there is no assignment to report at all.
   *
   * ⚠️ Since 0139 the report renders on EVERY lead, available or not. An
   * operator who saw the control last week and not this week reads it as
   * broken, and nobody learns the rule from something that silently comes and
   * goes — so an ineligible lead gets the row greyed, with the reason.
   */
  deadLead: {
    assignmentId: string;
    claimStatus: string | null;
    reasons?: Record<string, { available: boolean; because: string | null }>;
  } | null;
  onReject: (reason: string, detail: string) => void;
  onDiscard: (reason: string, detail: string) => void;
  onClose: (reason: string, detail: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Exclude<OutcomeKey, "report"> | null>(null);

  /**
   * ⚠️ "Nothing actionable" is no longer "nothing to show".
   *
   * A settled, rejected or out-of-window lead has no outcome left to choose,
   * and before 0139 that meant the whole block vanished — including any account
   * of WHY the report was not there. Now the greyed row stands on its own, so
   * the rule is legible on exactly the leads where it bit.
   *
   * Still null when there is no assignment to report at all, which is the only
   * case where there is genuinely nothing to say.
   */
  if (outcomes.presentation === "none" && !deadLead) return null;

  const handlers: Record<
    Exclude<OutcomeKey, "report">,
    (reason: string, detail: string) => void
  > = { reject: onReject, discard: onDiscard, close: onClose };

  function option(key: OutcomeKey) {
    if (key === "report") {
      return deadLead ? (
        <DeadLeadClaimCard
          key={key}
          assignmentId={deadLead.assignmentId}
          claimable
          claimStatus={deadLead.claimStatus}
          variant="panel"
        />
      ) : null;
    }
    return (
      <button
        key={key}
        onClick={() => setStep(key)}
        disabled={busy}
        className="w-full rounded-lg px-3 py-2 text-left transition-colors hover:bg-gray-50 disabled:opacity-60"
      >
        <span className="block text-sm font-medium text-[#52514e]">
          {OUTCOME_COPY[key].label}
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground">
          {OUTCOME_COPY[key].consequence}
        </span>
      </button>
    );
  }

  /**
   * The report when it cannot be used: the same row, muted, with the reason
   * underneath instead of the consequence.
   *
   * ⚠️ Rendered from OUTCOME_COPY like every other row. A literal label here
   * fails `leadOutcomes.test.ts`, which reads this file — and the point of that
   * guard is that copy and grouping assertions are decorative if the component
   * can hard-code something else.
   */
  const disabledReport = (because: string | null) => (
    <div
      key="report-disabled"
      aria-disabled="true"
      className="w-full rounded-lg border border-black/5 bg-gray-50/60 px-4 py-3 text-left"
    >
      <p className="text-sm font-medium text-[#a8a6a1]">
        {OUTCOME_COPY.report.label}
      </p>
      <p className="mt-0.5 text-xs text-[#a8a6a1]">
        {because ?? outcomes.reportUnavailableBecause}
      </p>
    </div>
  );

  // Nothing to choose, but there is still something to explain.
  if (outcomes.presentation === "none") {
    return <div className="mt-3">{disabledReport(null)}</div>;
  }

  // The report is its own control when it is the only thing left — a menu of
  // one headed "What happened with this lead?" containing nothing but the
  // refundable option reads as a prompt to claim.
  if (outcomes.presentation === "solo") {
    const only = outcomes.available[0];
    if (only === "report") {
      return deadLead ? (
        <DeadLeadClaimCard
          assignmentId={deadLead.assignmentId}
          claimable
          claimStatus={deadLead.claimStatus}
          variant="solo"
        />
      ) : null;
    }
    return (
      <div className="mt-3 space-y-1">
        {step === null ? (
          option(only)
        ) : (
          <ConfirmStep
            outcome={step}
            busy={busy}
            onConfirm={handlers[step]}
            onCancel={() => setStep(null)}
          />
        )}
        {/* The report stays visible beside the one live outcome. */}
        {step === null && !outcomes.reportEnabled && deadLead
          ? disabledReport(null)
          : null}
      </div>
    );
  }

  if (!open) {
    return (
      <div className="mt-3">
        <button
          onClick={() => setOpen(true)}
          disabled={busy}
          className="inline-flex w-full items-center justify-center rounded-lg border border-black/10 px-6 py-2.5 text-sm font-medium text-[#898781] transition-colors hover:bg-gray-50 disabled:opacity-60"
        >
          {OUTCOME_ENTRY_LABEL}
        </button>
      </div>
    );
  }

  if (step !== null) {
    return (
      <div className="mt-3">
        <ConfirmStep
          outcome={step}
          busy={busy}
          onConfirm={handlers[step]}
          onCancel={() => setStep(null)}
        />
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-xl border border-black/10 bg-white p-4">
      <p className="mb-3 text-xs text-muted-foreground">{OUTCOME_ENTRY_HINT}</p>

      {OUTCOME_GROUPS.map((group) => {
        const shown = group.options.filter((k) =>
          outcomes.available.includes(k),
        );
        // ⚠️ The report group renders even with nothing actionable in it, which
        // is what makes the control permanent. Every other group still
        // disappears when empty.
        const greyReport =
          group.options.includes("report") &&
          !outcomes.reportEnabled &&
          deadLead != null;
        if (shown.length === 0 && !greyReport) return null;
        return (
          <div key={group.id} className="mb-3 last:mb-0">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[#898781]">
              {group.heading}
            </p>
            <div className="space-y-1">
              {shown.map(option)}
              {greyReport && disabledReport(null)}
            </div>
          </div>
        );
      })}

      <button
        onClick={() => setOpen(false)}
        className="mt-2 w-full rounded-lg border border-black/10 px-4 py-2 text-sm font-medium text-[#52514e] transition-colors"
      >
        Cancel
      </button>
    </div>
  );
}

/** Pick a reason, add anything worth adding, confirm. */
function ConfirmStep({
  outcome,
  busy,
  onConfirm,
  onCancel,
}: {
  outcome: Exclude<OutcomeKey, "report">;
  busy: boolean;
  onConfirm: (reason: string, detail: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  const [detail, setDetail] = useState("");

  const reasons: Record<string, string> =
    outcome === "close" ? CLOSE_REASONS : (OUTCOME_REASONS[outcome] ?? {});

  return (
    <div className="rounded-xl border border-black/10 bg-white p-4">
      <p className="mb-1 text-sm font-medium text-[#52514e]">
        {OUTCOME_COPY[outcome].label}
      </p>
      <p className="mb-3 text-xs text-muted-foreground">
        {OUTCOME_COPY[outcome].consequence}
      </p>

      <label className="mb-1 block text-xs font-medium text-[#52514e]">
        Why?
      </label>
      <select
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        className="mb-3 w-full rounded-lg border border-black/10 px-3 py-2 text-sm"
      >
        <option value="">Choose one</option>
        {Object.entries(reasons).map(([key, label]) => (
          <option key={key} value={key}>
            {label}
          </option>
        ))}
      </select>

      {/*
        Optional everywhere here. The 20-character floor belongs to the report
        alone, because there the landlord's words are the evidence for a credit
        — demanding prose to reject a lead in the wrong county is friction on a
        one-click action, and at scale it produces "n/a".
      */}
      <label className="mb-1 block text-xs font-medium text-[#52514e]">
        Anything worth adding? <span className="font-normal">(optional)</span>
      </label>
      <textarea
        value={detail}
        onChange={(e) => setDetail(e.target.value.slice(0, OUTCOME_DETAIL_MAX))}
        rows={2}
        className="mb-3 w-full rounded-lg border border-black/10 px-3 py-2 text-sm"
      />

      <div className="flex gap-2">
        <button
          onClick={() => onConfirm(reason, detail)}
          disabled={busy || reason === ""}
          className="flex-1 rounded-lg bg-[#52514e] px-4 py-2 text-sm font-medium text-white transition-colors disabled:opacity-60"
        >
          Confirm
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
