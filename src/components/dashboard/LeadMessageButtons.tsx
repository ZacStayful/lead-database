"use client";

/**
 * "Send email" and "Send WhatsApp" on a lead, and the composer behind them (§40).
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
import {
  Mail, MessageCircle, Loader2, AlertCircle, ExternalLink, Sparkles, PlayCircle,
} from "lucide-react";
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
import { TIMELINES_SETUP_VIDEO_URL } from "@/lib/messaging/timelines";
import { handoffDigits, whatsappHandoffLink } from "@/lib/messaging/handoff";

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
  leadPhone,
  channels,
}: {
  assignmentId: string;
  leadId: string;
  leadName: string;
  /** The lead's stored phone, for the §40.15 hand-off. Free text from Monday. */
  leadPhone?: string | null;
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
          leadPhone={leadPhone}
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
  leadPhone,
  open,
  onOpenChange,
}: {
  availability: ChannelAvailability;
  assignmentId: string;
  leadId: string;
  leadName: string;
  leadPhone?: string | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const router = useRouter();
  const { channel, connected, setupStarted, sendable, reason, quietUntil } =
    availability;

  const [subject, setSubject] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [thread, setThread] = useState<ThreadMessage[] | null>(null);
  const [clientToken, setClientToken] = useState(() => crypto.randomUUID());
  const [drafting, setDrafting] = useState(false);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [draftNote, setDraftNote] = useState<string | null>(null);

  /**
   * §40.15 — the free path out of the unconnected modal. Off until they ask for
   * it, because Begin setup is still the better answer and offering both at
   * once would bury it.
   */
  const [handoffMode, setHandoffMode] = useState(false);

  // Whether a hand-off is possible AT ALL for this lead: a landline or a
  // placeholder has nothing to open. Independent of what they have typed.
  const handoffPossible =
    channel === "whatsapp" && handoffDigits(leadPhone) !== null;

  // The link for what is currently in the box. Null while it is empty or over
  // the ceiling, which is what disables the action.
  const handoffLink = handoffMode ? whatsappHandoffLink(leadPhone, bodyText) : null;

  /**
   * Record the tap as whatsapp_click and forget it.
   *
   * ⚠️ NOT message_sent — 0117's rule, and the reason this goes through the
   * ordinary client-events door rather than the messaging routes: the browser is
   * the only witness, nothing comes back, and a customer able to POST
   * message_sent could shield every lead they hold. That route already carries
   * the ownership check, the 60-second dedupe and the hourly cap, so a
   * double-tap costs nothing and a lost event never interrupts the send.
   */
  function recordHandoff() {
    void fetch("/api/customer/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        assignment_id: assignmentId,
        event_type: "whatsapp_click",
      }),
    }).catch(() => {});
  }

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

  async function generateDraft() {
    // ⚠️ Never silently overwrite something the operator has typed. This file
    // already states the principle for the failed-send case, and it applies
    // just as much to a helpful button that eats a half-written message.
    if (bodyText.trim().length > 0) {
      const ok = window.confirm(
        "Replace what you have written with a generated draft?"
      );
      if (!ok) return;
    }

    setDrafting(true);
    setDraftNote(null);
    setError(null);
    try {
      const res = await fetch("/api/customer/messaging/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignment_id: assignmentId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // A failed draft is not a failed action — it is a blank page, which is
        // where they started. Muted, never the red error block.
        setDraftNote(data.error ?? "We could not write a draft just now.");
        return;
      }
      setBodyText(data.text ?? "");
      setDraftId(data.draft_id ?? null);
      setDraftNote(
        data.had_figures
          ? "Written from this property's analysis. Read it before you send."
          : "This property has no analysis, so the draft quotes no figures. Read it before you send."
      );
    } catch {
      setDraftNote("We could not reach the server. Write the message yourself.");
    } finally {
      setDrafting(false);
    }
  }

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
          draft_id: draftId,
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
      setDraftId(null);
      setDraftNote(null);
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

        {/* STATE: inside the composer, but outside sending hours (§40.12).
             Said BEFORE they write, not after — being told at the end that
             three hundred characters cannot go anywhere is the version of this
             that stops the feature being used. It is a notice rather than a
             disabled button: the send route is the thing that refuses, and one
             definition of the rule is enough. */}
        {sendable && connected && quietUntil && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
            <div className="flex gap-2">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <p>
                It is outside the hours we message landlords. You can write this
                now and send it from {quietUntil}.
              </p>
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

            {/*
              §40.15 — the third way out of this modal.

              Until now it ended in Cancel or Begin setup, and for the twenty of
              twenty-one active customers with no TimelinesAI workspace that
              meant nothing was ever sent. This offers the free floor instead: a
              wa.me link that opens their OWN WhatsApp with the message already
              written.

              Deliberately stated with what it COSTS them, not just what it
              gives. Overselling the free path would lose the upgrade, and §19.7
              is the rule that copy is part of the mechanism.
            */}
            {channel === "whatsapp" && handoffPossible && !handoffMode && (
              <div className="rounded-md border p-4">
                <p className="text-sm font-medium">Or send it from your phone now</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Free, and nothing to set up. We will write the message here and
                  open it in your own WhatsApp, ready to send.
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  Replies go to your phone rather than back into this lead, and
                  you will not see delivery or read receipts here.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => setHandoffMode(true)}
                >
                  <MessageCircle className="mr-2 h-4 w-4" />
                  Write it here
                </Button>
              </div>
            )}
          </div>
        )}

        {/* STATE: ready to compose — connected, or handing off to their phone. */}
        {sendable && (connected || handoffMode) && (
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
              <div className="flex items-center justify-between gap-2">
                <label htmlFor="msg-body" className="text-sm font-medium">
                  Message
                </label>
                {channel === "whatsapp" && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={generateDraft}
                    disabled={drafting || sending}
                  >
                    {drafting ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Sparkles className="mr-2 h-4 w-4" />
                    )}
                    {bodyText.trim() ? "Generate another" : "Generate a draft"}
                  </Button>
                )}
              </div>
              <textarea
                id="msg-body"
                value={bodyText}
                onChange={(e) => setBodyText(e.target.value)}
                disabled={sending}
                rows={8}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                placeholder={`Hi ${leadName.split(" ")[0] ?? ""}, …`}
              />
              {draftNote && (
                <p className="text-xs text-muted-foreground">{draftNote}</p>
              )}
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

          {sendable && !connected && channel === "whatsapp" && !handoffMode && (
            <Button variant="ghost" asChild>
              <a href={TIMELINES_SETUP_VIDEO_URL} target="_blank" rel="noreferrer">
                <PlayCircle className="mr-2 h-4 w-4" />
                Watch the setup
              </a>
            </Button>
          )}

          {/*
            Begin setup stays, and stays PRIMARY until they have chosen the
            hand-off. Once they have, the thing they asked for becomes the
            primary action and this steps back to outline — the upsell is still
            on screen, it has just stopped competing with what they are doing.
          */}
          {sendable && !connected && (
            <Button
              variant={handoffMode ? "outline" : "default"}
              onClick={() => router.push(setupHref)}
            >
              {setupStarted ? "Continue setup" : "Begin setup"}
              <ExternalLink className="ml-2 h-4 w-4" />
            </Button>
          )}

          {/*
            ⚠️ AN ANCHOR, NOT A FETCH. The whole point is that the message leaves
            from THEIR WhatsApp and their number — nothing is sent from here, so
            there is nothing to await and no failure to report. The event is
            fired and forgotten alongside it.
          */}
          {sendable && !connected && handoffMode && (
            handoffLink ? (
              <Button asChild>
                <a
                  href={handoffLink}
                  target="_blank"
                  rel="noreferrer"
                  onClick={recordHandoff}
                >
                  <MessageCircle className="mr-2 h-4 w-4" />
                  Open WhatsApp
                </a>
              </Button>
            ) : (
              <Button
                disabled
                title={
                  bodyText.trim().length === 0
                    ? "Write a message first."
                    : "That message is too long to hand to WhatsApp."
                }
              >
                <MessageCircle className="mr-2 h-4 w-4" />
                Open WhatsApp
              </Button>
            )
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
