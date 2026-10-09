import { BRIEF_BOOKING_URL } from "@/lib/leadBrief/briefCopy";
import { FUNNEL_COPY } from "@/lib/funnel/copy";

/**
 * The two ways out, on every screen (02 locked decision 9): book a call, or
 * send the read-only summary to a partner. The summary link carries the
 * summary token, never the funnel token (funnel/token.ts), so forwarding it
 * hands over nothing that can save, preview or pay.
 *
 * Both open in a new tab with no referrer: the funnel token is in this page's
 * path and must not travel to another site.
 */
export function FunnelExits({ summaryPath }: { summaryPath: string | null }) {
  return (
    <div className="space-y-2 border-t border-line pt-4 text-sm">
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        <a
          href={BRIEF_BOOKING_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-brand-dark underline underline-offset-2"
        >
          {FUNNEL_COPY.bookCallInstead}
        </a>
        {summaryPath && (
          <a
            href={summaryPath}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-brand-dark underline underline-offset-2"
          >
            {FUNNEL_COPY.sendToPartner}
          </a>
        )}
      </div>
      {summaryPath && <p className="text-xs text-ink-2">{FUNNEL_COPY.sendToPartnerHelp}</p>}
    </div>
  );
}
