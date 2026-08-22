/**
 * GET /api/v1/leads/{id}/report — the stored property-analysis PDF.
 *
 * `{id}` is an ASSIGNMENT id (see ../../route.ts).
 *
 * STREAMS THE BYTES rather than returning a signed URL — see
 * src/lib/api/service/report.ts for why that distinction matters. A missing
 * report and a lead that is not yours are the same 404.
 */
import { NextResponse } from "next/server";
import { withApi } from "@/lib/api/handler";
import { getReport, type ReportPayload } from "@/lib/api/service/report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi<ReportPayload>(
  {
    scope: "leads:read",
    operation: "GET /v1/leads/{id}/report",
    render: (payload) =>
      new NextResponse(Buffer.from(payload.bytes), {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="${payload.filename}"`,
          "Content-Length": String(payload.bytes.byteLength),
        },
      }) as unknown as NextResponse,
  },
  async (caller, _request, params) => getReport(caller, params.id ?? "")
);
