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
  const [active, setActive] = useState(customer.is_active);
  // Guaranteed Rent controls.
  const [grActive, setGrActive] = useState(
    customer.gr_subscription_status === "active"
  );
  const [grAllocation, setGrAllocation] = useState(customer.gr_monthly_allocation);
  const [grReceived, setGrReceived] = useState(
    customer.gr_leads_received_this_month
  );
  const [grBalance, setGrBalance] = useState(customer.gr_lead_balance);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function save() {
    if (
      !Number.isFinite(allocation) ||
      !Number.isFinite(received) ||
      !Number.isFinite(grAllocation) ||
      !Number.isFinite(grReceived) ||
      !Number.isFinite(grBalance)
    ) {
      setMessage("Allocation and lead counts must be numbers.");
      return;
    }
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
            is_active: active,
            gr_subscription_status: grActive ? "active" : "inactive",
            gr_monthly_allocation: Number(grAllocation),
            gr_leads_received_this_month: Number(grReceived),
            gr_lead_balance: Number(grBalance),
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
          <p className="text-sm font-medium">Active</p>
          <p className="text-xs text-muted-foreground">
            Inactive customers are excluded from lead assignment.
          </p>
        </div>
        <Switch checked={active} onCheckedChange={setActive} />
      </div>

      {/* Guaranteed Rent subscription controls */}
      <div className="space-y-4 rounded-md border-[0.5px] border-border p-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Guaranteed Rent subscription</p>
            <p className="text-xs text-muted-foreground">
              Active GR subscribers receive guaranteed-rent leads.
            </p>
          </div>
          <Switch checked={grActive} onCheckedChange={setGrActive} />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="gr_allocation">GR monthly allocation</Label>
            <Input
              id="gr_allocation"
              type="number"
              min={0}
              value={grAllocation}
              onChange={(e) => setGrAllocation(Number(e.target.value))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="gr_received">GR leads this month</Label>
            <Input
              id="gr_received"
              type="number"
              min={0}
              value={grReceived}
              onChange={(e) => setGrReceived(Number(e.target.value))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="gr_balance">GR lead balance</Label>
            <Input
              id="gr_balance"
              type="number"
              min={0}
              value={grBalance}
              onChange={(e) => setGrBalance(Number(e.target.value))}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          GR lead balance is the credit gate — a customer only receives GR leads
          while this is above zero.
        </p>
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
