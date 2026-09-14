"use client";

/**
 * The composer under a thread (§56.7): channel chips (WhatsApp / Email —
 * never SMS, there is no customer→landlord SMS anywhere), the hint from
 * ChannelAvailability, a textarea, Snippets, Generate a draft, Send.
 *
 * With no connected channel it renders the same not-connected state the old
 * dialog did, and the §40.15 hand-off: write here, open in the operator's own
 * WhatsApp. A tap on that is a whatsapp_click, never a send.
 */
import { useState } from "react";
import { Loader2, MessageCircle, Mail, Send, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { handoffDigits, whatsappHandoffLink } from "@/lib/messaging/handoff";
import type { ChannelAvailability, MessageChannel } from "@/lib/messaging/types";
import { cn } from "@/lib/utils";
import { NotSendableNotice, QuietHoursNotice, SendFailedNotice, SetupPrompt } from "./ComposerStates";
import { SnippetPicker } from "./SnippetPicker";
import { useComposer } from "./useComposer";

export function Composer({
  assignmentId,
  leadId,
  leadName,
  leadPhone,
  channels,
}: {
  assignmentId: string;
  leadId: string;
  leadName: string;
  leadPhone: string | null;
  channels: ChannelAvailability[];
}) {
  const [channel, setChannel] = useState<MessageChannel>(
    channels.find((c) => c.channel === "whatsapp")?.channel ?? channels[0]?.channel ?? "whatsapp"
  );
  const availability = channels.find((c) => c.channel === channel) ?? null;
  return (
    <ComposerFor
      key={`${assignmentId}:${channel}`}
      assignmentId={assignmentId}
      leadId={leadId}
      leadName={leadName}
      leadPhone={leadPhone}
      channel={channel}
      availability={availability}
      chips={channels.map((c) => c.channel)}
      onChannel={setChannel}
    />
  );
}

function ComposerFor({
  assignmentId,
  leadId,
  leadName,
  leadPhone,
  channel,
  availability,
  chips,
  onChannel,
}: {
  assignmentId: string;
  leadId: string;
  leadName: string;
  leadPhone: string | null;
  channel: MessageChannel;
  availability: ChannelAvailability | null;
  chips: MessageChannel[];
  onChannel: (c: MessageChannel) => void;
}) {
  const c = useComposer(assignmentId, channel);
  const [handoffMode, setHandoffMode] = useState(false);
  const [textarea, setTextarea] = useState<HTMLTextAreaElement | null>(null);

  // The platform switch is off for this customer: no channel rows at all.
  // The hand-off is still theirs (§40.15), so the composer becomes it.
  const switchedOff = chips.length === 0;
  const connected = availability?.connected ?? false;
  const sendable = availability?.sendable ?? true;
  const handoffPossible = channel === "whatsapp" && handoffDigits(leadPhone) !== null;
  const handing = (switchedOff || (!connected && handoffMode)) && handoffPossible;
  const handoffLink = handing ? whatsappHandoffLink(leadPhone, c.bodyText) : null;

  /**
   * Record the tap as whatsapp_click and forget it. ⚠️ NOT message_sent —
   * 0117's rule: a customer able to POST message_sent could shield every lead
   * they hold. The events route carries the ownership check, the 60-second
   * dedupe and the hourly cap, so a double-tap costs nothing.
   */
  function recordHandoff() {
    void fetch("/api/customer/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignment_id: assignmentId, event_type: "whatsapp_click" }),
    }).catch(() => {});
  }

  const firstName = leadName.split(" ")[0] ?? "";
  const hint = switchedOff
    ? handoffPossible
      ? "Opens in your own WhatsApp"
      : null
    : !sendable
      ? null
      : connected
        ? availability?.quietUntil
          ? `Outside sending hours · from ${availability.quietUntil}`
          : channel === "whatsapp"
            ? "Sends from your connected WhatsApp"
            : "Sends from your connected domain"
        : handing
          ? "Opens in your own WhatsApp"
          : null;

  return (
    <div className="border-t border-line bg-white px-3 py-2.5">
      {!switchedOff && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {chips.map((ch) => (
            <button
              key={ch}
              type="button"
              onClick={() => onChannel(ch)}
              className={cn(
                "inline-flex h-[30px] items-center gap-1.5 rounded-full border px-2.5 text-[13px] font-semibold",
                ch === channel ? "border-brand bg-brand-light text-brand-dark" : "border-control bg-white text-ink-3"
              )}
            >
              {ch === "whatsapp" ? <MessageCircle className="h-[13px] w-[13px]" /> : <Mail className="h-[13px] w-[13px]" />}
              {ch === "whatsapp" ? "WhatsApp" : "Email"}
            </button>
          ))}
          {hint && <span className="ml-auto self-center text-xs text-ink-2">{hint}</span>}
        </div>
      )}
      {switchedOff && hint && <div className="mb-2 text-xs text-ink-2">{hint}</div>}

      {!switchedOff && !sendable && <NotSendableNotice reason={availability?.reason ?? null} />}

      {!switchedOff && sendable && connected && availability?.quietUntil && (
        <div className="mb-2">
          <QuietHoursNotice until={availability.quietUntil} />
        </div>
      )}

      {!switchedOff && sendable && !connected && !handoffMode && (
        <SetupPrompt
          channel={channel}
          setupStarted={availability?.setupStarted ?? false}
          leadId={leadId}
          handoffOffered={handoffPossible}
          onHandoff={() => setHandoffMode(true)}
        />
      )}

      {switchedOff && !handoffPossible && (
        <p className="text-sm text-ink-2">
          This lead has no mobile number to message. Ring or email them from the panel.
        </p>
      )}

      {(handing || (!switchedOff && sendable && connected)) && (
        <div className="space-y-2">
          {channel === "email" && connected && (
            <input
              value={c.subject}
              onChange={(e) => c.setSubject(e.target.value)}
              disabled={c.sending}
              placeholder="Subject"
              className="w-full rounded-[10px] border border-control px-3 py-2 text-[15px] outline-none focus:border-brand"
            />
          )}
          <div className="flex items-end gap-2">
            <textarea
              ref={setTextarea}
              rows={2}
              value={c.bodyText}
              onChange={(e) => c.setBodyText(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && connected && c.canSend && !c.sending) {
                  e.preventDefault();
                  void c.send();
                }
              }}
              disabled={c.sending}
              placeholder={`Reply to ${firstName} on ${channel === "whatsapp" ? "WhatsApp" : "Email"}…`}
              className="min-h-[52px] flex-1 resize-none rounded-[10px] border border-control px-3 py-2.5 text-[15px] leading-[1.4] outline-none focus:border-brand"
            />
            <SnippetPicker channel={channel} onPick={(body) => c.insertText(body, textarea?.selectionStart ?? null)} />
            {handing ? (
              <Button
                asChild={Boolean(handoffLink)}
                disabled={!handoffLink}
                className="h-10 rounded-[10px] bg-brand px-4 font-semibold hover:bg-brand-dark"
                title={
                  handoffLink
                    ? undefined
                    : c.bodyText.trim().length === 0
                      ? "Write a message first."
                      : "That message is too long to hand to WhatsApp."
                }
              >
                {handoffLink ? (
                  // ⚠️ AN ANCHOR, NOT A FETCH: the message leaves from THEIR
                  // WhatsApp and their number, so there is nothing to await.
                  <a href={handoffLink} target="_blank" rel="noreferrer" onClick={recordHandoff}>
                    <MessageCircle className="mr-2 h-4 w-4" />
                    Open WhatsApp
                  </a>
                ) : (
                  <span>
                    <MessageCircle className="mr-2 inline h-4 w-4" />
                    Open WhatsApp
                  </span>
                )}
              </Button>
            ) : (
              <Button
                onClick={() => void c.send()}
                disabled={!c.canSend || c.sending}
                className="h-10 rounded-[10px] bg-brand px-4 font-semibold hover:bg-brand-dark"
              >
                {c.sending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {c.sending ? "Sending…" : "Send"}
                {!c.sending && <Send className="ml-2 h-4 w-4" />}
              </Button>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            {channel === "whatsapp" && !switchedOff ? (
              <button
                type="button"
                onClick={() => void c.generateDraft()}
                disabled={c.drafting || c.sending}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-brand hover:text-brand-dark disabled:opacity-60"
              >
                {c.drafting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                {c.bodyText.trim() ? "Generate another" : "Generate a draft"}
              </button>
            ) : (
              <span />
            )}
            {c.draftNote && <span className="text-xs text-ink-2">{c.draftNote}</span>}
          </div>
          {c.error && <SendFailedNotice error={c.error} />}
        </div>
      )}
    </div>
  );
}
