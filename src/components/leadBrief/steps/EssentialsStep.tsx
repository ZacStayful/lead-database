"use client";

import { Label } from "@/components/ui/label";
import { BRIEF_BEDROOM_OPTIONS, BRIEF_COPY, BRIEF_GROSS_OPTIONS } from "@/lib/leadBrief/briefCopy";

/**
 * A8 Q3, "Anything a lead must have?". Shared by the questionnaire and the
 * "Your brief" editor (Phase 5). The caller renders its own navigation.
 */
export function EssentialsStep({
  beds,
  onBeds,
  gross,
  onGross,
  issues,
  idPrefix = "brief",
}: {
  beds: number | null;
  onBeds: (v: number | null) => void;
  gross: number | null;
  onGross: (v: number | null) => void;
  issues: string[];
  idPrefix?: string;
}) {
  return (
    <>
      <div className="space-y-1">
        <h2 className="font-medium text-ink">{BRIEF_COPY.q3.title}</h2>
        <p className="text-sm text-ink-2">{BRIEF_COPY.q3.help}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-beds`}>{BRIEF_COPY.q3.bedroomsLabel}</Label>
          <select
            id={`${idPrefix}-beds`}
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={beds === null ? "" : String(beds)}
            onChange={(e) => onBeds(e.target.value === "" ? null : Number(e.target.value))}
          >
            <option value="">{BRIEF_COPY.q3.anyLabel}</option>
            {BRIEF_BEDROOM_OPTIONS.map((b) => (
              <option key={b} value={b}>
                {BRIEF_COPY.q3.bedroomsOption(b)}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-gross`}>{BRIEF_COPY.q3.revenueLabel}</Label>
          <select
            id={`${idPrefix}-gross`}
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={gross === null ? "" : String(gross)}
            onChange={(e) => onGross(e.target.value === "" ? null : Number(e.target.value))}
          >
            <option value="">{BRIEF_COPY.q3.anyLabel}</option>
            {BRIEF_GROSS_OPTIONS.map((g) => (
              <option key={g} value={g}>
                {BRIEF_COPY.q3.revenueOption(g)}
              </option>
            ))}
          </select>
        </div>
      </div>
      {issues.map((m) => (
        <p key={m} className="text-sm text-alert">
          {m}
        </p>
      ))}
    </>
  );
}
