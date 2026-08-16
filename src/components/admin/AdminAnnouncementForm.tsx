"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ANNOUNCEMENT_AUDIENCES, audienceLabel } from "@/lib/announcements";
import type { Announcement, AnnouncementAudience } from "@/lib/types";

const INPUT =
  "mt-1 w-full rounded-md border-[0.5px] border-border bg-background px-3 py-2 text-sm disabled:opacity-60";

/**
 * Compose or edit an announcement.
 *
 * One component for both, as AdminTrainingForm is. Sending is deliberately NOT
 * here — it lives in AnnouncementSendPanel on the edit page, so that no
 * arrangement of this form has a button that mails the customer book. Saving a
 * draft and sending it must always be two separate, differently-shaped actions.
 *
 * The audience buttons carry their live recipient count, computed server-side
 * and passed in. A count on the button is what makes "Guaranteed Rent" a
 * decision rather than a guess — the difference between 14 people and 2 is the
 * whole point of the choice, and it is not something an admin can infer.
 */
export function AdminAnnouncementForm({
  announcement,
  counts,
}: {
  announcement?: Announcement;
  counts: Record<AnnouncementAudience, number>;
}) {
  const router = useRouter();
  const isEdit = Boolean(announcement);
  const locked = announcement?.status === "sent";

  const [subject, setSubject] = useState(announcement?.subject ?? "");
  const [title, setTitle] = useState(announcement?.title ?? "");
  const [bodyText, setBodyText] = useState(announcement?.body_text ?? "");
  const [audience, setAudience] = useState<AnnouncementAudience>(
    announcement?.audience ?? "all"
  );
  const [linkUrl, setLinkUrl] = useState(announcement?.link_url ?? "");
  const [linkLabel, setLinkLabel] = useState(announcement?.link_label ?? "");
  const [showBanner, setShowBanner] = useState(
    announcement?.show_banner ?? true
  );

  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // The title doubles as the subject until the admin says otherwise. Two
  // near-identical fields at the top of a form is where a placeholder subject
  // like "Untitled" gets sent to the whole book.
  function onTitleChange(next: string) {
    if (subject === title) setSubject(next);
    setTitle(next);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);

    const payload = {
      subject,
      title,
      body_text: bodyText,
      audience,
      link_url: linkUrl.trim() || null,
      link_label: linkLabel.trim() || null,
      show_banner: showBanner,
    };

    try {
      const res = await fetch(
        isEdit ? `/api/admin/announcements/${announcement!.id}` : "/api/admin/announcements",
        {
          method: isEdit ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      const data = await res.json().catch(() => null);

      if (!res.ok) {
        setError(data?.error ?? "Could not save this announcement.");
        return;
      }

      if (!isEdit && data?.id) {
        router.push(`/admin/announcements/${data.id}`);
        return;
      }

      setNotice("Saved");
      router.refresh();
    } catch {
      setError("Could not save this announcement.");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/announcements/${announcement!.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error ?? "Could not delete this announcement.");
        return;
      }
      router.push("/admin/announcements");
    } catch {
      setError("Could not delete this announcement.");
    } finally {
      setDeleting(false);
    }
  }

  if (locked) {
    return (
      <div className="space-y-4 text-sm">
        <p className="text-muted-foreground">
          This announcement has been sent, so it can no longer be edited. The
          words below are exactly what went out.
        </p>
        <div className="rounded-md border-[0.5px] border-border bg-muted/30 p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            Subject
          </p>
          <p className="font-medium">{announcement!.subject}</p>
          <p className="mt-3 text-xs uppercase tracking-wide text-muted-foreground">
            Message
          </p>
          <p className="whitespace-pre-line leading-relaxed">
            {announcement!.body_text}
          </p>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={save} className="space-y-5">
      <div>
        <label htmlFor="title" className="text-sm font-medium">
          Title
        </label>
        <input
          id="title"
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
          disabled={saving}
          className={INPUT}
          placeholder="Lead prices are changing in September"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          The heading at the top of the email and on the dashboard banner.
        </p>
      </div>

      <div>
        <label htmlFor="subject" className="text-sm font-medium">
          Email subject
        </label>
        <input
          id="subject"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          disabled={saving}
          className={INPUT}
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Follows the title until you change it. This is the line people decide
          on in their inbox.
        </p>
      </div>

      <div>
        <label htmlFor="body" className="text-sm font-medium">
          Message
        </label>
        <textarea
          id="body"
          value={bodyText}
          onChange={(e) => setBodyText(e.target.value)}
          disabled={saving}
          rows={12}
          className={INPUT}
          placeholder={"Write it as you would say it.\n\nLeave a blank line between paragraphs."}
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Plain text. A blank line starts a new paragraph; nothing else is
          formatted, and any HTML you type arrives as literal text.
        </p>
      </div>

      <div>
        <span className="text-sm font-medium">Who receives it</span>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          {ANNOUNCEMENT_AUDIENCES.map((value) => {
            const selected = audience === value;
            return (
              <button
                key={value}
                type="button"
                onClick={() => setAudience(value)}
                disabled={saving}
                aria-pressed={selected}
                className={`rounded-md border px-3 py-3 text-left text-sm transition-colors disabled:opacity-60 ${
                  selected
                    ? "border-brand bg-brand/10 text-foreground"
                    : "border-border border-[0.5px] hover:bg-accent"
                }`}
              >
                <span className="block font-medium">
                  {audienceLabel(value)}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {counts[value]}{" "}
                  {counts[value] === 1 ? "customer" : "customers"}
                </span>
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Active subscribers only. Counts exclude anyone who has turned
          announcements off in their settings — they will still see the
          dashboard banner.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="linkUrl" className="text-sm font-medium">
            Button link <span className="text-muted-foreground">(optional)</span>
          </label>
          <input
            id="linkUrl"
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            disabled={saving}
            className={INPUT}
            placeholder="https://leads.stayful.co.uk/dashboard/packages"
          />
        </div>
        <div>
          <label htmlFor="linkLabel" className="text-sm font-medium">
            Button label
          </label>
          <input
            id="linkLabel"
            value={linkLabel}
            onChange={(e) => setLinkLabel(e.target.value)}
            disabled={saving || !linkUrl.trim()}
            className={INPUT}
            placeholder="See the new plans"
          />
        </div>
      </div>

      <label className="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          checked={showBanner}
          onChange={(e) => setShowBanner(e.target.checked)}
          disabled={saving}
          className="mt-0.5"
        />
        <span>
          <span className="font-medium">Also show as a dashboard banner</span>
          <span className="block text-xs text-muted-foreground">
            Shown until dismissed, or for 30 days. Turn it off for anything
            that only belongs in an inbox.
          </span>
        </span>
      </label>

      {error && <p className="text-sm text-red-700">{error}</p>}
      {notice && <p className="text-sm text-muted-foreground">{notice}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          disabled={saving}
          className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {saving ? "Saving" : isEdit ? "Save draft" : "Create draft"}
        </button>

        {isEdit &&
          (confirmDelete ? (
            <>
              <button
                type="button"
                onClick={() => void remove()}
                disabled={deleting}
                className="rounded-md border-[0.5px] border-red-300 bg-red-50 px-4 py-2 text-sm font-medium text-red-700 transition-colors hover:bg-red-100 disabled:opacity-50"
              >
                {deleting ? "Deleting" : "Confirm delete"}
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                disabled={deleting}
                className="rounded-md border-[0.5px] border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent disabled:opacity-50"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="rounded-md border-[0.5px] border-border px-4 py-2 text-sm font-medium text-red-700 transition-colors hover:bg-accent"
            >
              Delete draft
            </button>
          ))}
      </div>
    </form>
  );
}
