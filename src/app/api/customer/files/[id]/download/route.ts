import { NextResponse, type NextRequest } from "next/server";
import { getCurrentCustomer } from "@/lib/auth";
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
  // Ownership is the CUSTOMER's, resolved through getCurrentCustomer() so an
  // admin viewing a customer (§62) can open that customer's files. It used to
  // compare the row's user_id against the session, which in that mode is the
  // admin's own id and would 404 on every file.
  const { user, customer } = await getCurrentCustomer();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!customer) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const admin = createAdminClient();

  const { data: file } = await admin
    .from("lead_files")
    .select("storage_path, file_name, customer_id")
    .eq("id", params.id)
    .maybeSingle();

  const ownerId = (file as { customer_id?: string } | null)?.customer_id;
  const path = (file as { storage_path?: string } | null)?.storage_path;

  if (!file || ownerId !== customer.id || !path) {
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
