"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
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
  credits: number;
}

export function AdminLeadControls({
  leadId,
  maxAssignments,
  assignmentCount,
  customers,
  overrideCustomers,
  leadType,
}: {
  leadId: string;
  maxAssignments: number;
  assignmentCount: number;
  customers: CustomerOption[];
  overrideCustomers: CustomerOption[];
  leadType?: string;
}) {
  const productLabel =
    leadType === "guaranteed_rent" ? "Guaranteed Rent" : "Management";
  const router = useRouter();
  const [max, setMax] = useState(String(maxAssignments));
  const [override, setOverride] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const remainingSlots = Math.max(0, Number(max) - assignmentCount);
  const atCapacity = remainingSlots === 0;

  // Normal mode only lists customers who can actually be charged a credit;
  // override mode lists every approved customer regardless of credit/subscription.
  const list = override ? overrideCustomers : customers;
  const selectedIds = useMemo(() => Array.from(selected), [selected]);

  function toggle(id: string) {
    setMessage(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < remainingSlots) {
        next.add(id);
      }
      return next;
    });
  }

  function toggleOverride() {
    setSelected(new Set());
    setMessage(null);
    setOverride((v) => !v);
  }

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
    if (selectedIds.length === 0) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lead_id: leadId,
          customer_ids: selectedIds,
          override,
        }),
      });
      const raw = await res.text();
      let data: { error?: string; assigned_count?: number; failures?: { error: string }[] };
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error(
          "The request timed out or errored before finishing. Refresh to see what went through."
        );
      }
      if (!res.ok) throw new Error(data.error ?? "Assignment failed");

      const failed = (data.failures ?? []) as { error: string }[];
      if (failed.length > 0) {
        setMessage(
          `Assigned ${data.assigned_count}. ${failed.length} could not be assigned: ${failed[0].error}`
        );
      } else {
        setMessage(
          `Assigned ${data.assigned_count} customer${
            data.assigned_count === 1 ? "" : "s"
          }.`
        );
      }
      setSelected(new Set());
      router.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Assignment failed");
    } finally {
      setBusy(false);
    }
  }

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
        <div className="flex items-center justify-between">
          <Label>Assign to customers</Label>
          <span className="text-xs text-muted-foreground">
            {selected.size}/{remainingSlots} selected
          </span>
        </div>

        <label className="flex cursor-pointer items-start gap-2 rounded-md border-[0.5px] border-border p-2.5">
          <input
            type="checkbox"
            checked={override}
            onChange={toggleOverride}
            disabled={busy}
            className="mt-0.5 h-4 w-4 accent-brand"
          />
          <span className="text-xs">
            <span className="font-medium text-foreground">
              Override credit limit
            </span>
            <span className="block text-muted-foreground">
              Place this lead with any approved customer, even one out of paid
              credits{leadType === "guaranteed_rent" ? " or without a GR subscription" : ""}. No credit is spent. (Paused customers are still blocked.)
            </span>
          </span>
        </label>

        {list.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {override
              ? "No approved customers available to assign."
              : `No active ${productLabel} subscribers with credits available. Tick “Override credit limit” to place it anyway.`}
          </p>
        ) : atCapacity ? (
          <p className="text-xs text-muted-foreground">
            At capacity — raise max assignments to add more recipients.
          </p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              Pick up to {remainingSlots} customer
              {remainingSlots === 1 ? "" : "s"}, then assign in one go.
            </p>
            <div className="max-h-60 space-y-1 overflow-y-auto rounded-md border-[0.5px] border-border p-1">
              {list.map((c) => {
                const isSelected = selected.has(c.id);
                const disabled =
                  busy || (!isSelected && selected.size >= remainingSlots);
                const noCredits = c.credits <= 0;
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => toggle(c.id)}
                    disabled={disabled}
                    className={
                      "flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors " +
                      (isSelected
                        ? "bg-brand/10 text-foreground"
                        : "hover:bg-muted disabled:opacity-40 disabled:hover:bg-transparent")
                    }
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-medium">
                        {c.business_name}
                      </span>
                      <span
                        className={
                          "text-xs " +
                          (noCredits ? "text-amber-600" : "text-muted-foreground")
                        }
                      >
                        {c.credits} credit{c.credits === 1 ? "" : "s"} left
                        {noCredits && override ? " — override" : ""}
                      </span>
                    </span>
                    <span
                      className={
                        "flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border " +
                        (isSelected
                          ? "border-brand bg-brand text-white"
                          : "border-border")
                      }
                    >
                      {isSelected && <Check className="h-3 w-3" />}
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        )}

        <Button
          onClick={forceAssign}
          disabled={busy || selected.size === 0}
          className="w-full"
        >
          {override && selected.size > 0
            ? `Override-assign ${selected.size}`
            : selected.size > 1
              ? `Assign ${selected.size} customers`
              : "Assign lead"}
        </Button>
      </div>

      {message && <p className="text-sm text-muted-foreground">{message}</p>}
    </div>
  );
}
