import { CHANNEL_GLYPH, CHANNEL_LABEL, dayLabel } from "@/lib/caseStudies";
import type { CaseStudyEvent } from "@/lib/types";

/**
 * Vertical timeline for one lead journey.
 *
 * Flat and borderless to match the house style — a left rule, a channel letter,
 * the day and the description. No shadows, no gradients, no icon set.
 *
 * Setbacks and the outcome are the only two states that get distinct
 * treatment, because they are the two things the reader is scanning for: where
 * it nearly died, and how it ended.
 */
export function CaseTimeline({ events }: { events: CaseStudyEvent[] }) {
  if (events.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No timeline recorded for this case.
      </p>
    );
  }

  return (
    <ol className="space-y-0">
      {events.map((event) => {
        const rule = event.is_outcome
          ? "border-[#5D8156]"
          : event.is_setback
            ? "border-[#a1a09b]"
            : "border-black/10";

        return (
          <li key={event.id} className={`border-l-2 ${rule} pl-4 pb-5`}>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span
                aria-hidden="true"
                title={CHANNEL_LABEL[event.channel]}
                className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-black/5 text-[11px] font-semibold text-[#52514e]"
              >
                {CHANNEL_GLYPH[event.channel]}
              </span>
              <span className="text-sm font-medium text-[#898781]">
                {dayLabel(event.day_offset)}
              </span>
              <span className="sr-only">{CHANNEL_LABEL[event.channel]}</span>
              {event.is_setback && (
                <span className="rounded bg-black/5 px-1.5 py-0.5 text-[11px] font-medium text-[#52514e]">
                  Setback
                </span>
              )}
            </div>
            <p
              className={
                "mt-1 text-sm " +
                (event.is_outcome
                  ? "font-semibold text-[#5D8156]"
                  : "text-[#1a1a19]")
              }
            >
              {event.description}
            </p>
          </li>
        );
      })}
    </ol>
  );
}
