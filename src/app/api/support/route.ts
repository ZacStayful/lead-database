import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendSupportEmail } from "@/lib/emails";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Receive a customer support request and email it to the Stayful team. If the
 * sender is signed in, their account record is attached for context.
 */
export async function POST(request: NextRequest) {
  let body: {
    name?: string;
    email?: string;
    business?: string;
    subject?: string;
    message?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const name = body.name?.trim();
  const email = body.email?.trim();
  const subject = body.subject?.trim();
  const message = body.message?.trim();

  if (!name || !email || !subject || !message) {
    return NextResponse.json(
      { error: "Name, email, a subject and your message are all required." },
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

  const { error } = await sendSupportEmail({
    name,
    email,
    business: body.business?.trim() || null,
    subject,
    message,
    account,
  });

  if (error) {
    return NextResponse.json(
      { error: "Could not send your request. Please try again." },
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
