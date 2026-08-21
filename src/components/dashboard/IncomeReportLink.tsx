import { FileText } from "lucide-react";

/**
 * A link to the Stayful property analysis a lead's income figures were read
 * from (0092).
 *
 * ONE COMPONENT, TWO SURFACES — the lead detail page and the expired-leads pool
 * card — for the reason IncomeProjection gives about itself: an operator should
 * meet the same thing in the same words wherever they meet it.
 *
 * RENDERS NOTHING WITHOUT A STORED REPORT. 21 management leads carry no
 * analysis and no Guaranteed Rent lead ever will, and those should look like a
 * lead from before this existed rather than like a broken link.
 *
 * Opens in a new tab and is served inline by the route, because this is read
 * before a call rather than filed.
 */
export function IncomeReportLink({
  leadId,
  available,
  sizeBytes,
  className,
}: {
  leadId: string;
  available: boolean;
  sizeBytes?: number | null;
  className?: string;
}) {
  if (!available) return null;

  return (
    <a
      href={`/api/leads/${leadId}/report`}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-1.5 text-sm text-brand hover:underline ${
        className ?? ""
      }`}
    >
      <FileText className="h-4 w-4 shrink-0" />
      Full property analysis
      {typeof sizeBytes === "number" && sizeBytes > 0 && (
        <span className="text-muted-foreground">
          (PDF · {humanSize(sizeBytes)})
        </span>
      )}
    </a>
  );
}

/**
 * The same three tiers LeadFiles and the admin assignment page use. Copied
 * rather than extracted: those two already disagree slightly about null
 * handling, and unifying three call sites is a tidy-up that does not belong in
 * a change about storing reports.
 */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
