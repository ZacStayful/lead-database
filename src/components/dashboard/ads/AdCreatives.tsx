"use client";

import { AD_COPY } from "@/lib/ads/copy";

/**
 * The three statics (§65).
 *
 * ⚠️ THE DOWNLOAD GOES THROUGH OUR OWN ROUTE, not the signed URL rendered
 * beside it. The signature lasts 60 seconds, so a page left open for a minute
 * would hand the operator a dead link — where the route mints a fresh one on
 * every click.
 */
export function AdCreatives({
  draftId,
  creatives,
}: {
  draftId: string;
  creatives: Array<{ ratio: string; sizeBytes: number; url: string | null }>;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-[#1a1a19]">{AD_COPY.result.creativeHeading}</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {creatives.map((c) => (
          <div key={c.ratio} className="rounded-xl border border-[#e4e6e0] bg-white p-3">
            <p className="text-xs font-medium text-[#1a1a19]">{c.ratio.replace("x", ":")}</p>
            {c.url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={c.url}
                alt={`Your ad at ${c.ratio.replace("x", ":")}`}
                className="mt-2 w-full rounded-lg border border-[#eceee8]"
              />
            ) : (
              <p className="mt-2 text-xs text-[#6b706a]">Could not load this one.</p>
            )}
            <a
              href={`/api/customer/ads/${draftId}/image/${c.ratio}`}
              className="mt-2 inline-block text-xs font-medium text-[#1a1a19] underline"
            >
              {AD_COPY.result.download}
            </a>
          </div>
        ))}
      </div>
    </section>
  );
}
