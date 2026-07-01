"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { Customer } from "@/lib/types";

export function AdminCustomerForm({ customer }: { customer: Customer }) {
  const router = useRouter();
  const [allocation, setAllocation] = useState(customer.monthly_allocation);
  const [received, setReceived] = useState(customer.leads_received_this_month);
  const [overflow, setOverflow] = useState(customer.overflow_enabled);
  const [active, setActive] = useState(customer.is_active);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(
        `/api/admin/customers/${customer.id}/allocation`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            monthly_allocation: Number(allocation),
            leads_received_this_month: Number(received),
            overflow_enabled: overflow,
            is_active: active,
          }),
        }
      );
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Save failed");
      }
      setMessage("Saved.");
      router.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="allocation">Monthly allocation</Label>
          <Input
            id="allocation"
            type="number"
            min={0}
            value={allocation}
            onChange={(e) => setAllocation(Number(e.target.value))}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="received">Leads received this month</Label>
          <Input
            id="received"
            type="number"
            min={0}
            value={received}
            onChange={(e) => setReceived(Number(e.target.value))}
          />
          <p className="text-xs text-muted-foreground">
            Manual credit adjustment — lower this to grant more leads this month.
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between rounded-md border-[0.5px] border-border p-3">
        <div>
          <p className="text-sm font-medium">Overflow enabled</p>
          <p className="text-xs text-muted-foreground">
            Allow leads beyond the monthly allocation at £20 each.
          </p>
        </div>
        <Switch checked={overflow} onCheckedChange={setOverflow} />
      </div>

      <div className="flex items-center justify-between rounded-md border-[0.5px] border-border p-3">
        <div>
          <p className="text-sm font-medium">Active</p>
          <p className="text-xs text-muted-foreground">
            Inactive customers are excluded from lead assignment.
          </p>
        </div>
        <Switch checked={active} onCheckedChange={setActive} />
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save changes"}
        </Button>
        {message && (
          <span className="text-sm text-muted-foreground">{message}</span>
        )}
      </div>
    </div>
  );
}
