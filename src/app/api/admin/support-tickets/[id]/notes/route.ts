import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminRequest } from "@/lib/trainingAdmin";
import { validateNoteWrite } from "@/lib/supportTickets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Append one note to a ticket's log book (CLAUDE.md §46).
 *
 * ⚠️ APPEND-ONLY, AND IT IS ENFORCED BY THE ABSENCE OF A ROUTE. There is no
 * PATCH and no DELETE handler in this file, so Next answers 405 for free — the
 * `lead_events` posture (§3). Editing a note is editing the record of what we
 * decided, which is the one thing a log book must not allow.
 *
 * ⚠️ Notes are ADMIN-ONLY. The customer read names a fixed column list on
 * `support_tickets` and never mentions this table, which is what makes that a
 * structural boundary rather than a habit — both reads run on the service role,
 * so RLS is not protecting anything here (§32.8's lesson, restated).
 *
 * `author_email` comes from the session, never from the body.
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

  const parsed = validateNoteWrite(body);
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

  let authorEmail: string | null = null;
  try {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    authorEmail = user?.email ?? null;
  } catch {
    /* an x-admin-key caller has no session; the note is still worth keeping */
  }

  const { data, error } = await admin
    .from("support_ticket_notes")
    .insert({
      ticket_id: params.id,
      body: parsed.value,
      author_email: authorEmail,
    })
    .select("id, created_at")
    .single();

  if (error || !data) {
    console.error("admin support ticket note failed", error);
    return NextResponse.json(
      { error: "Could not save that note." },
      { status: 500 }
    );
  }

  return NextResponse.json(
    { ok: true, id: data.id, created_at: data.created_at },
    { status: 201 }
  );
}
