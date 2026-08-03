import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AdminCaseStudyForm } from "@/components/admin/AdminCaseStudyForm";

export const dynamic = "force-dynamic";

export default async function NewCaseStudyPage() {
  const admin = createAdminClient();
  const { data } = await admin.from("case_studies").select("slug");
  const existingSlugs = (data ?? []).map((r) => r.slug as string);

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/training/case-studies"
          className="text-sm text-muted-foreground hover:underline"
        >
          Back to case studies
        </Link>
        <h1 className="mt-2 text-2xl font-bold">New case study</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Case study</CardTitle>
        </CardHeader>
        <CardContent>
          <AdminCaseStudyForm existingSlugs={existingSlugs} />
        </CardContent>
      </Card>
    </div>
  );
}
