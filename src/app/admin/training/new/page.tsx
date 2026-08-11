import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AdminTrainingForm } from "@/components/admin/AdminTrainingForm";

export const dynamic = "force-dynamic";

export default async function NewTrainingModulePage() {
  const admin = createAdminClient();
  const { data } = await admin.from("training_modules").select("slug");
  const existingSlugs = (data ?? []).map((r) => r.slug as string);

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/training"
          className="text-sm text-muted-foreground hover:underline"
        >
          Back to training
        </Link>
        <h1 className="mt-2 text-2xl font-bold">New module</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Module</CardTitle>
        </CardHeader>
        <CardContent>
          <AdminTrainingForm existingSlugs={existingSlugs} />
        </CardContent>
      </Card>
    </div>
  );
}
