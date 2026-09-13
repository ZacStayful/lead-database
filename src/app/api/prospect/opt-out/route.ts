/**
 * "Stop these emails" — the unsubscribe link in a booking-chase email (§55).
 *
 * Unauthenticated by nature: it is a link in an email to somebody who has no
 * login and never will unless they buy. The ladder id is a uuid, which is
 * unguessable enough for what this does — and what it does is the point: the
 * ONLY effect is to stop messages. There is nothing here worth forging, since
 * the worst an attacker achieves is silencing a sales chase they would have to
 * know the uuid of.
 *
 * GET rather than POST deliberately: mail clients do not post, and an
 * unsubscribe that needs JavaScript is an unsubscribe that does not work.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function page(message: string): NextResponse {
  return new NextResponse(
    `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Stayful</title></head>
<body style="margin:0;background:#f5f6f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:520px;margin:0 auto;padding:48px 20px">
  <div style="font-weight:700;font-size:20px;color:#5D8156;margin-bottom:16px">Stayful</div>
  <div style="background:#fff;border:0.5px solid #d9dbd8;border-radius:10px;padding:28px;font-size:15px;line-height:1.6">
    ${message}
  </div>
</div></body></html>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("n") ?? "";

  // ⚠️ ONE ANSWER FOR EVERY OUTCOME. A malformed id, an unknown id and a
  // ladder that had already stopped all render the same page. Distinguishing
  // them would turn this into an oracle for which uuids exist, and there is
  // nothing a caller can usefully do with the difference anyway.
  const done = page(
    `<p style="margin:0">That's done — you won't get any more emails from us about your enquiry.</p>
     <p style="margin:14px 0 0;color:#6b706a">If you change your mind, you're welcome to book a call any time.</p>`
  );

  if (!UUID.test(id)) return done;

  try {
    const admin = createAdminClient();
    await admin
      .from("prospect_booking_nudges")
      .update({
        status: "stopped",
        stopped_reason: "opted_out",
        opted_out_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("status", "active");
  } catch (err) {
    // Never show a failure here. The person has asked to be left alone; an
    // error page invites them to try again and tells them nothing useful.
    console.error("[prospect-opt-out] failed", err);
  }

  return done;
}
