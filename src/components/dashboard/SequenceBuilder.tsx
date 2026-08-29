"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Plus, Trash2, Zap } from "lucide-react";
import { MAX_STEPS } from "@/lib/messaging/sequenceInput";

/**
 * Build a follow-up ladder (§40.13).
 *
 * ⚠️ THE OPERATOR WRITES A BRIEF, NOT A MESSAGE. That is the whole difference
 * between this and mail merge, and it is worth being explicit about on the
 * screen: a template sent to two hundred landlords from one WhatsApp number is
 * exactly the mass-outreach pattern that gets the number restricted, and it is
 * also, separately, what nobody replies to. Each step says what it is FOR and
 * the message is written per lead the night before it goes.
 */

export interface SequenceStepView {
  step_number: number;
  delay_days: number;
  brief: string | null;
}

export interface SequenceView {
  id: string;
  name: string;
  lead_type: string;
  trigger: string;
  is_active: boolean;
  message_sequence_steps: SequenceStepView[];
  runs: { active: number; completed: number; stopped: number };
}

interface DraftStep {
  delay_days: number;
  brief: string;
}

/** What most operators want, offered rather than left blank. */
const STARTER: DraftStep[] = [
  { delay_days: 0, brief: "Open the conversation and ask one easy question" },
  { delay_days: 3, brief: "Light nudge, nothing new to say" },
  { delay_days: 7, brief: "Last try — offer an easy way to say no" },
];

export function SequenceBuilder({
  existing,
  hasBothProducts,
  onDone,
}: {
  existing?: SequenceView;
  hasBothProducts: boolean;
  onDone?: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(existing?.name ?? "Follow-up");
  const [leadType, setLeadType] = useState(existing?.lead_type ?? "management");
  const [trigger, setTrigger] = useState(existing?.trigger ?? "manual");
  const [steps, setSteps] = useState<DraftStep[]>(
    existing
      ? existing.message_sequence_steps.map((s) => ({
          delay_days: s.delay_days,
          brief: s.brief ?? "",
        }))
      : STARTER
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function setStep(i: number, patch: Partial<DraftStep>) {
    setSteps((prev) => prev.map((s, j) => (i === j ? { ...s, ...patch } : s)));
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name,
        lead_type: leadType,
        trigger,
        steps: steps.map((s) => ({
          delay_days: s.delay_days,
          brief: s.brief.trim() || null,
        })),
      };
      const res = await fetch(
        existing
          ? `/api/customer/messaging/sequences/${existing.id}`
          : "/api/customer/messaging/sequences",
        {
          method: existing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Could not save the sequence.");
        return;
      }
      onDone?.();
      router.refresh();
    } catch {
      setError("We could not reach the server.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4 rounded-lg border-[0.5px] border-border bg-card p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="text-xs text-muted-foreground">Name</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        </div>
        {hasBothProducts && (
          <div>
            <label className="text-xs text-muted-foreground">Which leads</label>
            <select
              value={leadType}
              onChange={(e) => setLeadType(e.target.value)}
              className="h-10 w-full rounded-md border-[0.5px] border-border bg-background px-3 text-sm"
            >
              <option value="management">Management</option>
              <option value="guaranteed_rent">Guaranteed Rent</option>
            </select>
          </div>
        )}
      </div>

      <div className="rounded-md bg-muted/40 p-3">
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={trigger === "on_assignment"}
            onChange={(e) => setTrigger(e.target.checked ? "on_assignment" : "manual")}
            className="mt-1 h-4 w-4"
          />
          <span>
            <span className="font-medium">Start this automatically for every new lead</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              New leads join this sequence the moment they land in your account.
              You can only have one automatic sequence per lead type — leave this
              off and you add leads to it yourself.
            </span>
          </span>
        </label>
      </div>

      <div className="space-y-2">
        {steps.map((step, i) => (
          <div
            key={i}
            className="flex flex-col gap-2 rounded-md border-[0.5px] border-border p-3 sm:flex-row sm:items-center"
          >
            <Badge variant="outline" className="w-fit shrink-0">
              Message {i + 1}
            </Badge>
            <div className="flex shrink-0 items-center gap-2 text-sm">
              <Input
                type="number"
                min={i === 0 ? 0 : 1}
                max={90}
                value={step.delay_days}
                onChange={(e) => setStep(i, { delay_days: Number(e.target.value) })}
                className="h-9 w-20"
              />
              <span className="text-muted-foreground">
                {i === 0 ? "days after joining" : "days after the last one"}
              </span>
            </div>
            <Input
              value={step.brief}
              onChange={(e) => setStep(i, { brief: e.target.value })}
              placeholder="What is this message for?"
              maxLength={200}
              className="h-9 flex-1"
            />
            {steps.length > 1 && (
              <button
                type="button"
                onClick={() => setSteps((prev) => prev.filter((_, j) => j !== i))}
                className="self-end text-muted-foreground hover:text-destructive sm:self-auto"
                aria-label={`Remove message ${i + 1}`}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </div>
        ))}
      </div>

      {steps.length < MAX_STEPS && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setSteps((prev) => [...prev, { delay_days: 5, brief: "" }])}
        >
          <Plus className="mr-1.5 h-4 w-4" />
          Add a message
        </Button>
      )}

      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <Zap className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          You are describing what each message is for, not writing it. Each one
          is written for that specific landlord and property the evening before
          it goes, and waits in your review list overnight so you can change or
          cancel it. Nothing is ever sent outside 9am–8pm.
        </span>
      </p>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex gap-2">
        <Button onClick={save} disabled={saving}>
          {saving ? "Saving…" : existing ? "Save changes" : "Create sequence"}
        </Button>
        {onDone && (
          <Button variant="ghost" onClick={onDone} disabled={saving}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}
