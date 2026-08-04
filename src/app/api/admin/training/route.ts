import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  isAdminRequest,
  validateTrainingWrite,
  publishError,
} from "@/lib/trainingAdmin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Create a training module. Admin only; writes on the service role. */
export async function POST(req: NextRequest) {
  if (!(await isAdminRequest(req))) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = validateTrainingWrite(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  // A new module has no uploaded audio yet, so publishing an audio module at
  // creation time cannot succeed — the message says why rather than letting
  // the table CHECK surface as a constraint name.
  const blocker = publishError(parsed.value, null);
  if (blocker) {
    return NextResponse.json({ error: blocker }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("training_modules")
    .insert(parsed.value)
    .select("id, slug")
    .single();

  if (error) {
    // 23505 is unique_violation, which here can only be the slug.
    if (error.code === "23505") {
      return NextResponse.json(
        { error: "That slug is already in use." },
        { status: 409 }
      );
    }
    console.error("admin training create failed", error);
    return NextResponse.json({ error: "Could not create module." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, id: data.id, slug: data.slug });
}
