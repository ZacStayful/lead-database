// STAGE 0 STUB — proves the /.well-known rewrite resolves. Replaced in Stage 3.
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ ok: true, stub: true });
}
