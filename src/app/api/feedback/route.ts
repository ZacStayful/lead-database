import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendFeedbackEmail } from "@/lib/emails";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Receive a feature request or bug report and email it to the Stayful team.
 * If the sender is signed in, their account record is attached so there's full
 * context to action the request or fix.
 */
export async function POST(request: NextRequest) {
  let body: {
    type?: string;
    name?: string;
    email?: string;
    business?: string;
    subject?: string;
    details?: string;
    page?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const type = body.type === "bug" ? "bug" : "feature";
  const name = body.name?.trim();
  const email = body.email?.trim();
  const subject = body.subject?.trim();
  const details = body.details?.trim();

  if (!name || !email || !subject || !details) {
    return NextResponse.json(
      { error: "Name, email, a short summary and details are all required." },
      { status: 400 }
    );
  }

  // Attach the signed-in customer's account, if any (authoritative source).
  let account = null as Awaited<ReturnType<typeof loadAccount>>;
  try {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) account = await loadAccount(user.id);
  } catch {
    /* treat as anonymous */
  }

  const { error } = await sendFeedbackEmail({
    type,
    name,
    email,
    business: body.business?.trim() || null,
    subject,
    details,
    page: body.page?.trim() || null,
    account,
  });

  if (error) {
    return NextResponse.json(
      { error: "Could not send your message. Please try again." },
      { status: 502 }
    );
  }

  return NextResponse.json({ ok: true });
}

async function loadAccount(userId: string) {
  const admin = createAdminClient();
  const { data } = await admin
    .from("customers")
    .select("id, business_name, contact_name, email, phone")
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) return null;
  return {
    customer_id: data.id as string,
    business_name: data.business_name as string,
    contact_name: data.contact_name as string,
    email: data.email as string,
    phone: (data.phone as string | null) ?? null,
  };
}
