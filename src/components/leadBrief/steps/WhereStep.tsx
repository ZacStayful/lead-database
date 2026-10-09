"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BRIEF_COPY } from "@/lib/leadBrief/briefCopy";

/**
 * A8 Q1, "Where do you operate?". Shared by the questionnaire and the "Your
 * brief" editor (Phase 5), so the question reads the same in both. The caller
 * renders its own navigation. Every word is in briefCopy.ts, except
 * `postcodeLockedNote`, which the funnel passes in (batch 02): once a funnel
 * link has previewed a postcode it is locked, so the box is read-only and the
 * note says how to change it.
 */
export function WhereStep({
  postcode,
  onPostcode,
  areas,
  onAreas,
  issues,
  idPrefix = "brief",
  postcodeLockedNote = null,
}: {
  postcode: string;
  onPostcode: (v: string) => void;
  areas: string[];
  onAreas: (v: string[]) => void;
  issues: string[];
  idPrefix?: string;
  postcodeLockedNote?: string | null;
}) {
  return (
    <>
      <div className="space-y-1">
        <h2 className="font-medium text-ink">{BRIEF_COPY.q1.title}</h2>
        <p className="text-sm text-ink-2">{BRIEF_COPY.q1.help}</p>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-postcode`}>{BRIEF_COPY.q1.postcodeLabel}</Label>
        <Input
          id={`${idPrefix}-postcode`}
          value={postcode}
          autoComplete="postal-code"
          placeholder={BRIEF_COPY.q1.postcodePlaceholder}
          readOnly={postcodeLockedNote !== null}
          aria-describedby={postcodeLockedNote !== null ? `${idPrefix}-postcode-locked` : undefined}
          onChange={(e) => onPostcode(e.target.value)}
        />
        {postcodeLockedNote !== null && (
          <p id={`${idPrefix}-postcode-locked`} className="text-xs text-ink-2">
            {postcodeLockedNote}
          </p>
        )}
      </div>
      {areas.map((a, i) => (
        <div key={i} className="flex items-end gap-2">
          <div className="flex-1 space-y-1">
            <Label htmlFor={`${idPrefix}-area-${i}`}>{BRIEF_COPY.q1.addArea}</Label>
            <Input
              id={`${idPrefix}-area-${i}`}
              value={a}
              placeholder={BRIEF_COPY.q1.areaPlaceholder}
              onChange={(e) => onAreas(areas.map((x, j) => (j === i ? e.target.value : x)))}
            />
          </div>
          <Button variant="ghost" onClick={() => onAreas(areas.flatMap((x, j) => (j === i ? [] : [x])))}>
            {BRIEF_COPY.q1.removeArea}
          </Button>
        </div>
      ))}
      <div className="space-y-1">
        <Button variant="outline" onClick={() => onAreas([...areas, ""])} disabled={areas.length >= 10}>
          {BRIEF_COPY.q1.addArea}
        </Button>
        <p className="text-xs text-ink-2">{BRIEF_COPY.q1.addAreaHelp}</p>
      </div>
      {issues.map((m) => (
        <p key={m} className="text-sm text-alert">
          {m}
        </p>
      ))}
    </>
  );
}
