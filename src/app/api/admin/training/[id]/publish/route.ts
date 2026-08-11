import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminRequest } from "@/lib/trainingAdmin";
import { publishBlocker } from "@/lib/training";
import type { TrainingModule } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Publish or unpublish one module, and nothing else.
 *
 * Separate from PATCH /api/admin/training/[id] because that route parses a
 * whole module — title, slug, scope, provider, the lot — and rejects a partial
 * body. Publishing is the one edit worth doing without opening the form: a
 * module is invisible to every customer until it happens, and burying it
 * behind "open, tick, save" is what leaves a finished recording sitting as a
 * draft nobody can see.
 *
 * The publish check reads the stored row rather than a request body, so an
 * unfinished module still cannot be published — the CHECK would refuse it
 * anyway, but as a constraint name rather than a sentence.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!(await isAdminRequest(req))) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let body: { is_published?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (typeof body.is_published !== "boolean") {
    return NextResponse.json(
      { error: "is_published must be true or false" },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  const { data } = await admin
    .from("training_modules")
    .select("*")
    .eq("id", params.id)
    .maybeSingle();

  const module = data as TrainingModule | null;
  if (!module) {
    return NextResponse.json({ error: "Module not found" }, { status: 404 });
  }

  const blocker = publishBlocker({
    content_type: module.content_type,
    is_published: body.is_published,
    video_url: module.video_url,
    video_provider: module.video_provider,
    media_storage_path: module.media_storage_path,
    body_markdown: module.body_markdown,
  });
  if (blocker) {
    return NextResponse.json({ error: blocker }, { status: 400 });
  }

  const { error } = await admin
    .from("training_modules")
    .update({
      is_published: body.is_published,
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.id);

  if (error) {
    console.error("admin training publish failed", error);
    return NextResponse.json({ error: "Could not save." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, is_published: body.is_published });
}
