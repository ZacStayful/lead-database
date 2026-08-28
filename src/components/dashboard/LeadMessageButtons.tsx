"use client";

/**
 * "Send email" and "Send WhatsApp" on a lead, and the composer behind them (§28).
 *
 * THE BUTTONS ARE ALWAYS VISIBLE. §18E's rule: a hidden button reads as a
 * missing feature, and an offered one that 400s reads as a bug. A button that
 * opens a modal explaining what setup is needed is neither — which is why the
 * unconnected state lives in the modal rather than in a disabled button.
 *
 * The only case where a button is disabled is the LEAD having no email or no
 * phone. That is missing data, not missing setup, and there is nothing to
 * configure that would fix it.
 *
 * FIVE STATES, because they need different things from the reader:
 *   not_connected  — what it costs, what it takes, Cancel / Begin setup
 *   setup_started  — do NOT send them back to step one
 *   not_sendable   — a settled lead: the reason in words, thread readable
 *   ready          — the composer
 *   failed         — the reason, AND THE TYPED TEXT PRESERVED
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Mail, MessageCircle, Loader2, AlertCircle, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ChannelAvailability, MessageChannel } from "@/lib/messaging/types";

interface ThreadMessage {
  id: string;
  direction: "outbound" | "inbound";
  status: string;
  subject: string | null;
  body_text: string | null;
  created_at: string;
  first_opened_at: string | null;
  first_clicked_at: string | null;
  read_at: string | null;
}

const CHANNEL_LABEL: Record<MessageChannel, string> = {
  email: "email",
  whatsapp: "WhatsApp",
};

/**
 * What the customer needs before this channel works, in their terms. Stated
 * BEFORE they invest any effort — the honest ordering, and the one thing that
 * makes the "Begin setup" decision an informed one.
 */
const SETUP_BLURB: Record<MessageChannel, { what: string; needs: string[] }> = {
  email: {
    what: "Send emails to landlords from your own domain, and see replies, opens and clicks back here.",
    needs: [
      "A free Resend account (resend.com) — 100 emails a day at no cost",
      "About seven DNS records on a subdomain we set up for you",
      "Roughly 15 minutes, and we can do it with you on a call",
    ],
  },
  whatsapp: {
    what: "Message landlords on WhatsApp from your own number, with replies coming back into the lead.",
    needs: [
      "A TimelinesAI account (from $25 a month) connected to your WhatsApp",
      "One token pasted into your settings",
      "Roughly 5 minutes",
    ],
  },
};

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Delivery state in the operator's language, never the vendor's. */
function statusLabel(m: ThreadMessage): string {
  if (m.direction === "inbound") return "Received";
  if (m.status === "failed") return "Failed";
  if (m.first_clicked_at) return "Clicked a link";
  if (m.first_opened_at) return "Opened";
  if (m.read_at) return "Read";
  if (m.status === "delivered") return "Delivered";
  if (m.status === "sent") return "Sent";
  if (m.status === "queued") return "Sending…";
  return m.status;
}

export function LeadMessageButtons({
  assignmentId,
  leadId,
  leadName,
  channels,
}: {
  assignmentId: string;
  leadId: string;
  leadName: string;
  channels: ChannelAvailability[];
}) {
  const [open, setOpen] = useState<MessageChannel | null>(null);

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {channels.map((c) => (
          <ChannelButton key={c.channel} availability={c} onOpen={() => setOpen(c.channel)} />
        ))}
      </div>

      {channels.map((c) => (
        <MessageDialog
          key={c.channel}
          availability={c}
          assignmentId={assignmentId}
          leadId={leadId}
          leadName={leadName}
          open={open === c.channel}
          onOpenChange={(v) => setOpen(v ? c.channel : null)}
        />
      ))}
    </>
  );
}

function ChannelButton({
  availability,
  onOpen,
}: {
  availability: ChannelAvailability;
  onOpen: () => void;
}) {
  const { channel, hasRecipient, messageCount, unreadInbound } = availability;
  const Icon = channel === "email" ? Mail : MessageCircle;
  const label = channel === "email" ? "Send email" : "Send WhatsApp";

  // Missing DATA, not missing setup — nothing to configure would fix it, so this
  // is the one case that disables rather than explaining in the modal.
  if (!hasRecipient) {
    return (
      <Button
        variant="outline"
        size="sm"
        disabled
        title={
          channel === "email"
            ? "No email address on this lead."
            : "No phone number on this lead."
        }
      >
        <Icon className="mr-2 h-4 w-4" />
        {label}
      </Button>
    );
  }

  return (
    <Button variant="outline" size="sm" onClick={onOpen}>
      <Icon className="mr-2 h-4 w-4" />
      {label}
      {messageCount > 0 && (
        <span
          className={
            unreadInbound > 0
              ? "ml-2 rounded-full bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground"
              : "ml-2 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
          }
        >
          {unreadInbound > 0 ? `${unreadInbound} new` : messageCount}
        </span>
      )}
    </Button>
  );
}

