import { NextResponse, type NextRequest } from "next/server";
import { ingestLead, GR_BANNED_COLUMNS } from "@/lib/ingest";
import type { N8nLeadPayload } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  // 1. Validate the Authorization header.
  const auth = request.headers.get("authorization");
  const expected = `Bearer ${process.env.N8N_WEBHOOK_SECRET}`;
  if (!process.env.N8N_WEBHOOK_SECRET || auth !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. Parse the JSON body.
  let raw: Record<string, unknown>;
  try {
    raw = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // 2a. Strip the permanently-banned GR columns from any payload before any
  // processing, so they can never be stored regardless of lead type.
  for (const banned of GR_BANNED_COLUMNS) {
    delete raw[banned];
  }

  // 2b. Detect lead type. Management is the default; the GR board sends
  // lead_type = "guaranteed_rent". Field mapping per type happens in ingest.
  const body = raw as N8nLeadPayload;
  body.lead_type = body.lead_type === "guaranteed_rent" ? "guaranteed_rent" : "management";

  if (!body.monday_item_id || !body.lead_name) {
    return NextResponse.json(
      { error: "Missing required fields: monday_item_id, lead_name" },
      { status: 400 }
    );
  }

  // 3–8. Idempotent insert + assignment + notifications.
  const result = await ingestLead(body);

  const status = result.status === "error" ? 500 : 200;
  return NextResponse.json(result, { status });
}
