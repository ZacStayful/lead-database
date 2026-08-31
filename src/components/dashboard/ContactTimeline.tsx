"use client";

/**
 * The contact timeline (§42) — where this landlord sits in the five-attempt
 * plan, and the one thing to do about it now.
 *
 * All five rungs are shown at once, including the ones the scheduler has not
 * queued yet. Seeing what is LEFT is the point: an operator who can only see
 * today's task has no idea whether they are two approaches in or four.
 */

import { useState } from "react";
import { Check, Phone, Mail, MessageCircle, Circle, Dot } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/utils";
import { recordLeadEvent } from "@/lib/contact/leadEvents";
import { whatsappHandoffLink } from "@/lib/messaging/handoff";
import {
  AFTER_LAST_ATTEMPT,
  channelLabel,
  eventTypeForChannel,
  type ContactChannel,
} from "@/lib/contact/contactStrategy";
import type {
  ContactTimelineView,
  TimelineAttempt,
} from "@/lib/contact/contactPlan";

const ICON: Record<ContactChannel, typeof Phone> = {
  call: Phone,
  whatsapp: MessageCircle,
  email: Mail,
};

export function ContactTimeline({
  view,
  leadId,
  assignmentId,
  phone,
  email,
  className,
}: {
  view: ContactTimelineView;
  leadId: string;
  assignmentId: string;
  phone: string | null;
  email: string | null;
  className?: string;
}) {
  const [state, setState] = useState(view);
  const [busy, setBusy] = useState(false);
  // A call is the one rung whose outcome we cannot infer from the click: a
  // tel_click says they dialled, never that anybody answered.
  const [askOutcome, setAskOutcome] = useState(false);

  const current = state.current;

  async function complete(channel: ContactChannel, callOutcome?: string) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/customer/leads/${leadId}/attempt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel,
          call_outcome: callOutcome ?? null,
        }),
      });
      if (res.ok) {
        // Optimistic: mark the rung done locally so the operator sees it move.
        setState((s) => advanceLocally(s, callOutcome === "answered"));
        setAskOutcome(false);
      }
    } finally {
      setBusy(false);
    }
  }

  /**
   * The click IS the completion. Fire the telemetry — which is what the server
   * joins to the attempt — then, for a call, ask the one thing the click cannot
   * tell us. For the other two channels the click alone is the whole record, so
   * the rung is marked done straight away.
   */
  function handleAction(attempt: TimelineAttempt) {
    recordLeadEvent(assignmentId, eventTypeForChannel(attempt.channel));
    if (attempt.channel === "call") {
      setAskOutcome(true);
      return;
    }
    setState((s) => advanceLocally(s, false));
  }

  const waLink = phone ? whatsappHandoffLink(phone, "") : null;

  return (
    <div className={className}>
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-sm font-medium">Contact timeline</h3>
        <span className="text-xs text-muted-foreground">
          {state.completed} of {state.total} attempts
        </span>
      </div>

      <ol className="space-y-0">
        {state.attempts.map((a, i) => {
          const Icon = ICON[a.channel];
          const isLast = i === state.attempts.length - 1;
          const done = a.state === "done";
          const due = a.state === "due";
          return (
            <li key={a.number} className="relative flex gap-3 pb-4">
              {!isLast && (
                <span
                  aria-hidden
                  className="absolute left-[11px] top-6 h-full w-px bg-border"
                />
              )}
              <span
                className={[
                  "relative z-10 mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border",
                  done
                    ? "border-transparent bg-brand text-white"
                    : due
                      ? "border-brand bg-background text-brand"
                      : "border-border bg-background text-muted-foreground",
                ].join(" ")}
              >
                {done ? (
                  <Check className="h-3.5 w-3.5" />
                ) : due ? (
                  <Dot className="h-5 w-5" />
                ) : (
                  <Circle className="h-2 w-2" />
                )}
              </span>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                  <span className={done ? "text-muted-foreground" : "font-medium"}>
                    {a.number} · {channelLabel(a.channel)}
                  </span>
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <Icon className="h-3 w-3" />
                    {done && a.doneAt
                      ? formatDate(a.doneAt)
                      : due
                        ? "due now"
                        : a.state === "skipped"
                          ? "skipped"
                          : a.dueAt
                            ? formatDate(a.dueAt)
                            : "not scheduled yet"}
                    {a.callOutcome ? ` · ${a.callOutcome.replace("_", " ")}` : ""}
                  </span>
                </div>

                {!done && a.state !== "skipped" && (
                  <p className="mt-1 text-sm text-muted-foreground">{a.objective}</p>
                )}

                {due && !state.stopped && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {a.channel === "call" && phone && (
                      <Button size="sm" asChild onClick={() => handleAction(a)}>
                        <a href={`tel:${phone}`}>
                          <Phone className="h-4 w-4" />
                          Call
                        </a>
                      </Button>
                    )}
                    {a.channel === "whatsapp" && waLink && (
                      <Button size="sm" asChild onClick={() => handleAction(a)}>
                        <a href={waLink} target="_blank" rel="noopener noreferrer">
                          <MessageCircle className="h-4 w-4" />
                          Open WhatsApp
                        </a>
                      </Button>
                    )}
                    {a.channel === "email" && email && (
                      <Button size="sm" asChild onClick={() => handleAction(a)}>
                        <a href={`mailto:${email}`}>
                          <Mail className="h-4 w-4" />
                          Open email
                        </a>
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => complete(a.channel)}
                    >
                      I did this another way
                    </Button>
                  </div>
                )}

                {/* A call is the one rung that branches: attempt 2 is defined as
                    "same day, ONLY if the call went unanswered", and an answered
                    call ends the plan rather than advancing it. */}
                {due && askOutcome && a.channel === "call" && (
                  <div className="mt-2 rounded-md border-[0.5px] border-border bg-muted/40 p-3">
                    <p className="mb-2 text-sm">Did they answer?</p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() => complete("call", "answered")}
                      >
                        They answered
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => complete("call", "no_answer")}
                      >
                        No answer
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => complete("call", "voicemail")}
                      >
                        Left a voicemail
                      </Button>
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">
                      If they answered we stop the plan here — you are in
                      conversation, and nothing else should chase them.
                    </p>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {state.stopped && (
        <p className="text-sm text-muted-foreground">
          Plan stopped — you are in conversation with this landlord.
        </p>
      )}
      {!state.stopped && state.finished && (
        <p className="text-sm text-muted-foreground">{AFTER_LAST_ATTEMPT}</p>
      )}
    </div>
  );
}

/** Mark the current rung done and light the next one, without a round trip. */
function advanceLocally(
  s: ContactTimelineView,
  stopped: boolean
): ContactTimelineView {
  const attempts = s.attempts.map((a) =>
    a.state === "due"
      ? { ...a, state: "done" as const, doneAt: new Date().toISOString() }
      : a
  );
  const next = stopped
    ? null
    : (attempts.find((a) => a.state === "overdue") ?? null);
  if (next) next.state = "due";
  const completed = attempts.filter((a) => a.state === "done").length;
  return {
    ...s,
    attempts,
    completed,
    current: next,
    finished: completed >= s.total,
    stopped: stopped || s.stopped,
  };
}
