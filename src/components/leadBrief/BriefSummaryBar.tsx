import Link from "next/link";
import { Target } from "lucide-react";
import { BRIEF_EDITOR_HREF, EDIT_COPY } from "@/lib/leadBrief/editCopy";

/**
 * "Your brief" bar on /dashboard/leads (Lead Brief Phase 5): the brief in one
 * line, a pending area change if one is saved, and Edit. Rendered only for a
 * customer who has confirmed a brief (the leads page decides), so an existing
 * customer's leads page is unchanged.
 *
 * The expected mix is deliberately absent: a priorities save keeps the mix
 * from the last area save, so it would read as stale.
 */
export function BriefSummaryBar({ summary, pending }: { summary: string; pending: string | null }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border-[0.5px] border-border bg-brand-light/60 px-4 py-3 text-sm">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <Target className="mt-0.5 h-4 w-4 shrink-0 text-brand-dark" aria-hidden />
        <div>
          <p className="font-medium text-ink">{summary}</p>
          {pending && <p className="mt-1 text-ink-2">{pending}</p>}
        </div>
      </div>
      <Link href={BRIEF_EDITOR_HREF} className="shrink-0 font-medium text-brand-dark underline underline-offset-2">
        {EDIT_COPY.barEdit}
      </Link>
    </div>
  );
}
