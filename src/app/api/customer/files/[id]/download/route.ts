import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BUCKET = "lead-files";

/**
 * Redirect to a short-lived signed URL for one of the caller's own lead files.
 */
export async function GET(
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
    .select("storage_path, file_name, customers!inner(user_id)")
    .eq("id", params.id)
    .maybeSingle();

  const ownerId = (file as { customers?: { user_id?: string } } | null)
    ?.customers?.user_id;
  const path = (file as { storage_path?: string } | null)?.storage_path;

  if (!file || ownerId !== user.id || !path) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { data: signed, error } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(path, 60, {
      download: (file as { file_name?: string }).file_name ?? true,
    });

  if (error || !signed) {
    return NextResponse.json(
      { error: error?.message ?? "Could not sign URL" },
      { status: 400 }
    );
  }

  return NextResponse.redirect(signed.signedUrl);
}
