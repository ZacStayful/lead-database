import { NextResponse } from "next/server";
import { AD_NO_STORE, adJson, adSession, loadDraft } from "@/lib/ads/session";
import { signCreative } from "@/lib/ads/storeCreative";
import { isAdRatio } from "@/lib/ads/storagePaths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Download one creative (§65).
 *
 * ⚠️ THE PATH COMES FROM `ad_creatives`, NEVER FROM THE URL SEGMENT. Building
 * `<customer>/<draft>/<ratio>.png` from the request would make the bucket's
 * layout addressable — and the one thing standing between a guessed segment
 * and somebody else's object would be a string comparison in this file.
 */
export async function GET(
  _request: Request,
  { params }: { params: { id: string; ratio: string } }
) {
  const gate = await adSession();
  if (!gate.ok) return gate.response;
  const { admin, customer } = gate.session;

  if (!isAdRatio(params.ratio)) return adJson({ error: "Not found" }, 404);

  const draft = await loadDraft(admin, customer.id, params.id);
  if (!draft) return adJson({ error: "Not found" }, 404);

  const { data } = await admin
    .from("ad_creatives")
    .select("path")
    .eq("draft_id", draft.id)
    .eq("customer_id", customer.id)
    .eq("ratio", params.ratio)
    .maybeSingle();

  const path = (data as { path?: string } | null)?.path;
  if (!path) return adJson({ error: "Not found" }, 404);

  const url = await signCreative(admin, path);
  if (!url) return adJson({ error: "Not found" }, 404);

  // 60 seconds, like §25's report link, and never cached on the way past.
  return NextResponse.redirect(url, { status: 302, headers: AD_NO_STORE });
}
