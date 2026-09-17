"use client";

/**
 * The Meta (Facebook/Instagram) browser pixel.
 *
 * Mounted once in the root layout. Fires `PageView` on the public marketing
 * pages; the `Lead` event is fired from the enquiry form itself, and
 * `Purchase` is server-side only (see src/lib/meta/capi.ts).
 *
 * Renders NOTHING — no script, no cookie, no request — when
 * NEXT_PUBLIC_META_PIXEL_ID is unset. That is what lets this ship ahead of the
 * ad account being ready.
 */

import Script from "next/script";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { isTrackedPath } from "@/lib/meta/paths";
import { metaTrackingAllowed } from "@/lib/meta/consent";

/**
 * Mint a `_fbp` browser id ourselves when the pixel is blocked?
 *
 * No. `_fbc` (below) carries the ad CLICK id and is the difference between a
 * conversion being attributed to an advert and not; a self-minted `_fbp` is a
 * random browser id that no Meta system ever saw being set, so it adds almost
 * nothing to match quality — while being a first-party advertising cookie that
 * we write with our own code, which is a slightly worse PECR posture than one
 * a blocked third party simply failed to set. Flip to true if that trade ever
 * changes.
 */
const MINT_FBP = false;

declare global {
  interface Window {
    fbq?: (...args: unknown[]) => void;
  }
}

export function MetaPixel() {
  // ⚠️ Read as a LITERAL member expression, never through requireEnv() or any
  // other dynamic lookup. Next inlines NEXT_PUBLIC_* at build time only when it
  // can see `process.env.NEXT_PUBLIC_X` written out; a dynamic read is
  // undefined in the client bundle. (requireEnv also throws, which is wrong
  // for a measurement feature.)
  const pixelId = process.env.NEXT_PUBLIC_META_PIXEL_ID;

  const pathname = usePathname();
  const firstPageView = useRef(true);

  const active = Boolean(pixelId) && metaTrackingAllowed() && isTrackedPath(pathname);

  // PageView on client-side navigation.
  //
  // The inline snippet below already fires the FIRST PageView, so the initial
  // run of this effect must be skipped or every landing is counted twice.
  useEffect(() => {
    if (!active) return;
    if (firstPageView.current) {
      firstPageView.current = false;
      return;
    }
    window.fbq?.("track", "PageView");
  }, [pathname, active]);

  // Capture the ad click id ourselves, independently of whether fbevents.js
  // loaded.
  //
  // ⚠️ THIS IS THE POINT OF THE WHOLE BLOCK: an ad blocker blocks the request
  // to connect.facebook.net, not our own bundle. So when the pixel is blocked
  // — which is the case the server-side Conversions API exists to recover —
  // this still writes `_fbc`, and the enquiry route reads it off the request
  // cookies and sends it with the server Lead. Without it those conversions
  // land with no click attribution at all.
  useEffect(() => {
    if (!active) return;
    try {
      const fbclid = new URLSearchParams(window.location.search).get("fbclid");
      // Only when absent. When the real pixel is alive it OWNS this cookie, and
      // racing it produces two different fbc values for one visitor.
      if (fbclid && !/(^|;\s*)_fbc=/.test(document.cookie)) {
        // Meta's documented manual form: fb.<subdomainIndex>.<createdMs>.<fbclid>
        // The timestamp is MILLISECONDS. Seconds here fails silently.
        const value = `fb.1.${Date.now()}.${encodeURIComponent(fbclid)}`;
        document.cookie = `_fbc=${value}; path=/; max-age=7776000; samesite=lax; secure`;
      }
      if (MINT_FBP && !/(^|;\s*)_fbp=/.test(document.cookie)) {
        const rand = Math.floor(Math.random() * 10_000_000_000);
        document.cookie = `_fbp=fb.1.${Date.now()}.${rand}; path=/; max-age=7776000; samesite=lax; secure`;
      }
    } catch {
      // document.cookie can throw in a sandboxed context. Attribution is not
      // worth breaking a page render over.
    }
  }, [active]);

  if (!active) return null;

  // ⚠️ usePathname, NOT useSearchParams — and this is load-bearing rather than
  // a preference. In Next 14.2 a client component calling useSearchParams()
  // outside <Suspense> is a hard `next build` failure, and wrapping THIS
  // component (which lives in the ROOT layout) in Suspense de-opts every page
  // in the app to client-side rendering, including the 2,500-line static
  // marketing page. The only thing lost is a PageView when just the query
  // string changes, which is not a pageview worth counting — and fbq reads
  // document.location itself, so the full URL still reaches Meta either way.
  return (
    <Script
      id="meta-pixel"
      strategy="afterInteractive"
      dangerouslySetInnerHTML={{
        __html: `
!function(f,b,e,v,n,t,s)
{if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};
if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];
s.parentNode.insertBefore(t,s)}(window,document,'script',
'https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '${pixelId}');
fbq('track', 'PageView');
        `.trim(),
      }}
    />
  );
}
