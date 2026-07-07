"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface CustomerOption {
  id: string;
  business_name: string;
}

export function AdminLeadControls({
  leadId,
  maxAssignments,
  assignmentCount,
  customers,
  leadType,
}: {
  leadId: string;
  maxAssignments: number;
  assignmentCount: number;
  customers: CustomerOption[];
  leadType?: string;
}) {
  const productLabel =
    leadType === "guaranteed_rent" ? "Guaranteed Rent" : "Management";
  const router = useRouter();
  const [max, setMax] = useState(String(maxAssignments));
  const [target, setTarget] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function changeMax(value: string) {
    setMax(value);
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/leads/${leadId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ max_assignments: Number(value) }),
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error);
      }
      router.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function forceAssign() {
    if (!target) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lead_id: leadId, customer_id: target }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Assignment failed");
      setMessage("Lead assigned.");
      setTarget("");
      router.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Assignment failed");
    } finally {
      setBusy(false);
    }
  }

  const atCapacity = assignmentCount >= Number(max);

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Label>Max assignments</Label>
        <Select value={max} onValueChange={changeMax} disabled={busy}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="1">1</SelectItem>
            <SelectItem value="2">2</SelectItem>
            <SelectItem value="3">3</SelectItem>
            <SelectItem value="4">4</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Currently {assignmentCount} of {max} assigned. Default is 2 — raise up
          to 4 to place a lead with more operators.
        </p>
      </div>

      <div className="space-y-2">
        <Label>Force assign to customer</Label>
        <Select value={target} onValueChange={setTarget} disabled={busy}>
          <SelectTrigger>
            <SelectValue placeholder="Select a customer…" />
          </SelectTrigger>
          <SelectContent>
            {customers.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.business_name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {customers.length === 0
            ? `No active ${productLabel} subscribers available to assign.`
            : `Only active ${productLabel} subscribers are listed.`}
        </p>
        <Button
          onClick={forceAssign}
          disabled={busy || !target || atCapacity}
          className="w-full"
        >
          {atCapacity ? "At capacity — raise max first" : "Assign lead"}
        </Button>
      </div>

      {message && (
        <p className="text-sm text-muted-foreground">{message}</p>
      )}
    </div>
  );
}
