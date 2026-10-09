"use client";

import { BRIEF_COPY } from "@/lib/leadBrief/briefCopy";

export type Travel = 10 | 25 | 50 | null;

/**
 * A8 Q2, "How far will you travel?". Shared by the questionnaire and the
 * "Your brief" editor (Phase 5). The caller renders its own navigation.
 */
export function TravelStep({
  travel,
  onTravel,
  issues,
}: {
  travel: Travel | undefined;
  onTravel: (v: Travel) => void;
  issues: string[];
}) {
  return (
    <>
      <div className="space-y-1">
        <h2 className="font-medium text-ink">{BRIEF_COPY.q2.title}</h2>
        <p className="text-sm text-ink-2">{BRIEF_COPY.q2.help}</p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {BRIEF_COPY.q2.options.map((o) => (
          <button
            key={String(o.value)}
            type="button"
            onClick={() => onTravel(o.value)}
            className={
              travel === o.value
                ? "rounded-md border border-brand bg-brand-light px-3 py-3 text-left text-sm font-medium text-brand-dark"
                : "rounded-md border border-line px-3 py-3 text-left text-sm hover:border-brand"
            }
            aria-pressed={travel === o.value}
          >
            {o.label}
          </button>
        ))}
      </div>
      {travel === null && <p className="text-xs text-ink-2">{BRIEF_COPY.q2.anywhereNote}</p>}
      {issues.map((m) => (
        <p key={m} className="text-sm text-alert">
          {m}
        </p>
      ))}
    </>
  );
}