function MessageDialog({
  availability,
  assignmentId,
  leadId,
  leadName,
  open,
  onOpenChange,
}: {
  availability: ChannelAvailability;
  assignmentId: string;
  leadId: string;
  leadName: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const router = useRouter();
  const { channel, connected, setupStarted, sendable, reason } = availability;

  const [subject, setSubject] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [thread, setThread] = useState<ThreadMessage[] | null>(null);
  const [clientToken, setClientToken] = useState(() => crypto.randomUUID());

  const loadThread = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/customer/messaging/thread/${assignmentId}?channel=${channel}`,
        { cache: "no-store" }
      );
      if (!res.ok) return;
      const data = await res.json();
      setThread(data.messages ?? []);
    } catch {
      /* the thread is context, not the point — never block composing on it */
    }
  }, [assignmentId, channel]);

  useEffect(() => {
    if (open) void loadThread();
  }, [open, loadThread]);

  const setupHref = useMemo(() => {
    const back = encodeURIComponent(`/dashboard/leads/${leadId}`);
    return `/dashboard/settings/messaging?channel=${channel}&return=${back}`;
  }, [channel, leadId]);

  async function send() {
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/customer/messaging/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assignment_id: assignmentId,
          channel,
          subject: channel === "email" ? subject : undefined,
          body: bodyText,
          client_token: clientToken,
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        // ⚠️ The composed text is NOT cleared. Losing what somebody just wrote
        // because a request failed is the kind of small betrayal that stops a
        // feature being used.
        setError(data.error ?? "The message could not be sent.");
        return;
      }

      setBodyText("");
      setSubject("");
      setClientToken(crypto.randomUUID());
      await loadThread();
      router.refresh();
    } catch {
      setError("We could not reach the server. Your message has been kept below.");
    } finally {
      setSending(false);
    }
  }

  const canSend = bodyText.trim().length > 0 && (channel !== "email" || subject.trim().length > 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {connected && sendable
              ? `Send ${CHANNEL_LABEL[channel]} to ${leadName}`
              : `${CHANNEL_LABEL[channel] === "email" ? "Email" : "WhatsApp"} for ${leadName}`}
          </DialogTitle>
          {connected && sendable && (
            <DialogDescription>
              This goes out from your own {channel === "email" ? "domain" : "WhatsApp number"}.
              Replies come back here.
            </DialogDescription>
          )}
        </DialogHeader>

        {thread && thread.length > 0 && <ThreadView messages={thread} />}

        {/* STATE: the lead is settled. */}
        {!sendable && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
            <div className="flex gap-2">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <p>{reason}</p>
            </div>
          </div>
        )}

        {/* STATE: not connected, or half-way through. */}
        {sendable && !connected && (
          <div className="space-y-4">
            <div className="rounded-md border bg-muted/40 p-4">
              <p className="text-sm font-medium">
                {setupStarted
                  ? `Your ${CHANNEL_LABEL[channel]} setup isn't finished yet.`
                  : `${CHANNEL_LABEL[channel] === "email" ? "Email" : "WhatsApp"} isn't set up yet.`}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {setupStarted
                  ? "You've started — we just need the last steps finishing before you can send."
                  : SETUP_BLURB[channel].what}
              </p>

              {!setupStarted && (
                <>
                  <p className="mt-3 text-sm font-medium">What you'll need</p>
                  <ul className="mt-1 space-y-1 text-sm text-muted-foreground">
                    {SETUP_BLURB[channel].needs.map((n) => (
                      <li key={n} className="flex gap-2">
                        <span aria-hidden>•</span>
                        <span>{n}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </div>
        )}

        {/* STATE: ready to compose. */}
        {sendable && connected && (
          <div className="space-y-3">
            {channel === "email" && (
              <div className="space-y-1">
                <label htmlFor="msg-subject" className="text-sm font-medium">
                  Subject
                </label>
                <input
                  id="msg-subject"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  disabled={sending}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  placeholder="About your property"
                />
              </div>
            )}
            <div className="space-y-1">
              <label htmlFor="msg-body" className="text-sm font-medium">
                Message
              </label>
              <textarea
                id="msg-body"
                value={bodyText}
                onChange={(e) => setBodyText(e.target.value)}
                disabled={sending}
                rows={8}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                placeholder={`Hi ${leadName.split(" ")[0] ?? ""}, …`}
              />
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            <div className="flex gap-2">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-medium">{error}</p>
                <p className="mt-1 text-xs">
                  Your message is still here — nothing was lost.
                </p>
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={sending}>
            Cancel
          </Button>

          {sendable && !connected && (
            <Button onClick={() => router.push(setupHref)}>
              {setupStarted ? "Continue setup" : "Begin setup"}
              <ExternalLink className="ml-2 h-4 w-4" />
            </Button>
          )}

          {sendable && connected && (
            <Button onClick={send} disabled={!canSend || sending}>
              {sending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {sending ? "Sending…" : "Send"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ThreadView({ messages }: { messages: ThreadMessage[] }) {
  return (
    <div className="max-h-64 space-y-3 overflow-y-auto rounded-md border bg-muted/20 p-3">
      {messages.map((m) => (
        <div
          key={m.id}
          className={m.direction === "outbound" ? "text-right" : "text-left"}
        >
          <div
            className={
              m.direction === "outbound"
                ? "inline-block max-w-[85%] rounded-lg bg-primary/10 px-3 py-2 text-left text-sm"
                : "inline-block max-w-[85%] rounded-lg bg-background px-3 py-2 text-sm shadow-sm"
            }
          >
            {m.subject && <p className="font-medium">{m.subject}</p>}
            <p className="whitespace-pre-wrap">{m.body_text}</p>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {statusLabel(m)} · {formatWhen(m.created_at)}
            {m.first_opened_at && (
              // §11's discipline about viewed_at, on the screen rather than only
              // in the docs: an open is not a fact.
              <span title="Approximate — some mail apps pre-load images."> ·  approx.</span>
            )}
          </p>
        </div>
      ))}
    </div>
  );
}
