"use client";

/**
 * The composer's non-ready states, extracted from the old message dialog so
 * the inbox and the lead page render them identically (§56.7). Copy is the
 * dialog's, verbatim — §19.7's rule that copy is part of the mechanism.
 */
import { AlertCircle, ExternalLink, MessageCircle, PlayCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TIMELINES_SETUP_VIDEO_URL } from "@/lib/messaging/timelines";
import type { MessageChannel } from "@/lib/messaging/types";

export const CHANNEL_LABEL: Record<MessageChannel, string> = {
  email: "email",
  whatsapp: "WhatsApp",
};

/**
 * What the customer needs before this channel works, in their terms. Stated
 * BEFORE they invest any effort — the honest ordering, and the one thing that
 * makes the "Begin setup" decision an informed one.
 */
export const SETUP_BLURB: Record<MessageChannel, { what: string; needs: string[] }> = {
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

/** The messaging settings page for one channel, returning to `returnTo` when done. */
export function setupHref(channel: MessageChannel, returnTo: string): string {
  return `/dashboard/settings/messaging?channel=${channel}&return=${encodeURIComponent(returnTo)}`;
}

export function setupHrefFor(channel: MessageChannel, leadId: string): string {
  return setupHref(channel, `/dashboard/leads/${leadId}`);
}

function Amber({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
      <div className="flex gap-2">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
        <p>{children}</p>
      </div>
    </div>
  );
}

/** STATE: the lead is settled. */
export function NotSendableNotice({ reason }: { reason: string | null }) {
  return <Amber>{reason ?? "This lead cannot be messaged."}</Amber>;
}

/**
 * STATE: inside the composer, but outside sending hours (§40.12). Said
 * BEFORE they write, not after. A notice rather than a disabled button: the
 * send route is the thing that refuses, and one definition of the rule is
 * enough.
 */
export function QuietHoursNotice({ until }: { until: string }) {
  return (
    <Amber>
      It is outside the hours we message landlords. You can write this now and send it from {until}.
    </Amber>
  );
}

/** STATE: not connected, or half-way through. */
export function SetupPrompt({
  channel,
  setupStarted,
  leadId,
  handoffOffered,
  onHandoff,
}: {
  channel: MessageChannel;
  setupStarted: boolean;
  leadId: string;
  /** Whether the wa.me hand-off is possible at all for this lead. */
  handoffOffered: boolean;
  onHandoff: () => void;
}) {
  const noun = CHANNEL_LABEL[channel] === "email" ? "Email" : "WhatsApp";
  return (
    <div className="space-y-3">
      <div className="rounded-md border border-line bg-page p-3">
        <p className="text-sm font-medium">
          {setupStarted ? `Your ${CHANNEL_LABEL[channel]} setup isn't finished yet.` : `${noun} isn't set up yet.`}
        </p>
        <p className="mt-1 text-sm text-ink-2">
          {setupStarted
            ? "You've started — we just need the last steps finishing before you can send."
            : SETUP_BLURB[channel].what}
        </p>
        {!setupStarted && (
          <>
            <p className="mt-3 text-sm font-medium">What you&rsquo;ll need</p>
            <ul className="mt-1 space-y-1 text-sm text-ink-2">
              {SETUP_BLURB[channel].needs.map((n) => (
                <li key={n} className="flex gap-2">
                  <span aria-hidden>•</span>
                  <span>{n}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" asChild>
            <a href={setupHrefFor(channel, leadId)}>
              {setupStarted ? "Continue setup" : "Begin setup"}
              <ExternalLink className="ml-2 h-4 w-4" />
            </a>
          </Button>
          {channel === "whatsapp" && (
            <Button size="sm" variant="ghost" asChild>
              <a href={TIMELINES_SETUP_VIDEO_URL} target="_blank" rel="noreferrer">
                <PlayCircle className="mr-2 h-4 w-4" />
                Watch the setup
              </a>
            </Button>
          )}
        </div>
      </div>

      {/*
        §40.15 — the free floor: a wa.me link that opens their OWN WhatsApp
        with the message already written. Stated with what it COSTS them, not
        just what it gives — overselling the free path would lose the upgrade.
      */}
      {channel === "whatsapp" && handoffOffered && (
        <div className="rounded-md border border-line p-3">
          <p className="text-sm font-medium">Or send it from your phone now</p>
          <p className="mt-1 text-sm text-ink-2">
            Free, and nothing to set up. Write the message here and we open it in your own WhatsApp, ready to send.
          </p>
          <p className="mt-2 text-xs text-ink-2">
            Replies go to your phone rather than back into this lead, and you will not see delivery or read receipts here.
          </p>
          <Button type="button" variant="outline" size="sm" className="mt-3" onClick={onHandoff}>
            <MessageCircle className="mr-2 h-4 w-4" />
            Write it here
          </Button>
        </div>
      )}
    </div>
  );
}

export function SendFailedNotice({ error }: { error: string }) {
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
      <div className="flex gap-2">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <p className="font-medium">{error}</p>
          <p className="mt-1 text-xs">Your message is still here — nothing was lost.</p>
        </div>
      </div>
    </div>
  );
}
