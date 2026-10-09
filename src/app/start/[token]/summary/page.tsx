/**
 * "Send to my partner" (batch 02 Phase 3): a read-only page with the
 * visitor's answers, their preview and the "Why it works" content, so they can
 * share it with somebody they run the business with.
 *
 * ⚠️ THE [token] HERE IS THE SUMMARY TOKEN, NEVER THE FUNNEL TOKEN
 * (funnel/token.ts). The funnel token can save answers, spend previews and
 * start a checkout; this one opens this page and nothing else. A funnel token
 * in this path is not a summary token and is a 404, as is anything else.
 *
 * ⚠️ NO CONTACT DETAILS AND NO PAYMENT. The session is read with an explicit
 * column list that leaves out name, email and phone, so they cannot reach the
 * page even by accident, and nothing here links to the funnel or to checkout.
 * A test reads this file to keep it that way.
 */
import { notFound } from "next/navigation";
import { Logo } from "@/components/Logo";
import { FunnelExits } from "@/components/funnel/FunnelExits";
import { FunnelSummaryPreview } from "@/components/funnel/FunnelSummaryPreview";
import { HowLeadsWork } from "@/components/funnel/HowLeadsWork";
import { WhyItWorks } from "@/components/funnel/WhyItWorks";
import { createAdminClient } from "@/lib/supabase/admin";
import { answerSummary, readStoredAnswers } from "@/lib/funnel/answers";
import { FUNNEL_COPY } from "@/lib/funnel/copy";
import { demoEmbed } from "@/lib/funnel/demo";
import { readPreviewSnapshot } from "@/lib/funnel/preview";
import { readFunnelEnabled } from "@/lib/funnel/server";
import { funnelTokenSecret, verifyFunnelSummaryToken } from "@/lib/funnel/token";

export const dynamic = "force-dynamic";

export const metadata = {
  robots: { index: false, follow: false },
  referrer: "no-referrer" as const,
};

/** Never name, email or phone. */
const SUMMARY_COLUMNS = "id, answers, preview_snapshot, plan_selected";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-muted/30 px-4 py-8">
      <div className="mx-auto w-full max-w-2xl space-y-6">
        <div className="flex justify-center">
          <Logo height={36} priority />
        </div>
        {children}
      </div>
    </main>
  );
}

export default async function FunnelSummaryPage({ params }: { params: { token: string } }) {
  const sessionId = verifyFunnelSummaryToken(params.token, funnelTokenSecret());
  if (!sessionId) notFound();

  const admin = createAdminClient();
  const [enabled, read] = await Promise.all([
    readFunnelEnabled(admin),
    admin.from("funnel_sessions").select(SUMMARY_COLUMNS).eq("id", sessionId).maybeSingle(),
  ]);

  if (read.error) console.error("[funnel/summary] session lookup failed", read.error.message);
  if (!read.error && !read.data) notFound();

  if (!enabled || read.error || !read.data) {
    return (
      <Shell>
        <div className="space-y-3 rounded-xl border border-black/10 bg-white p-6 text-center">
          <h1 className="text-lg font-semibold text-ink">{FUNNEL_COPY.unavailableTitle}</h1>
          <p className="text-sm text-ink-2">{FUNNEL_COPY.unavailableBody}</p>
          <FunnelExits summaryPath={null} />
        </div>
      </Shell>
    );
  }

  const row = read.data as { answers: unknown; preview_snapshot: unknown; plan_selected: number | null };
  const draft = readStoredAnswers(row.answers);
  const snapshot = readPreviewSnapshot(row.preview_snapshot);
  const plan = row.plan_selected === 20 ? 20 : 10;
  const shown = snapshot?.plans.find((p) => p.plan === plan) ?? null;

  return (
    <Shell>
      <div className="space-y-5 rounded-xl border border-black/10 bg-white p-5 sm:p-6">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold text-ink">{FUNNEL_COPY.summaryTitle}</h1>
          <p className="text-sm text-ink-2">{FUNNEL_COPY.summaryIntro}</p>
        </div>

        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-ink">{FUNNEL_COPY.summaryAnswersTitle}</h2>
          <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto,1fr]">
            {answerSummary(draft, shown?.basePostcode ?? null).map((r) => (
              <div key={r.label} className="contents">
                <dt className="text-ink-2">{r.label}</dt>
                <dd className="font-medium text-ink">{r.value}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-ink">{FUNNEL_COPY.previewTitle}</h2>
          {shown && snapshot ? (
            <FunnelSummaryPreview
              preview={shown}
              ticked={snapshot.similarAreas}
              minBedrooms={draft.minBedrooms ?? null}
              minGross={draft.minGross ?? null}
              anywayLine={FUNNEL_COPY.previewAnyway}
            />
          ) : (
            <p className="text-sm text-ink-2">{FUNNEL_COPY.summaryNoPreview}</p>
          )}
        </section>

        <HowLeadsWork />

        <section className="space-y-3">
          <h2 className="text-base font-semibold text-ink">{FUNNEL_COPY.whyTitle}</h2>
          <WhyItWorks demo={demoEmbed(process.env.NEXT_PUBLIC_FUNNEL_DEMO_URL)} />
        </section>

        <FunnelExits summaryPath={null} />
      </div>
    </Shell>
  );
}
