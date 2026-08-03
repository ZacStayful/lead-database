import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { CaseTimeline } from "@/components/dashboard/CaseTimeline";
import {
  CONFIDENCE_NOTE,
  GATE_LABEL,
  LOSS_REASON_LABEL,
  OUTCOME_LABEL,
} from "@/lib/caseStudies";
import type { CaseStudy, CaseStudyEvent } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function CaseStudyDetailPage({
  params,
}: {
  params: { slug: string };
}) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const admin = createAdminClient();

  // Published only. An unpublished slug 404s rather than rendering — a draft
  // case study must not be reachable by guessing its URL.
  const { data } = await admin
    .from("case_studies")
    .select("*")
    .eq("slug", params.slug)
    .eq("is_published", true)
    .maybeSingle();

  if (!data) notFound();
  const caseStudy = data as CaseStudy;

  const { data: eventRows } = await admin
    .from("case_study_events")
    .select("*")
    .eq("case_study_id", caseStudy.id)
    .order("day_offset", { ascending: true })
    .order("sort_order", { ascending: true });

  const events = (eventRows ?? []) as CaseStudyEvent[];

  const { data: siblings } = await admin
    .from("case_studies")
    .select("slug, reference")
    .eq("is_published", true)
    .order("sort_order", { ascending: true });

  const ordered = siblings ?? [];
  const position = ordered.findIndex((c) => c.slug === caseStudy.slug);
  const previous = position > 0 ? ordered[position - 1] : null;
  const next =
    position >= 0 && position < ordered.length - 1 ? ordered[position + 1] : null;

  const tally = [
    ["Days to outcome", caseStudy.days_to_outcome],
    ["Meetings sat", caseStudy.meetings_sat],
    ["Calls made", caseStudy.calls_made],
    ["Calls answered", caseStudy.calls_answered],
    ["Emails out", caseStudy.emails_out],
    ["Inbound replies", caseStudy.inbound_replies],
  ].filter(([, value]) => value !== null && value !== undefined) as [
    string,
    number,
  ][];

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/dashboard/training/case-studies"
          className="text-sm text-muted-foreground hover:underline"
        >
          Back to all journeys
        </Link>
        <h1 className="mt-2 text-2xl font-bold">{caseStudy.reference}</h1>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span
            className={
              "font-medium " +
              (caseStudy.outcome === "signed"
                ? "text-[#5D8156]"
                : "text-[#52514e]")
            }
          >
            {OUTCOME_LABEL[caseStudy.outcome]}
          </span>
          <span className="text-muted-foreground">
            {caseStudy.property_summary}
          </span>
          <span className="text-muted-foreground">
            {caseStudy.days_to_outcome} days
          </span>
          <span className="text-muted-foreground">
            Reached: {GATE_LABEL[caseStudy.gate_reached]}
          </span>
          {caseStudy.loss_reason && (
            <span className="text-muted-foreground">
              {LOSS_REASON_LABEL[caseStudy.loss_reason]}
            </span>
          )}
        </div>
      </div>

      <section className="rounded-xl border border-black/10 bg-white p-6">
        <h2 className="text-lg font-semibold text-[#1a1a19]">
          {caseStudy.headline}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-[#52514e]">
          {caseStudy.summary}
        </p>
      </section>

      <section className="rounded-xl border border-black/10 bg-white p-6">
        <h2 className="text-lg font-semibold">What actually happened</h2>
        <div className="mt-4">
          <CaseTimeline events={events} />
        </div>

        {tally.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 border-t border-black/10 pt-4 text-sm text-muted-foreground">
            {tally.map(([label, value]) => (
              <span key={label}>
                {label}: <span className="font-medium text-[#1a1a19]">{value}</span>
              </span>
            ))}
            <span>
              Offer applied:{" "}
              <span className="font-medium text-[#1a1a19]">
                {caseStudy.offer_applied ? "yes" : "no"}
              </span>
            </span>
            <span>
              No-show:{" "}
              <span className="font-medium text-[#1a1a19]">
                {caseStudy.had_no_show ? "yes" : "no"}
              </span>
            </span>
          </div>
        )}
      </section>

      {caseStudy.lesson_markdown && (
        <section className="rounded-xl border border-black/10 bg-white p-6">
          <h2 className="text-lg font-semibold">What this teaches</h2>
          <div className="mt-3 space-y-4">
            {caseStudy.lesson_markdown
              .split(/\n\s*\n/)
              .map((paragraph) => paragraph.trim())
              .filter(Boolean)
              .map((paragraph, i) => (
                <p
                  key={i}
                  className="whitespace-pre-line text-sm leading-relaxed text-[#1a1a19]"
                >
                  {paragraph}
                </p>
              ))}
          </div>
        </section>
      )}

      {/* Shown, never hidden. A reader weighing this record against their own
          experience is entitled to know which parts were logged and which were
          remembered. */}
      {caseStudy.data_confidence === "partly_reconstructed" && (
        <p className="text-sm text-muted-foreground">{CONFIDENCE_NOTE}</p>
      )}

      <div className="flex flex-wrap justify-between gap-3 text-sm">
        {previous ? (
          <Link
            href={`/dashboard/training/case-studies/${previous.slug}`}
            className="text-[#52514e] hover:underline"
          >
            ← {previous.reference}
          </Link>
        ) : (
          <span />
        )}
        {next && (
          <Link
            href={`/dashboard/training/case-studies/${next.slug}`}
            className="text-[#52514e] hover:underline"
          >
            {next.reference} →
          </Link>
        )}
      </div>
    </div>
  );
}
