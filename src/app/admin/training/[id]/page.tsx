import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AdminTrainingForm } from "@/components/admin/AdminTrainingForm";
import type { TrainingModule } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function EditTrainingModulePage({
  params,
}: {
  params: { id: string };
}) {
  const admin = createAdminClient();

  const { data } = await admin
    .from("training_modules")
    .select("*")
    .eq("id", params.id)
    .maybeSingle();

  if (!data) notFound();
  const module = data as TrainingModule;

  // Every other module's slug, so the form can warn about a collision without
  // flagging the module's own slug against itself.
  const { data: slugRows } = await admin
    .from("training_modules")
    .select("slug")
    .neq("id", params.id);
  const existingSlugs = (slugRows ?? []).map((r) => r.slug as string);

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/training"
          className="text-sm text-muted-foreground hover:underline"
        >
          Back to training
        </Link>
        <h1 className="mt-2 text-2xl font-bold">{module.title}</h1>
        <p className="text-sm text-muted-foreground">
          {module.is_published ? "Published" : "Draft"} · /dashboard/training/
          {module.slug}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Module</CardTitle>
        </CardHeader>
        <CardContent>
          <AdminTrainingForm module={module} existingSlugs={existingSlugs} />
        </CardContent>
      </Card>
    </div>
  );
}
