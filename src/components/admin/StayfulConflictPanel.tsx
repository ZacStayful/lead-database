import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { pipelineBoardId, STAYFUL_PIPELINE_CONFLICT_GROUPS } from "@/lib/monday";

export interface OwedRowView {
  id: string;
  customer_id: string;
  business_name: string | null;
  origin_status: string;
  status: string;
  created_at: string;
  fulfilled_at: string | null;
  fulfilled_lead_id: string | null;
  fulfilled_lead_name: string | null;
  notes_count: number;
}

const MATCHED_BY: Record<string, string> = {
  item: "the same Monday item",
  email: "the same email address",
  phone: "the same phone number",
};

/**
 * Why this lead was withdrawn: Stayful's own pipeline holds the landlord
 * (§64). Display only — there is no override by decision, so there is no
 * button. Renders nothing on an unflagged lead.
 */
export function StayfulConflictPanel({
  at,
  itemId,
  groupId,
  matchedBy,
  owed,
}: {
  at: string | null;
  itemId: string | null;
  groupId: string | null;
  matchedBy: string | null;
  owed: OwedRowView[];
}) {
  if (!at) return null;

  const groupName =
    (groupId &&
      STAYFUL_PIPELINE_CONFLICT_GROUPS[
        groupId as keyof typeof STAYFUL_PIPELINE_CONFLICT_GROUPS
      ]) ||
    groupId ||
    "a pipeline group";
  const itemUrl = itemId
    ? `https://stayful.monday.com/boards/${pipelineBoardId()}/pulses/${itemId}`
    : null;

  return (
    <div className="rounded-lg border-[0.5px] border-amber-300 bg-amber-50 p-4">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
        <div className="space-y-2 text-sm">
          <p className="font-medium text-amber-900">
            In Stayful&apos;s own sales pipeline — withdrawn from allocation for good
          </p>
          <p className="text-amber-900/90">
            Matched on {MATCHED_BY[matchedBy ?? ""] ?? matchedBy ?? "an unknown rule"} to
            an item in <span className="font-medium">{groupName}</span> on{" "}
            {formatDate(at)}.{" "}
            {itemUrl && (
              <a
                href={itemUrl}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2"
              >
                Open the Monday item
              </a>
            )}
          </p>
          <p className="text-xs text-amber-900/80">
            Nothing lifts this. Every live assignment was withdrawn and a
            replacement is owed to each holder at the price they paid; settled
            assignments (won, rejected, closed) were left alone.
          </p>
          {owed.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs text-amber-900/90">
              {owed.map((o) => (
                <li key={o.id}>
                  <Link
                    href={`/admin/customers/${o.customer_id}`}
                    className="font-medium underline-offset-2 hover:underline"
                  >
                    {o.business_name ?? "Unknown"}
                  </Link>{" "}
                  held it as <span className="font-medium">{o.origin_status}</span>
                  {o.notes_count > 0 && ` with ${o.notes_count} note${o.notes_count === 1 ? "" : "s"}`}
                  {" · "}
                  {o.status === "fulfilled" && o.fulfilled_lead_id ? (
                    <>
                      replaced with{" "}
                      <Link
                        href={`/admin/leads/${o.fulfilled_lead_id}`}
                        className="underline-offset-2 hover:underline"
                      >
                        {o.fulfilled_lead_name ?? "a lead"}
                      </Link>{" "}
                      on {formatDate(o.fulfilled_at)}
                    </>
                  ) : o.status === "cancelled" ? (
                    "replacement cancelled"
                  ) : (
                    "replacement still owed — the next lead that fits their filter goes to them first"
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
