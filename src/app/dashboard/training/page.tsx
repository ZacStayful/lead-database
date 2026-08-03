import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatDuration, ordinal, readMinutes } from "@/lib/training";
import { OUTCOME_LABEL } from "@/lib/caseStudies";
import type {
  CaseStudy,
  TrainingModule,
  TrainingProgress,
} from "@/lib/types";

export const dynamic = "force-dynamic";

const TYPE_LABEL: Record<string, string> = {
  video: "Video",
  audio: "Audio",
  article: "Read",
};

/**
 * Training — free to every subscriber.
 *
 * Deliberately ungated: no tier check, no product check, no paywall. The only
 * filter is lead_type_scope, and every seeded module is 'both', so in practice
 * everybody sees everything.
 *
 * Nothing on this page touches balances, allocation or pacing.
 */
export default async function TrainingPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const admin = createAdminClient();

  const { data: customer } = await admin
    .from("customers")
    .select("id, subscription_status, gr_subscription_status")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!customer) redirect("/dashboard");

  const { data: moduleRows } = await admin
    .from("training_modules")
    .select("*")
    .eq("is_published", true)
    .order("sort_order", { ascending: true });

  const all = (moduleRows ?? []) as TrainingModule[];

  // Scope filter. A module marked for one product is shown to customers who
  // hold it; 'both' is shown to everyone. Every seeded module is 'both', so
  // this only bites once a product-specific module is authored.
  const holdsManagement = customer.subscription_status === "active";
  const holdsGr = customer.gr_subscription_status === "active";
  const modules = all.filter((m) => {
    if (m.lead_type_scope === "both") return true;
    if (m.lead_type_scope === "management") return holdsManagement;
    return holdsGr;
  });

  const { data: progressRows } = await admin
    .from("training_progress")
    .select("*")
    .eq("customer_id", customer.id);

  const progress = new Map(
    ((progressRows ?? []) as TrainingProgress[]).map((p) => [p.module_id, p])
  );

  const completedCount = modules.filter(
    (m) => progress.get(m.id)?.completed_at
  ).length;

  const { data: caseRows } = await admin
    .from("case_studies")
    .select("*")
    .eq("is_published", true)
    .order("sort_order", { ascending: true });

  const cases = (caseRows ?? []) as CaseStudy[];
  const signedCount = cases.filter((c) => c.outcome === "signed").length;
  const lostCount = cases.length - signedCount;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Training</h1>
        <p className="text-sm text-muted-foreground">
          Short, practical material on working the leads you receive. Free with
          your subscription.
        </p>
      </div>

      {modules.length === 0 ? (
        <section className="rounded-xl border border-black/10 bg-white p-6">
          <p className="text-sm text-[#52514e]">
            Training material is being added. You will see it here as it is
            published.
          </p>
        </section>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {completedCount} of {modules.length} completed
          </p>

          <div className="space-y-4">
            {modules.map((m, index) => {
              const state = progress.get(m.id);
              const marker =
                m.content_type === "article"
                  ? `Read · ${readMinutes(m.body_markdown)} min`
                  : [
                      TYPE_LABEL[m.content_type],
                      formatDuration(
                        m.content_type === "video"
                          ? m.video_duration_seconds
                          : m.audio_duration_seconds
                      ),
                    ]
                      .filter(Boolean)
                      .join(" · ");

              return (
                <Link
                  key={m.id}
                  href={`/dashboard/training/${m.slug}`}
                  className="block rounded-xl border border-black/10 bg-white p-6 transition-colors hover:border-black/20"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-3">
                    <span className="text-sm font-medium text-[#898781]">
                      {ordinal(index)}
                    </span>
                    {state?.completed_at ? (
                      <span className="text-sm font-medium text-[#5D8156]">
                        ✓ Completed
                      </span>
                    ) : state?.started_at ? (
                      <span className="text-sm text-muted-foreground">
                        In progress
                      </span>
                    ) : null}
                  </div>

                  <h2 className="mt-2 text-lg font-semibold text-[#1a1a19]">
                    {m.title}
                  </h2>
                  <p className="mt-1 text-sm text-[#52514e]">{m.summary}</p>
                  <p className="mt-3 text-sm text-muted-foreground">{marker}</p>
                </Link>
              );
            })}
          </div>
        </>
      )}

      {cases.length > 0 && (
        <section className="space-y-4 pt-2">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-[#1a1a19]">
                Real lead journeys
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {cases.length} real landlord leads, anonymised. {signedCount}{" "}
                signed, {lostCount} didn&apos;t. The losses are here on purpose.
              </p>
            </div>
            <Link
              href="/dashboard/training/case-studies"
              className="text-sm font-medium text-[#5D8156] hover:underline"
            >
              Compare all {cases.length}
            </Link>
          </div>

          <div className="space-y-4">
            {cases.map((c) => (
              <Link
                key={c.id}
                href={`/dashboard/training/case-studies/${c.slug}`}
                className="block rounded-xl border border-black/10 bg-white p-6 transition-colors hover:border-black/20"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <span className="text-sm font-medium text-[#898781]">
                    {c.reference}
                  </span>
                  <span
                    className={
                      "text-sm font-medium " +
                      (c.outcome === "signed"
                        ? "text-[#5D8156]"
                        : "text-[#52514e]")
                    }
                  >
                    {OUTCOME_LABEL[c.outcome]}
                  </span>
                </div>

                <h3 className="mt-2 text-lg font-semibold text-[#1a1a19]">
                  {c.headline}
                </h3>
                <p className="mt-3 text-sm text-muted-foreground">
                  {c.property_summary} · {c.days_to_outcome} days
                </p>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
