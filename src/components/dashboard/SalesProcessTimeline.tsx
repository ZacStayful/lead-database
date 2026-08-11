import Link from "next/link";
import { stageDays, weeks, type SalesTimeline } from "@/lib/salesTimeline";

/**
 * The sales process and how long it takes, in one view.
 *
 * Every figure is derived from the published case studies rather than written
 * down, so it cannot claim something the journeys underneath it do not show. A
 * customer who doubts a number can open the records it came from.
 */
export function SalesProcessTimeline({ timeline }: { timeline: SalesTimeline }) {
  const { signedFrom, signedTo, preMeetingFrom, preMeetingTo } = timeline;

  return (
    <section className="rounded-xl border border-black/10 bg-white p-6">
      <h2 className="text-lg font-semibold text-[#1a1a19]">
        How long this takes
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Measured from {timeline.total} real landlord leads — {timeline.signed}{" "}
        signed, {timeline.lost} did not. Every figure below comes from those
        records.
      </p>

      {signedFrom !== null && signedTo !== null && (
        <p className="mt-4 text-sm leading-relaxed text-[#1a1a19]">
          The ones that signed took{" "}
          <span className="font-semibold">
            {signedFrom} to {signedTo} days
          </span>{" "}
          — roughly {weeks(signedFrom)} to {weeks(signedTo)} weeks from the
          enquiry landing.
          {preMeetingFrom !== null && preMeetingTo !== null && (
            <>
              {" "}
              The ones that died without ever getting to a meeting died fast:
              inside{" "}
              <span className="font-semibold">{preMeetingTo} days</span>.
            </>
          )}
        </p>
      )}

      <ol className="mt-6 space-y-0">
        {timeline.stages.map((stage, index) => {
          const days = stageDays(stage);
          const last = index === timeline.stages.length - 1;

          return (
            <li
              key={stage.key}
              className={
                "border-l-2 pl-4 " +
                (last ? "border-[#5D8156] pb-0" : "border-black/10 pb-6")
              }
            >
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-sm font-medium text-[#898781]">
                  {days ?? "Not reached"}
                </span>
                <span className="text-sm text-muted-foreground">
                  {stage.reached} of {stage.total} leads
                </span>
              </div>

              <h3
                className={
                  "mt-1 font-semibold " +
                  (last ? "text-[#5D8156]" : "text-[#1a1a19]")
                }
              >
                {stage.label}
              </h3>
              <p className="mt-1 text-sm leading-relaxed text-[#52514e]">
                {stage.detail}
              </p>

              {stage.lostHere > 0 && (
                <p className="mt-2 text-sm text-muted-foreground">
                  {stage.lostHere} of the {stage.total} never got this far.
                </p>
              )}
            </li>
          );
        })}
      </ol>

      <p className="mt-6 border-t border-black/10 pt-4 text-sm leading-relaxed text-muted-foreground">
        The gap that costs the most is between the estimate landing and a
        meeting being booked. Everything before it happens automatically;
        everything after it depends on you getting a time in the diary.
      </p>

      <Link
        href="/dashboard/training/case-studies"
        className="mt-4 inline-block text-sm font-medium text-[#5D8156] hover:underline"
      >
        See all {timeline.total} journeys side by side
      </Link>
    </section>
  );
}
