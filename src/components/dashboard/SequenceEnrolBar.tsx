"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { CheckSquare, Square, Send } from "lucide-react";

/**
 * Put a selection of leads into a follow-up sequence (§40.13).
 *
 * ⚠️ THE CONFIRMATION MUST STATE HOW LONG THE BACKLOG WILL TAKE, and that is
 * the whole reason this is an expanded inline panel rather than a two-button
 * swap. `daily_send_cap` defaults to 40; a three-step sequence over two hundred
 * leads is six hundred messages, which is fifteen days. An operator who enrols
 * their whole book expecting it out this afternoon has been misled by our
 * silence — and the first they would hear of it is a landlord ringing about a
 * message sent a fortnight late.
 *
 * The shape follows AnnouncementSendPanel, for the reason recorded there: "a
 * swap asks 'are you sure' with no new information, and the count and the
 * audience are exactly the two things [somebody] can have wrong without
 * noticing."
 */

interface SequenceOption {
  id: string;
  name: string;
  lead_type: string;
  is_active: boolean;
  message_sequence_steps: { step_number: number }[];
}

export function SequenceEnrolBar({
  selectedIds,
  totalVisible,
  onSelectAll,
  onClear,
}: {
  selectedIds: string[];
  totalVisible: number;
  onSelectAll: () => void;
  onClear: () => void;
}) {
  const router = useRouter();
  const [sequences, setSequences] = useState<SequenceOption[] | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [chosen, setChosen] = useState<string>("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/customer/messaging/sequences")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("failed"))))
      .then((d) => {
        if (!live) return;
        const list = (d.sequences ?? []) as SequenceOption[];
        setSequences(list.filter((s) => s.is_active && s.message_sequence_steps.length > 0));
        setEnabled(d.sequences_enabled !== false);
      })
      .catch(() => {
        if (live) setSequences([]);
      });
    return () => {
      live = false;
    };
  }, []);

  // Any change of selection voids the confirmation. It named a count, and a
  // count that has moved is a different question.
  useEffect(() => setConfirming(false), [selectedIds.length, chosen]);

  const sequence = (sequences ?? []).find((s) => s.id === chosen) ?? null;
  const steps = sequence?.message_sequence_steps.length ?? 0;
  const count = selectedIds.length;

  async function enrol() {
    if (!sequence) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/customer/messaging/sequences/${sequence.id}/enrol`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignment_ids: selectedIds }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Could not add those leads.");
        return;
      }
      const parts = [`${data.enrolled} lead${data.enrolled === 1 ? "" : "s"} added`];
      if (data.alreadyEnrolled > 0) {
        parts.push(`${data.alreadyEnrolled} already in a sequence`);
      }
      if (data.skipped > 0) parts.push(`${data.skipped} skipped`);
      const days = data.days_to_clear ?? 0;
      setDone(
        `${parts.join(", ")}.` +
          (days > 1
            ? ` At your limit of ${data.daily_send_cap} messages a day this will take about ${days} days to work through.`
            : " The first messages are written this evening and go out tomorrow morning.")
      );
      setConfirming(false);
      onClear();
      router.refresh();
    } catch {
      setError("We could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  const allSelected = count > 0 && count === totalVisible;

  return (
    <div className="sticky top-2 z-10 rounded-lg border-[0.5px] border-brand/40 bg-card p-3 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={allSelected ? onClear : onSelectAll}
          className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          {allSelected ? (
            <CheckSquare className="h-4 w-4" />
          ) : (
            <Square className="h-4 w-4" />
          )}
          {allSelected ? "Clear" : `Select all ${totalVisible}`}
        </button>

        <span className="text-sm">
          <span className="font-medium">{count}</span> selected
        </span>

        {sequences === null ? (
          <span className="text-sm text-muted-foreground">Loading sequences…</span>
        ) : sequences.length === 0 ? (
          <span className="text-sm text-muted-foreground">
            You have no follow-up sequences yet.{" "}
            <Link href="/dashboard/follow-ups" className="underline">
              Build one
            </Link>
            .
          </span>
        ) : (
          <>
            <select
              value={chosen}
              onChange={(e) => setChosen(e.target.value)}
              className="h-9 rounded-md border-[0.5px] border-border bg-background px-2 text-sm"
            >
              <option value="">Choose a sequence…</option>
              {sequences.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.message_sequence_steps.length} message
                  {s.message_sequence_steps.length === 1 ? "" : "s"})
                </option>
              ))}
            </select>
            <Button
              size="sm"
              disabled={!sequence || count === 0 || busy}
              onClick={() => setConfirming(true)}
            >
              <Send className="mr-1.5 h-3.5 w-3.5" />
              Add to sequence
            </Button>
          </>
        )}
      </div>

      {!enabled && (
        <p className="mt-2 text-xs text-muted-foreground">
          Follow-up sending is not switched on for your account yet. You can set
          sequences up now — nothing will be sent until it is.
        </p>
      )}

      {confirming && sequence && (
        <div className="mt-3 space-y-2 rounded-md border-[0.5px] border-border bg-muted/40 p-3 text-sm">
          <p>
            <span className="font-medium">{count}</span> lead
            {count === 1 ? "" : "s"} will join <span className="font-medium">{sequence.name}</span>,
            which sends <span className="font-medium">{steps}</span> message
            {steps === 1 ? "" : "s"} to each of them
            {count > 1 ? ` — up to ${count * steps} messages in total` : ""}.
          </p>
          <p className="text-muted-foreground">
            Each one is written for that landlord the evening before it goes and
            waits in your review list overnight, so you can change or cancel any
            of them. Nothing is sent outside 9am–8pm, and a reply stops the rest.
          </p>
          <div className="flex gap-2 pt-1">
            <Button size="sm" onClick={enrol} disabled={busy}>
              {busy ? "Adding…" : `Add ${count} lead${count === 1 ? "" : "s"}`}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Not yet
            </Button>
          </div>
        </div>
      )}

      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      {done && <p className="mt-2 text-sm text-muted-foreground">{done}</p>}
    </div>
  );
}
