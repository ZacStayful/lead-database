"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { audienceLabel } from "@/lib/announcements";
import type { Announcement } from "@/lib/types";

/**
 * The send half of an announcement: test it, then send it.
 *
 * Kept out of AdminAnnouncementForm on purpose. A form whose submit button
 * sometimes saves and sometimes mails the entire customer book is one
 * mis-click away from an accident that cannot be undone, so the two live in
 * different components with differently-shaped buttons.
 *
 * The confirmation is an expanded inline panel rather than a two-button swap,
 * following the reject confirmation in LeadDetail. The difference matters: a
 * swap asks "are you sure" with no new information, and this needs to state the
 * count and the audience in words before the click, because those are exactly
 * the two things an admin can have wrong without noticing.
 */
export function AnnouncementSendPanel({
  announcement,
  recipientCount,
  optedOutCount,
  adminEmail,
}: {
  announcement: Announcement;
  recipientCount: number;
  optedOutCount: number;
  adminEmail: string | null;
}) {
  const router = useRouter();
  const [testTo, setTestTo] = useState(adminEmail ?? "");
  const [testing, setTesting] = useState(false);
  const [sending, setSending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const label = audienceLabel(announcement.audience).toLowerCase();
  const nothingToSend = recipientCount === 0;

  async function sendTest() {
    setTesting(true);
    setError(null);
    setToast(null);
    try {
      const res = await fetch(
        `/api/admin/announcements/${announcement.id}/test`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to: testTo.trim() || undefined }),
        }
      );
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? "Could not send the test email.");
        return;
      }
      setToast(`Test sent to ${data?.to ?? testTo}.`);
    } catch {
      setError("Could not send the test email.");
    } finally {
      setTesting(false);
    }
  }

  async function send() {
    setSending(true);
    setError(null);
    setToast(null);
    try {
      const res = await fetch(
        `/api/admin/announcements/${announcement.id}/send`,
        { method: "POST" }
      );
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? "Could not send this announcement.");
        return;
      }
      const failed = Number(data?.failed_count ?? 0);
      setToast(
        failed > 0
          ? `Sent to ${data.sent_count}. ${failed} failed — see the delivery log below.`
          : `Sent to ${data.sent_count} ${
              data.sent_count === 1 ? "customer" : "customers"
            }.`
      );
      setConfirming(false);
      router.refresh();
    } catch {
      // A long run can outlive the browser's patience. The send is still going
      // and every recipient is claimed before they are emailed, so the honest
      // message is "check the log", not "it failed".
      setError(
        "Lost contact with the server before the run reported back. Refresh and check the delivery log below before trying again — anyone already emailed will be skipped."
      );
    } finally {
      setSending(false);
    }
  }

  if (announcement.status === "sent") {
    return (
      <div className="rounded-lg border-[0.5px] border-border bg-card p-5 text-sm">
        <p className="font-medium">Sent</p>
        <p className="mt-1 text-muted-foreground">
          Emailed to {announcement.recipient_count ?? 0}{" "}
          {announcement.recipient_count === 1 ? "customer" : "customers"}
          {announcement.sent_at
            ? ` on ${new Date(announcement.sent_at).toLocaleDateString("en-GB", {
                day: "numeric",
                month: "long",
                year: "numeric",
              })}`
            : ""}
          . It cannot be sent or edited again — write a new announcement if
          something needs correcting.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-lg border-[0.5px] border-border bg-card p-5">
      <div>
        <h2 className="text-sm font-medium">Send a test first</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Goes to one address, is not counted, and changes nothing. The subject
          arrives prefixed with [TEST].
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <input
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
            disabled={testing}
            placeholder="you@stayful.co.uk"
            className="min-w-0 flex-1 rounded-md border-[0.5px] border-border bg-background px-3 py-2 text-sm disabled:opacity-60"
          />
          <button
            type="button"
            onClick={() => void sendTest()}
            disabled={testing}
            className="rounded-md border-[0.5px] border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent disabled:opacity-50"
          >
            {testing ? "Sending" : "Send test"}
          </button>
        </div>
      </div>

      <div className="border-t-[0.5px] border-border pt-4">
        {confirming ? (
          <div className="rounded-md border-[0.5px] border-border bg-muted/30 p-4">
            <p className="text-sm font-medium">
              Email {recipientCount}{" "}
              {recipientCount === 1 ? "customer" : "customers"}?
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              This goes to every {label.replace(/s$/, "")} on an active
              subscription
              {optedOutCount > 0
                ? `, except the ${optedOutCount} who turned announcements off`
                : ""}
              . It cannot be unsent, and this announcement cannot be edited
              afterwards.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void send()}
                disabled={sending}
                className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {sending ? "Sending…" : "Confirm and send"}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={sending}
                className="rounded-md border-[0.5px] border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setConfirming(true)}
              disabled={nothingToSend}
              className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              Send to {recipientCount}{" "}
              {recipientCount === 1 ? "customer" : "customers"}
            </button>
            <p className="mt-2 text-xs text-muted-foreground">
              {nothingToSend
                ? `Nobody currently matches this audience (${audienceLabel(
                    announcement.audience
                  )}), so there is nothing to send.`
                : "Save your draft before sending — the email uses what is stored, not what is on screen."}
            </p>
          </>
        )}
      </div>

      {error && <p className="text-sm text-red-700">{error}</p>}
      {toast && (
        <div className="rounded-md border-[0.5px] border-border bg-muted/50 px-4 py-2 text-sm">
          {toast}
        </div>
      )}
    </div>
  );
}
