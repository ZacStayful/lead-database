"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/utils";
import type { AdminPoolLead } from "@/lib/pool";

/**
 * One product's pool, with the manual override.
 *
 * Shows what the customer's view deliberately hides — how many operators held
 * the lead and how it got here — because that is the number an admin needs to
 * judge whether the pool is behaving.
 */
export function AdminPoolTable({
  leads,
  emptyLabel,
}: {
  leads: AdminPoolLead[];
  emptyLabel: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function force(leadId: string, action: "in" | "out") {
    setBusy(leadId);
    setError(null);
    try {
      const res = await fetch("/api/admin/pool", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lead_id: leadId, action }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body?.error ?? "Could not update the pool");
        return;
      }
      router.refresh();
    } catch {
      setError("Could not reach the server");
    } finally {
      setBusy(null);
    }
  }

  if (leads.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
        {emptyLabel}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left">
            <tr>
              <th className="px-3 py-2 font-medium">Lead</th>
              <th className="px-3 py-2 font-medium">Why pooled</th>
              <th className="px-3 py-2 font-medium">Held by</th>
              <th className="px-3 py-2 font-medium">In pool</th>
              <th className="px-3 py-2 font-medium">Expires in</th>
              <th className="px-3 py-2 font-medium">Last activity</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {leads.map((l) => (
              <tr key={l.leadId} className="border-t">
                <td className="px-3 py-2">
                  <Link
                    href={`/admin/leads/${l.leadId}`}
                    className="font-medium hover:underline"
                  >
                    {l.leadName}
                  </Link>
                  <div className="text-xs text-muted-foreground">
                    {[l.postcodeArea, l.bedrooms && `${l.bedrooms} bed`]
                      .filter(Boolean)
                      .join(" · ") || "—"}
                  </div>
                </td>
                <td className="px-3 py-2">
                  <Badge variant="secondary">
                    {l.basis === "unassigned" ? "Never assigned" : "Not worked"}
                  </Badge>
                </td>
                <td className="px-3 py-2 tabular-nums">
                  {l.assignmentCount} / {l.maxAssignments}
                </td>
                <td className="px-3 py-2 tabular-nums">
                  {l.daysInPool}d
                </td>
                <td className="px-3 py-2 tabular-nums">
                  {l.daysUntilExpiry}d
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {formatDate(l.lastActivityAt)}
                </td>
                <td className="px-3 py-2 text-right">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy === l.leadId}
                    onClick={() => void force(l.leadId, "out")}
                  >
                    {busy === l.leadId ? "…" : "Remove"}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Put a specific lead into the pool by id.
 *
 * A free-text id rather than a picker: forcing a lead in is a rare, deliberate
 * act carried out with a lead already open in another tab, and a searchable
 * list of every lead in the database would be a much bigger surface for a
 * control used a handful of times a year.
 */
export function ForcePoolIn() {
  const router = useRouter();
  const [leadId, setLeadId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  async function submit() {
    if (!leadId.trim()) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/pool", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lead_id: leadId.trim(), action: "in" }),
      });
      const body = await res.json();
      if (!res.ok) {
        setFailed(true);
        setMessage(body?.error ?? "Could not add the lead");
        return;
      }
      setFailed(false);
      setMessage("Lead added to the pool.");
      setLeadId("");
      router.refresh();
    } catch {
      setFailed(true);
      setMessage("Could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <input
          value={leadId}
          onChange={(e) => setLeadId(e.target.value)}
          placeholder="Lead id"
          className="min-w-[22rem] flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:border-brand"
        />
        <Button size="sm" disabled={busy || !leadId.trim()} onClick={() => void submit()}>
          {busy ? "Adding…" : "Force into pool"}
        </Button>
      </div>
      {message && (
        <p className={failed ? "text-sm text-red-600" : "text-sm text-brand"}>
          {message}
        </p>
      )}
    </div>
  );
}
