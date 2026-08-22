/**
 * GET /api/v1/me — the caller's account, per product they hold.
 *
 * Part of the read-only public API. See src/lib/api/schema.ts for the field
 * vocabulary and CLAUDE.md for what this surface may and may not expose.
 */
import { withApi } from "@/lib/api/handler";
import { getAccount } from "@/lib/api/service/account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(
  { scope: "profile:read", operation: "GET /v1/me" },
  async (caller) => getAccount(caller)
);
