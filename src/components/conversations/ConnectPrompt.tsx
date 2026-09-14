"use client";

/**
 * "Connect WhatsApp" in the inbox (§56.7). The inbox lists every lead the
 * operator has approached, but a reply, a delivery tick or a follow-up
 * sequence only exists for a CONNECTED workspace — and nobody is connected
 * today. Left to the composer alone, the guidance only appears once a lead
 * is selected, which is the "nobody could find it" failure §51.10 measured.
 *
 * Two variants, one copy source. `full` replaces the empty state; `card` is
 * a dismissable strip above a list where every row is a click and nothing
 * has ever come back. Every sentence about what setup needs comes from
 * SETUP_BLURB and the two TimelinesAI constants — never restated here, so the
 * inbox and the composer cannot drift (§40.11's rule for the referral link).
 *
 * The free floor is stated too (§40.15): the wa.me hand-off works with
 * nothing set up, and overselling the connection would lose the upgrade.
 */
import { useEffect, useState } from "react";
import { ExternalLink, MessageCircle, PlayCircle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SETUP_BLURB, setupHref } from "./ComposerStates";
import { TIMELINES_SETUP_VIDEO_URL, TIMELINES_SIGNUP_URL } from "@/lib/messaging/timelines";

const RETURN_TO = "/dashboard/conversations";
const DISMISS_KEY = "inbox-connect-card-dismissed";

/** What a connected workspace adds over the hand-off — the reasons to bother. */
const GIVES = [
  "Landlord replies land in this inbox, on the lead they belong to",
  "Delivered and read ticks on every message you send",
  "Follow-up sequences that send themselves from your own number",
] as const;

export function ConnectPrompt({
  variant,
  setupStarted,
  emailEnabled,
}: {
  variant: "full" | "card";
  /** A connection row exists but is not `connected` — "Continue" rather than "Begin". */
  setupStarted: boolean;
  emailEnabled: boolean;
}) {
  const [dismissed, setDismissed] = useState(variant === "card");

  useEffect(() => {
    if (variant !== "card") return;
    try {
      setDismissed(sessionStorage.getItem(DISMISS_KEY) === "1");
    } catch {
      setDismissed(false);
    }
  }, [variant]);

  function dismiss() {
    setDismissed(true);
    try {
      sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // Per-tab convenience only; nothing depends on it.
    }
  }

  const cta = (
    <div className="mt-3 flex flex-wrap gap-2">
      <Button size="sm" asChild>
        <a href={setupHref("whatsapp", RETURN_TO)}>
          {setupStarted ? "Continue WhatsApp setup" : "Connect WhatsApp"}
          <ExternalLink className="ml-2 h-4 w-4" />
        </a>
      </Button>
      <Button size="sm" variant="ghost" asChild>
        <a href={TIMELINES_SETUP_VIDEO_URL} target="_blank" rel="noreferrer">
          <PlayCircle className="mr-2 h-4 w-4" />
          Watch the setup
        </a>
      </Button>
    </div>
  );

  if (variant === "card") {
    if (dismissed) return null;
    return (
      <div className="relative m-3 rounded-lg border border-line bg-page p-3 pr-9 text-sm">
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          className="absolute right-2 top-2 rounded p-1 text-ink-2 hover:text-ink"
        >
          <X className="h-4 w-4" />
        </button>
        <p className="font-medium">
          {setupStarted ? "Your WhatsApp setup isn't finished yet." : "Replies land here once WhatsApp is connected."}
        </p>
        <p className="mt-1 text-ink-2">
          {setupStarted
            ? "Finish the last steps and landlord replies, delivery ticks and follow-up sequences come into this inbox."
            : "Everything here so far is a message you sent from your own phone. Connect your number and the replies come back to the lead."}
        </p>
        {cta}
      </div>
    );
  }

  return (
    <div className="max-w-md">
      <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-brand-light text-brand-dark">
        <MessageCircle className="h-6 w-6" />
      </div>
      <p className="text-center font-display text-[22px] font-semibold">
        {setupStarted ? "Finish connecting WhatsApp" : "Connect WhatsApp to bring replies in here"}
      </p>
      <p className="mt-1.5 text-center text-ink-2">{SETUP_BLURB.whatsapp.what}</p>

      <div className="mt-5 rounded-xl border border-line bg-white p-4 text-left text-sm">
        <p className="font-medium">What connecting gives you</p>
        <ul className="mt-1 space-y-1 text-ink-2">
          {GIVES.map((g) => (
            <li key={g} className="flex gap-2">
              <span aria-hidden>•</span>
              <span>{g}</span>
            </li>
          ))}
        </ul>
        {!setupStarted && (
          <>
            <p className="mt-4 font-medium">What you&rsquo;ll need</p>
            <ul className="mt-1 space-y-1 text-ink-2">
              {SETUP_BLURB.whatsapp.needs.map((n) => (
                <li key={n} className="flex gap-2">
                  <span aria-hidden>•</span>
                  <span>{n}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-ink-2">
              No TimelinesAI account yet?{" "}
              <a href={TIMELINES_SIGNUP_URL} target="_blank" rel="noreferrer" className="underline">
                Create one
              </a>
              , then come back and paste the token.
            </p>
          </>
        )}
        {cta}
        {emailEnabled && (
          <p className="mt-3 text-xs text-ink-2">
            Prefer email?{" "}
            <a href={setupHref("email", RETURN_TO)} className="underline">
              Send from your own domain
            </a>{" "}
            — {SETUP_BLURB.email.what.toLowerCase()}
          </p>
        )}
      </div>

      <p className="mt-4 text-center text-xs text-ink-2">
        Nothing to set up right now? Open any lead and write the message there — we hand it to your own WhatsApp
        ready to send. Replies go to your phone rather than back here.
      </p>
    </div>
  );
}
