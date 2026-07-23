"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function CapacityPanel({
  weightedUsed,
  rawActiveCount,
  initialLimit,
  waitlistedCount,
}: {
  /** Weighted slots consumed by active customers (20-lead = 1, 10-lead = 0.5). */
  weightedUsed: number;
  /** Unweighted count of active customers, shown for context. */
  rawActiveCount: number;
  initialLimit: number;
  waitlistedCount: number;
}) {
  const [limit, setLimit] = useState(initialLimit);
  const [input, setInput] = useState(String(initialLimit));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const pct = limit > 0 ? Math.min(100, Math.round((weightedUsed / limit) * 100)) : 0;
  const full = weightedUsed >= limit;

  async function save() {
    const capacity = parseInt(input, 10);
    if (!Number.isFinite(capacity) || capacity < 1) {
      setMessage("Enter a whole number of at least 1.");
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/settings/capacity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capacity }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not update capacity");
      setLimit(data.capacity ?? capacity);
      setMessage("Capacity updated");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not update capacity");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div>
          <p className="text-sm text-muted-foreground">Subscriber capacity</p>
          <p className="mt-1 text-2xl font-semibold">
            {weightedUsed} / {limit}{" "}
            <span className="text-lg font-normal text-muted-foreground">
              slots used
            </span>
          </p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {rawActiveCount} active customer{rawActiveCount === 1 ? "" : "s"}
          </p>
        </div>

        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${pct}%`, background: full ? "#b91c1c" : "#5D8156" }}
          />
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <label
              htmlFor="capacity-limit"
              className="block text-xs text-muted-foreground"
            >
              Capacity limit
            </label>
            <Input
              id="capacity-limit"
              type="number"
              min={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              className="w-24"
            />
          </div>
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
          {message && (
            <span className="pb-2 text-sm text-muted-foreground">{message}</span>
          )}
        </div>

        <p className="text-sm text-muted-foreground">
          Waitlisted accounts:{" "}
          <span className="font-medium text-foreground">{waitlistedCount}</span>
        </p>
      </CardContent>
    </Card>
  );
}
