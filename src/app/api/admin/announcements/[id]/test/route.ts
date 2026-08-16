import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { isAdminRequest } from "@/lib/trainingAdmin";
import { paragraphs } from "@/lib/announcements";
import { sendAnnouncementEmail } from "@/lib/emails";
import type { Announcement } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Send one copy of a draft to a single address, to see it before the book does.
 *
 * Writes NO delivery row and does not touch `status`. A test is not a delivery:
 * counting it would put a fake recipient in the log, and stamping the status
 * would make an untested draft indistinguishable from a sent announcement.
 *
 * The recipient defaults to the signed-in admin's own address rather than a
 * configured one, so the obvious action — "send it to me" — needs no typing and
 * cannot be aimed at a customer by a slip of the form.
 *
 * The subject is prefixed [TEST]. Without it the same message arrives twice in
 * the same inbox looking identical, and the admin cannot tell the rehearsal
 * from the performance.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!(await isAdminRequest(req))) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let body: { to?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    // An empty body is fine — it means "send it to me".
  }

  let to = typeof body.to === "string" ? body.to.trim() : "";
  if (!to) {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    to = user?.email ?? "";
  }

  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
    return NextResponse.json(
      { error: "Give an email address to send the test to." },
      { status: 400 }
    );
  }

  const admin = createAdminClient();
  const { data } = await admin
    .from("announcements")
    .select("*")
    .eq("id", params.id)
    .maybeSingle();

  const announcement = data as Announcement | null;
  if (!announcement) {
    return NextResponse.json(
      { error: "Announcement not found." },
      { status: 404 }
    );
  }

  const { error } = await sendAnnouncementEmail({
    to,
    contactName: null,
    subject: `[TEST] ${announcement.subject}`,
    title: announcement.title,
    paragraphs: paragraphs(announcement.body_text),
    linkUrl: announcement.link_url,
    linkLabel: announcement.link_label,
  });

  if (error) {
    console.error("announcement test send failed", error);
    return NextResponse.json(
      { error: "Could not send the test email." },
      { status: 502 }
    );
  }

  return NextResponse.json({ ok: true, to });
}
