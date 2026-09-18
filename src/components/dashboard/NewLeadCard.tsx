"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { NewLeadCard as NewLeadCardModel, NewLeadItem } from "@/lib/home/newLeadCard";

/**
 * The in-app half of the new-lead notification (§63.6), in the announcement
 * banner's slot on the dashboard home. AnnouncementBanner's shape: one card,
 * dismissable, optimistic.
 *
 * Dismissing marks the PRIMARY lead's notification read — the same write the
 * lead page makes when the lead is opened (§63.5) — so the card, the bell and
 * the "new" count all agree. The rest stay unread until each is opened.
 */
export function NewLeadCard({ card }: { card: NewLeadCardModel }) {
  const router = useRouter();
  const [hidden, setHidden] = useState(false);

  if (hidden) return null;

  function dismiss() {
    setHidden(true);
    void fetch(`/api/customer/notifications/${card.primary.notificationId}/read`, {
      method: "POST",
    })
      .then(() => router.refresh())
      .catch(() => {
        // Left hidden for this session regardless (AnnouncementBanner's rule).
      });
  }

  const p = card.primary;
  const total = 1 + card.rest.length + card.moreCount;

  return (
    <div className="relative rounded-xl border-[0.5px] border-brand/40 bg-brand/5 p-5 pr-12">
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss new lead notice"
        className="absolute right-3 top-3 rounded-md p-1 text-muted-foreground transition-colors hover:bg-brand/10 hover:text-foreground"
      >
        <X className="h-4 w-4" />
      </button>

      <p className="text-xs font-medium uppercase tracking-wide text-brand">
        {total === 1 ? "New lead" : `${total} new leads`}
      </p>
      <h2 className="mt-1 text-base font-semibold">
        {p.name}
        {p.town ? <span className="font-normal text-muted-foreground"> · {p.town}</span> : null}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">{summaryLine(p)}</p>

      <Button asChild className="mt-3 h-[38px] rounded-lg bg-brand font-semibold text-white hover:bg-brand-dark">
        <Link href={p.href}>Open this lead →</Link>
      </Button>

      {card.rest.length > 0 && (
        <ul className="mt-4 space-y-1 border-t border-brand/20 pt-3 text-sm">
          {card.rest.map((item) => (
            <li key={item.notificationId}>
              <Link href={item.href} className="font-medium text-brand hover:underline">
                {item.name}
              </Link>
              <span className="text-muted-foreground"> · {summaryLine(item)}</span>
            </li>
          ))}
          {card.moreCount > 0 && (
            <li>
              <Link href="/dashboard/leads?activity=new" className="text-brand hover:underline">
                and {card.moreCount} more →
              </Link>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function summaryLine(item: NewLeadItem): string {
  const parts: string[] = [];
  if (item.postcodeArea) parts.push(item.postcodeArea);
  if (item.bedrooms) parts.push(`${item.bedrooms} bed`);
  if (item.projectedGross) parts.push(`projected ${item.projectedGross}`);
  if (item.receivedLabel) parts.push(`received ${item.receivedLabel}`);
  return parts.join(" · ");
}
