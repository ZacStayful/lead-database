/**
 * Where a rendered creative lives (§65). ⚠️ IMPORT-FREE.
 */

export const AD_CREATIVE_BUCKET = "ad-creative";

/** Pairs to 0156's `file_size_limit`, the way MAX_REPORT_BYTES pairs to 0092's. */
export const AD_CREATIVE_MAX_BYTES = 2_097_152;

/**
 * ⚠️ THE FLOOR IS NOT DECORATION. A failed Satori render is a clean 200 with
 * an EMPTY body rather than a throw, so without a length bar the zero-byte
 * result uploads straight over a good creative. Every real render in step 1
 * came out between 71 KB and 92 KB; 5 KB is far below anything legitimate and
 * far above anything broken.
 */
export const AD_CREATIVE_MIN_BYTES = 5_120;

/** The first eight bytes of every PNG. Checked before upload, never inferred. */
export const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const AD_RATIOS = ["4x5", "9x16", "1x1"] as const;
export type AdRatio = (typeof AD_RATIOS)[number];

export const AD_RATIO_SIZES: Record<AdRatio, { width: number; height: number }> = {
  "4x5": { width: 1080, height: 1350 },
  "9x16": { width: 1080, height: 1920 },
  "1x1": { width: 1080, height: 1080 },
};

export function isAdRatio(value: unknown): value is AdRatio {
  return typeof value === "string" && (AD_RATIOS as readonly string[]).includes(value);
}

/**
 * One object per (customer, draft, ratio), overwritten in place.
 *
 * ⚠️ The image route resolves an object by looking the row up on
 * (draft_id, ratio) and redirecting to its STORED path — never by rebuilding
 * this path from a URL segment, which would let the segment name the object.
 */
export function adCreativePath(customerId: string, draftId: string, ratio: AdRatio): string {
  return `${customerId}/${draftId}/${ratio}.png`;
}

export function looksLikePng(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_MAGIC.length) return false;
  return PNG_MAGIC.every((b, i) => bytes[i] === b);
}

export type RenderFailure = "empty" | "not_png" | "too_small";

/**
 * Is this actually a usable PNG?
 *
 * ⚠️ PURE, AND SEPARATE FROM THE RENDER, SO IT CAN BE TESTED WITHOUT WASM.
 * `ImageResponse` does its work inside the stream's `start()`, so a failed
 * render never throws — it closes the stream cleanly and `arrayBuffer()`
 * resolves to nothing. Every `try/catch` sees success, and the zero-byte
 * object would upsert straight over a good creative.
 */
export function checkRenderedBytes(bytes: Uint8Array): { ok: true } | { ok: false; reason: RenderFailure } {
  if (bytes.length === 0) return { ok: false, reason: "empty" };
  if (!looksLikePng(bytes)) return { ok: false, reason: "not_png" };
  if (bytes.length < AD_CREATIVE_MIN_BYTES) return { ok: false, reason: "too_small" };
  return { ok: true };
}
