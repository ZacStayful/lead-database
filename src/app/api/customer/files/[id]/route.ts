import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BUCKET = "lead-files";

/** Delete one of the caller's own lead files (storage object + metadata row). */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();

  const { data: file } = await admin
    .from("lead_files")
    .select("id, storage_path, customers!inner(user_id)")
    .eq("id", params.id)
    .maybeSingle();

  const ownerId = (file as { customers?: { user_id?: string } } | null)
    ?.customers?.user_id;
  const path = (file as { storage_path?: string } | null)?.storage_path;

  if (!file || ownerId !== user.id || !path) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await admin.storage.from(BUCKET).remove([path]);
  await admin.from("lead_files").delete().eq("id", params.id);

  return NextResponse.json({ ok: true });
}
