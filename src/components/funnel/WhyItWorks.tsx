import { MatchLabelBadge } from "@/components/leadBrief/MatchLabelBadge";
import { WhyThisLead } from "@/components/leadBrief/WhyThisLead";
import { FUNNEL_COPY, FUNNEL_FAQ } from "@/lib/funnel/copy";
import type { DemoEmbed } from "@/lib/funnel/demo";

/**
 * Screen 5, "Why it works" (02 Phase 3): the dashboard demo, a sample lead
 * card and the questions operators ask. Shared by the funnel and the partner
 * summary, so both say the same thing. No state of its own, so it renders on
 * the server in the summary and on the client in the funnel.
 */

/**
 * The sample card's reasons, in the label engine's own shape (LabelReasons,
 * v1), so WhyThisLead renders them exactly as it renders a real lead's.
 * Made up, and the card says so. A Top match, so the "Why" panel carries no
 * link to the brief editor (that link appears only on a Nearby opportunity),
 * which a visitor with no account could not open.
 */
export const SAMPLE_REASONS = {
  v: 1,
  area: "service",
  first_pick: false,
  priorities: [
    { key: "location", threshold: 25, value: 6.2, met: true },
    { key: "revenue", threshold: 40000, value: 46300, met: true },
    { key: "bedrooms", threshold: 3, value: 3, met: true },
  ],
} as const;

export function WhyItWorks({ demo }: { demo: DemoEmbed | null }) {
  return (
    <div className="space-y-6">
      {demo && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-ink">{FUNNEL_COPY.demoTitle}</h2>
          <div className="aspect-video w-full overflow-hidden rounded-xl border border-black/10 bg-black">
            {demo.kind === "video" ? (
              <video src={demo.src} controls preload="metadata" playsInline className="h-full w-full" />
            ) : (
              <iframe
                src={demo.src}
                title={FUNNEL_COPY.demoTitle}
                className="h-full w-full"
                allow="autoplay; fullscreen; picture-in-picture"
                allowFullScreen
                referrerPolicy="no-referrer"
              />
            )}
          </div>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-ink">{FUNNEL_COPY.sampleTitle}</h2>
        <div className="space-y-3 rounded-xl border border-black/10 bg-white p-4">
          <div className="flex flex-wrap items-center gap-2">
            <MatchLabelBadge label="top_match" />
            <span className="text-xs text-ink-2">{FUNNEL_COPY.sampleNote}</span>
          </div>
          <div>
            <p className="font-medium text-ink">{FUNNEL_COPY.sampleHeading}</p>
            <p className="text-sm text-ink-2">{FUNNEL_COPY.sampleFigures}</p>
          </div>
          <WhyThisLead label="top_match" reasons={SAMPLE_REASONS} leadOutcode="YO31" defaultOpen />
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-ink">{FUNNEL_COPY.faqTitle}</h2>
        <div className="divide-y divide-line rounded-xl border border-black/10 bg-white">
          {FUNNEL_FAQ.map((item) => (
            <details key={item.q} className="group px-4 py-3">
              <summary className="cursor-pointer list-none text-sm font-medium text-ink">{item.q}</summary>
              <p className="mt-2 text-sm text-ink-2">{item.a}</p>
            </details>
          ))}
        </div>
      </section>
    </div>
  );
}
