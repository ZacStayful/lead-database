import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AdminCaseStudyForm } from "@/components/admin/AdminCaseStudyForm";
import type { CaseStudy, CaseStudyEvent } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function EditCaseStudyPage({
  params,
}: {
  params: { id: string };
}) {
  const admin = createAdminClient();

  const { data } = await admin
    .from("case_studies")
    .select("*")
    .eq("id", params.id)
    .maybeSingle();

  if (!data) notFound();
  const caseStudy = data as CaseStudy;

  const { data: eventRows } = await admin
    .from("case_study_events")
    .select("*")
    .eq("case_study_id", params.id)
    .order("day_offset", { ascending: true })
    .order("sort_order", { ascending: true });

  const { data: slugRows } = await admin
    .from("case_studies")
    .select("slug")
    .neq("id", params.id);

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/training/case-studies"
          className="text-sm text-muted-foreground hover:underline"
        >
          Back to case studies
        </Link>
        <h1 className="mt-2 text-2xl font-bold">{caseStudy.reference}</h1>
        <p className="text-sm text-muted-foreground">
          {caseStudy.is_published ? "Published" : "Draft"} ·
          /dashboard/training/case-studies/{caseStudy.slug}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Case study</CardTitle>
        </CardHeader>
        <CardContent>
          <AdminCaseStudyForm
            caseStudy={caseStudy}
            events={(eventRows ?? []) as CaseStudyEvent[]}
            existingSlugs={(slugRows ?? []).map((r) => r.slug as string)}
          />
        </CardContent>
      </Card>
    </div>
  );
}
