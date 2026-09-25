import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AD_CREATIVE_BUCKET,
  adCreativePath,
  checkRenderedBytes,
  type AdRatio,
} from "./storagePaths";

/**
 * Putting a rendered PNG where the operator can download it (§65).
 *
 * ⚠️ A FAILED UPLOAD NEVER COSTS THE COPY. §25's rule, and it is the reason
 * this returns a result rather than throwing: the words are the valuable half
 * and they are already stored, so a storage outage shows the ad with a
 * Retry rather than a failed generation.
 */

export type StoreResult =
  | { ok: true; path: string; size: number }
  | { ok: false; reason: "bad_bytes" | "upload_failed" | "not_recorded" };

/**
 * ⚠️ THE BYTES ARE CHECKED BEFORE THEY GO ANYWHERE. `ImageResponse` does its
 * satori work inside the stream's `start()`, so a failed render is a clean 200
 * with an EMPTY body rather than a throw — and without this the zero-byte
 * result upserts straight over a good render, leaving an ad whose images
 * silently became blank.
 */
export async function storeCreative(
  admin: SupabaseClient,
  params: { customerId: string; draftId: string; ratio: AdRatio; bytes: Buffer }
): Promise<StoreResult> {
  const check = checkRenderedBytes(params.bytes);
  if (!check.ok) {
    console.error(`ads/storeCreative: refusing ${params.ratio} — ${check.reason}`);
    return { ok: false, reason: "bad_bytes" };
  }

  const path = adCreativePath(params.customerId, params.draftId, params.ratio);
  const { error: uploadError } = await admin.storage
    .from(AD_CREATIVE_BUCKET)
    .upload(path, params.bytes, {
      // ⚠️ EXPLICIT, ALWAYS. supabase-js defaults a Buffer to text/plain, and
      // the bucket's mime allowlist then rejects it — so forgetting this
      // presents as "no images, ever" rather than as an error, because a
      // failed upload degrades silently by design.
      contentType: "image/png",
      // One object per (draft, ratio), replaced in place. Nothing to
      // garbage-collect, no window in which two exist.
      upsert: true,
    });
  if (uploadError) {
    console.error("ads/storeCreative: upload failed", uploadError.message);
    return { ok: false, reason: "upload_failed" };
  }

  // ⚠️ `on conflict (draft_id, ratio) do update`, NEVER a plain insert. The
  // unique index does not overwrite, it raises 23505 — so the second render of
  // any draft would fail AFTER its PNG had already been uploaded.
  const { error: rowError } = await admin.from("ad_creatives").upsert(
    {
      draft_id: params.draftId,
      customer_id: params.customerId,
      ratio: params.ratio,
      path,
      size_bytes: params.bytes.length,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "draft_id,ratio" }
  );
  if (rowError) {
    console.error("ads/storeCreative: could not record creative", rowError.message);
    return { ok: false, reason: "not_recorded" };
  }

  return { ok: true, path, size: params.bytes.length };
}

/**
 * Delete a draft's objects, and record what we asked to delete.
 *
 * ⚠️ OBJECTS FIRST, THEN THE ROW. `ad_creatives` cascades from `ad_drafts`, so
 * deleting the draft first destroys the only list of which objects exist —
 * and this bucket is the first here where an object can outlive its only
 * pointer (0092 and 0112 get "nothing to garbage-collect" from one object per
 * owner, not from determinism). The tombstone trigger is what catches a delete
 * that fails halfway; the ordering is what stops it happening.
 */
export async function removeCreatives(
  admin: SupabaseClient,
  params: { customerId: string; draftId: string }
): Promise<{ removed: number; failed: number }> {
  const { data } = await admin
    .from("ad_creatives")
    .select("path")
    .eq("draft_id", params.draftId)
    .eq("customer_id", params.customerId);

  const paths = (data ?? []).map((r) => (r as { path: string }).path).filter(Boolean);
  if (!paths.length) return { removed: 0, failed: 0 };

  const { error } = await admin.storage.from(AD_CREATIVE_BUCKET).remove(paths);
  if (error) {
    console.error("ads/storeCreative: remove failed", error.message);
    return { removed: 0, failed: paths.length };
  }
  return { removed: paths.length, failed: 0 };
}

/** A short-lived link to one stored creative. 60 seconds, like §25's report. */
export async function signCreative(
  admin: SupabaseClient,
  path: string
): Promise<string | null> {
  const { data, error } = await admin.storage
    .from(AD_CREATIVE_BUCKET)
    .createSignedUrl(path, 60);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}
