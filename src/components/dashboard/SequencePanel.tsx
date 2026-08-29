"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Plus, Pencil, Archive } from "lucide-react";
import { SequenceBuilder, type SequenceView } from "./SequenceBuilder";

/**
 * The list of a customer's ladders, and the way in and out of the builder.
 *
 * ⚠️ ARCHIVING IS ARM-THEN-CONFIRM AND NAMES THE LIVE RUNS. It stops every lead
 * currently working through the sequence — which is correct, because leaving
 * them would keep messaging landlords from a sequence the operator believes
 * they have switched off — but that is a surprising amount to happen behind one
 * word, so the count is stated before the click.
 */
export function SequencePanel({
  sequences,
  hasBothProducts,
  hasBookingLink,
}: {
  sequences: SequenceView[];
  hasBothProducts: boolean;
  hasBookingLink: boolean;
}) {
  const router = useRouter();
  const [creating, setCreating] = useState(sequences.length === 0);
  const [editing, setEditing] = useState<string | null>(null);
  const [archiving, setArchiving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function archive(id: string) {
    setBusy(true);
    try {
      await fetch(`/api/customer/messaging/sequences/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archive: true }),
      });
      setArchiving(null);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {sequences.map((s) =>
        editing === s.id ? (
          <SequenceBuilder
            key={s.id}
            existing={s}
            hasBothProducts={hasBothProducts}
            hasBookingLink={hasBookingLink}
            onDone={() => setEditing(null)}
          />
        ) : (
          <div key={s.id} className="rounded-lg border-[0.5px] border-border bg-card p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{s.name}</span>
              {s.trigger === "on_assignment" && (
                <Badge variant="outline" className="border-transparent bg-brand/10 text-brand">
                  Automatic for new leads
                </Badge>
              )}
              {!s.is_active && <Badge variant="outline">Paused</Badge>}
              <span className="ml-auto text-xs text-muted-foreground">
                {s.message_sequence_steps.length} message
                {s.message_sequence_steps.length === 1 ? "" : "s"} ·{" "}
                {s.runs.active} lead{s.runs.active === 1 ? "" : "s"} in progress
              </span>
            </div>

            <ol className="mt-3 space-y-1 text-sm text-muted-foreground">
              {s.message_sequence_steps.map((step) => (
                <li key={step.step_number}>
                  <span className="text-foreground">
                    {step.delay_days === 0
                      ? "Straight away"
                      : `After ${step.delay_days} day${step.delay_days === 1 ? "" : "s"}`}
                  </span>
                  {step.mode === "manual"
                    ? " — your own words"
                    : step.brief
                      ? ` — ${step.brief}`
                      : ""}
                </li>
              ))}
            </ol>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => setEditing(s.id)}>
                <Pencil className="mr-1.5 h-3.5 w-3.5" />
                Edit
              </Button>
              {archiving === s.id ? (
                <span className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-muted-foreground">
                    {s.runs.active > 0
                      ? `This stops ${s.runs.active} lead${s.runs.active === 1 ? "" : "s"} part-way through. They will get no more messages from it.`
                      : "Archive this sequence?"}
                  </span>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={busy}
                    onClick={() => archive(s.id)}
                  >
                    Archive
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setArchiving(null)}>
                    Keep it
                  </Button>
                </span>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground"
                  onClick={() => setArchiving(s.id)}
                >
                  <Archive className="mr-1.5 h-3.5 w-3.5" />
                  Archive
                </Button>
              )}
            </div>
          </div>
        )
      )}

      {creating ? (
        <SequenceBuilder
          hasBothProducts={hasBothProducts}
          hasBookingLink={hasBookingLink}
          onDone={sequences.length === 0 ? undefined : () => setCreating(false)}
        />
      ) : (
        <Button variant="outline" onClick={() => setCreating(true)}>
          <Plus className="mr-1.5 h-4 w-4" />
          New sequence
        </Button>
      )}
    </div>
  );
}
