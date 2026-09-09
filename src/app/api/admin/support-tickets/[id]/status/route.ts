import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminRequest } from "@/lib/trainingAdmin";
import { nextResolvedAt, validateStatusWrite } from "@/lib/supportTickets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Move one ticket's status, and nothing else (CLAUDE.md §46).
 *
 * Separate from PATCH for the reason the training publish route already gives:
 * this is one field pressed from a table row, and it must be as cheap as
 * ticking a box. It is the control the whole admin page is built around.
 *
 * `resolved_at` is computed here through `nextResolvedAt` so the stamp has
 * exactly one author — including the clearing half, when a ticket is reopened.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!(await isAdminRequest(req))) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = validateStatusWrite(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("support_tickets")
    .select("id")
    .eq("id", params.id)
    .maybeSingle();
  if (!existing) {
    return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
  }

  const now = new Date();
  const resolvedAt = nextResolvedAt(parsed.value, now);

  const { error } = await admin
    .from("support_tickets")
    .update({
      status: parsed.value,
      resolved_at: resolvedAt,
      updated_at: now.toISOString(),
    })
    .eq("id", params.id);

  if (error) {
    console.error("admin support ticket status failed", error);
    return NextResponse.json(
      { error: "Could not save that status." },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    status: parsed.value,
    resolved_at: resolvedAt,
  });
}
