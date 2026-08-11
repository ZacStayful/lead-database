import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { CaseComparisonTable } from "@/components/dashboard/CaseComparisonTable";
import type { CaseStudy } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function CaseStudiesComparisonPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const admin = createAdminClient();
  const { data } = await admin
    .from("case_studies")
    .select("*")
    .eq("is_published", true)
    .order("sort_order", { ascending: true });

  const cases = (data ?? []) as CaseStudy[];

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/dashboard/training"
          className="text-sm text-muted-foreground hover:underline"
        >
          Back to training
        </Link>
        <h1 className="mt-2 text-2xl font-bold">Every journey side by side</h1>
        <p className="text-sm text-muted-foreground">
          Real landlord leads, anonymised. Sort by outcome or by days.
        </p>
      </div>

      <section className="rounded-xl border border-black/10 bg-white p-6">
        <p className="text-sm leading-relaxed text-[#1a1a19]">
          Effort gets you into contention. It doesn&apos;t win contention. The
          leads here that didn&apos;t sign absorbed much the same work as the
          ones that did — the same calls, the same meeting, the same offer, the
          same weeks of follow-up. What separated them was whether a competitor
          was in the running, whether the landlord was ready, and whether the
          numbers actually beat their current arrangement.
        </p>
      </section>

      {cases.length === 0 ? (
        <section className="rounded-xl border border-black/10 bg-white p-6">
          <p className="text-sm text-[#52514e]">
            Case studies are being added. You will see them here as they are
            published.
          </p>
        </section>
      ) : (
        <CaseComparisonTable cases={cases} />
      )}
    </div>
  );
}
