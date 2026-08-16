"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";

/**
 * The dashboard copy of an announcement.
 *
 * Exists because an email is not a place things stay. The banner is what a
 * customer who deleted the message, or never opened it, can still read — and it
 * is shown on the AUDIENCE rule alone, so somebody who turned the emails off
 * still sees it here. The opt-out is about their inbox, not about being kept in
 * the dark.
 *
 * Dismissal is optimistic. Nothing depends on the write landing: the worst case
 * is the banner returning on the next load, which is a great deal better than
 * making somebody wait on a round trip to close a notice.
 */
export function AnnouncementBanner({
  id,
  title,
  paragraphs,
  linkUrl,
  linkLabel,
}: {
  id: string;
  title: string;
  paragraphs: string[];
  linkUrl: string | null;
  linkLabel: string | null;
}) {
  const router = useRouter();
  const [hidden, setHidden] = useState(false);

  if (hidden) return null;

  function dismiss() {
    setHidden(true);
    void fetch(`/api/customer/announcements/${id}/dismiss`, {
      method: "POST",
    })
      .then(() => router.refresh())
      .catch(() => {
        // Left hidden for this session regardless. A failed dismissal that
        // reopened the banner under the reader's cursor would be worse than
        // one that quietly comes back tomorrow.
      });
  }

  return (
    <div className="relative rounded-xl border-[0.5px] border-brand/40 bg-brand/5 p-5 pr-12">
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss announcement"
        className="absolute right-3 top-3 rounded-md p-1 text-muted-foreground transition-colors hover:bg-brand/10 hover:text-foreground"
      >
        <X className="h-4 w-4" />
      </button>

      <p className="text-xs font-medium uppercase tracking-wide text-brand">
        Announcement
      </p>
      <h2 className="mt-1 text-base font-semibold">{title}</h2>

      <div className="mt-2 space-y-2">
        {paragraphs.map((p, i) => (
          <p
            key={i}
            className="whitespace-pre-line text-sm leading-relaxed text-muted-foreground"
          >
            {p}
          </p>
        ))}
      </div>

      {linkUrl && linkLabel && (
        <a
          href={linkUrl}
          className="mt-3 inline-block text-sm font-medium text-brand hover:underline"
        >
          {linkLabel} →
        </a>
      )}
    </div>
  );
}
