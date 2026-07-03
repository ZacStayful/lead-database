import { NextResponse, type NextRequest } from "next/server";
import { ingestLead } from "@/lib/ingest";
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
  let body: N8nLeadPayload;
  try {
    body = (await request.json()) as N8nLeadPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

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
