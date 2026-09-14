/**
 * Edit or delete one saved reply (§56). Scoped by customer_id on every write,
 * so another customer's snippet id reads as nonexistent.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { SNIPPET_COLUMNS, validateSnippet } from "@/lib/messaging/snippets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const { user, customer } = await getCurrentCustomer();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: { title?: unknown; body?: unknown; channel?: unknown; is_active?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("message_templates")
    .select("id, title, body_template, channel")
    .eq("id", params.id)
    .eq("customer_id", customer.id)
    .maybeSingle();
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const v = validateSnippet({
    title: body.title ?? existing.title,
    body: body.body ?? existing.body_template,
    channel: body.channel ?? existing.channel,
  });
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });

  const update: Record<string, unknown> = {
    title: v.title,
    body_template: v.body,
    channel: v.channel,
    updated_at: new Date().toISOString(),
  };
  if (typeof body.is_active === "boolean") update.is_active = body.is_active;

  const { data, error } = await admin
    .from("message_templates")
    .update(update)
    .eq("id", params.id)
    .eq("customer_id", customer.id)
    .select(SNIPPET_COLUMNS)
    .single();
  if (error) return NextResponse.json({ error: "Could not save the snippet." }, { status: 500 });
  return NextResponse.json({ ok: true, snippet: data });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  const { user, customer } = await getCurrentCustomer();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const admin = createAdminClient();
  const { error, count } = await admin
    .from("message_templates")
    .delete({ count: "exact" })
    .eq("id", params.id)
    .eq("customer_id", customer.id);
  if (error) return NextResponse.json({ error: "Could not delete the snippet." }, { status: 500 });
  if (!count) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
