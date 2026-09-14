/**
 * The operator's saved replies (§56). GET lists them; POST adds one.
 *
 * Session-authenticated and never part of the public API. Rows live on
 * message_templates with this customer's id; Stayful-provided templates
 * (null customer_id) are the sequence engine's and are never returned here.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  MAX_SNIPPETS_PER_CUSTOMER,
  SNIPPET_COLUMNS,
  validateSnippet,
} from "@/lib/messaging/snippets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const { user, customer } = await getCurrentCustomer();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("message_templates")
    .select(SNIPPET_COLUMNS)
    .eq("customer_id", customer.id)
    .order("title", { ascending: true });
  if (error) return NextResponse.json({ error: "Could not load your snippets." }, { status: 500 });
  return NextResponse.json({ ok: true, snippets: data ?? [] });
}

export async function POST(request: NextRequest) {
  const { user, customer } = await getCurrentCustomer();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: { title?: unknown; body?: unknown; channel?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const v = validateSnippet(body);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });

  const admin = createAdminClient();
  const { count } = await admin
    .from("message_templates")
    .select("id", { count: "exact", head: true })
    .eq("customer_id", customer.id);
  if ((count ?? 0) >= MAX_SNIPPETS_PER_CUSTOMER) {
    return NextResponse.json(
      { error: `You can keep up to ${MAX_SNIPPETS_PER_CUSTOMER} snippets. Delete one to add another.` },
      { status: 409 }
    );
  }

  // template_key is unique per (customer, channel, key, variant); a snippet
  // has no natural key, so one is minted.
  const { data, error } = await admin
    .from("message_templates")
    .insert({
      customer_id: customer.id,
      channel: v.channel,
      template_key: `snippet:${crypto.randomUUID()}`,
      title: v.title,
      body_template: v.body,
    })
    .select(SNIPPET_COLUMNS)
    .single();
  if (error) {
    console.error("[messaging/snippets] insert failed", error);
    return NextResponse.json({ error: "Could not save the snippet." }, { status: 500 });
  }
  return NextResponse.json({ ok: true, snippet: data }, { status: 201 });
}
