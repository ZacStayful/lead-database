"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Clock, Pencil, X, Ban } from "lucide-react";

/**
 * What is about to be sent, and to whom (§40.13).
 *
 * ⚠️ THIS SCREEN IS THE CONSENT. Every message here goes out on its own, from
 * the operator's own WhatsApp number, to a member of the public — so the design
 * decision "drafted ahead, auto-sends unless cancelled" is only defensible if
 * there is somewhere to see it beforehand. Requiring approval instead would put
 * the feature back to one lead at a time, which is the problem it exists to
 * solve.
 *
 * Two verbs, deliberately separate. "Not this one" leaves the ladder running
 * and the next message arrives on its normal cadence; "stop chasing" ends it.
 * One button doing both would either lose somebody the whole sequence over a
 * wording they disliked, or — far worse — message a landlord again in three
 * days after the operator had decided to leave them alone.
 */

export interface QueuedDraft {
  id: string;
  run_id: string;
  assignment_id: string | null;
  sequence_name: string | null;
  step_number: number;
  body: string;
  send_after: string;
  edited: boolean;
  lead_name: string | null;
  address: string | null;
}

function whenLabel(iso: string): string {
  const at = new Date(iso);
  const now = new Date();
  if (at.getTime() <= now.getTime()) return "Sending shortly";
  const sameDay = at.toDateString() === now.toDateString();
  const time = at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return `Today at ${time}`;
  const tomorrow = new Date(now.getTime() + 86_400_000);
  if (at.toDateString() === tomorrow.toDateString()) return `Tomorrow at ${time}`;
  return `${at.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })} at ${time}`;
}

export function SequenceReviewQueue({ drafts }: { drafts: QueuedDraft[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(id: string, init: RequestInit) {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/customer/messaging/sequences/drafts/${id}`, init);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "That did not work.");
        return false;
      }
      router.refresh();
      return true;
    } catch {
      setError("We could not reach the server.");
      return false;
    } finally {
      setBusy(null);
    }
  }

  if (drafts.length === 0) {
    return (
      <div className="rounded-lg border-[0.5px] border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        Nothing waiting to go out. Messages appear here the evening before they
        send, so you can read or change them first.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error && <p className="text-sm text-destructive">{error}</p>}
      {drafts.map((d) => (
        <div key={d.id} className="rounded-lg border-[0.5px] border-border bg-card p-4">
          <div className="flex flex-wrap items-center gap-2">
            {d.assignment_id ? (
              <Link
                href={`/dashboard/leads/${d.assignment_id}`}
                className="font-medium hover:underline"
              >
                {d.lead_name ?? "Lead"}
              </Link>
            ) : (
              <span className="font-medium">{d.lead_name ?? "Lead"}</span>
            )}
            <Badge variant="outline">Message {d.step_number}</Badge>
            {d.sequence_name && (
              <span className="text-xs text-muted-foreground">{d.sequence_name}</span>
            )}
            <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock className="h-3.5 w-3.5" />
              {whenLabel(d.send_after)}
            </span>
          </div>

          {d.address && (
            <p className="mt-0.5 text-xs text-muted-foreground">{d.address}</p>
          )}

          {editing === d.id ? (
            <div className="mt-3 space-y-2">
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={4}
                className="w-full rounded-md border-[0.5px] border-border bg-background p-3 text-sm"
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={busy === d.id || !text.trim()}
                  onClick={async () => {
                    const ok = await act(d.id, {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ body: text }),
                    });
                    if (ok) setEditing(null);
                  }}
                >
                  Save
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <p className="mt-3 whitespace-pre-wrap rounded-md bg-muted/40 p-3 text-sm">
              {d.body}
            </p>
          )}

          {editing !== d.id && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setEditing(d.id);
                  setText(d.body);
                }}
              >
                <Pencil className="mr-1.5 h-3.5 w-3.5" />
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy === d.id}
                onClick={() =>
                  act(d.id, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ action: "cancel" }),
                  })
                }
              >
                <X className="mr-1.5 h-3.5 w-3.5" />
                Not this one
              </Button>

              {/* Arm-then-confirm, never a single click: stopping a sequence
                  cannot be undone from here, and it is a different intention
                  from skipping one message. */}
              {stopping === d.id ? (
                <span className="flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground">
                    Stop messaging {d.lead_name ?? "this landlord"} altogether?
                  </span>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={busy === d.id}
                    onClick={async () => {
                      await act(d.id, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ action: "stop" }),
                      });
                      setStopping(null);
                    }}
                  >
                    Stop
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setStopping(null)}>
                    Keep going
                  </Button>
                </span>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground"
                  onClick={() => setStopping(d.id)}
                >
                  <Ban className="mr-1.5 h-3.5 w-3.5" />
                  Stop chasing
                </Button>
              )}

              {d.edited && (
                <span className="ml-auto text-xs text-muted-foreground">Edited by you</span>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
