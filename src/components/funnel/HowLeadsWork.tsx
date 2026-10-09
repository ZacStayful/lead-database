import { FUNNEL_COPY } from "@/lib/funnel/copy";

/** Screen 4's "How your leads work" block (02 Phase 3). */
export function HowLeadsWork() {
  return (
    <section className="space-y-2 rounded-xl border border-black/10 bg-white p-4">
      <h2 className="text-sm font-semibold text-ink">{FUNNEL_COPY.howTitle}</h2>
      <ul className="list-disc space-y-1 pl-5 text-sm text-ink-2">
        {FUNNEL_COPY.howPoints.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
    </section>
  );
}
