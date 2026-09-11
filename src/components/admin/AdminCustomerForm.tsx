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
  const [balance, setBalance] = useState(customer.lead_balance);
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
  // Dead-lead claim controls (§51). Held as a STRING, unlike every number above
  // it: this is a fraction, and Number("0.1") on each keystroke collapses a
  // half-typed "0.15" to 0.1 and fights the person typing it.
  const [allowancePct, setAllowancePct] = useState(
    String(customer.quality_allowance_pct ?? 0.1)
  );
  const [reviewRequired, setReviewRequired] = useState(
    customer.quality_review_required === true
  );
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function save() {
    if (
      !Number.isFinite(allocation) ||
      !Number.isFinite(received) ||
      !Number.isFinite(balance) ||
      !Number.isFinite(grAllocation) ||
      !Number.isFinite(grReceived) ||
      !Number.isFinite(grBalance)
    ) {
      setMessage("Allocation and lead counts must be numbers.");
      return;
    }
    const pct = Number(allowancePct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 1) {
      setMessage("Claim allowance must be a number between 0 and 1.");
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
            lead_balance: Number(balance),
            is_active: active,
            gr_subscription_status: grActive ? "active" : "inactive",
            gr_monthly_allocation: Number(grAllocation),
            gr_leads_received_this_month: Number(grReceived),
            gr_lead_balance: Number(grBalance),
            quality_allowance_pct: pct,
            quality_review_required: reviewRequired,
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
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="balance">Lead balance (credits)</Label>
          <Input
            id="balance"
            type="number"
            min={0}
            value={balance}
            onChange={(e) => setBalance(Number(e.target.value))}
          />
          <p className="text-xs text-muted-foreground">
            The real gate — a customer only receives Management leads while this
            is above zero. Raise it to grant more leads.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="allocation">Monthly allocation</Label>
          <Input
            id="allocation"
            type="number"
            min={0}
            value={allocation}
            onChange={(e) => setAllocation(Number(e.target.value))}
          />
          <p className="text-xs text-muted-foreground">
            Plan size (10 or 20). Drives pacing, not the gate.
          </p>
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
            Pacing counter only — affects priority order, not whether leads can
            be received.
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

      {/* Dead-lead claim controls (§51). Admin-only — none of this is ever shown
          to the customer, because a published budget is a budget to play
          against. */}
      <div className="space-y-4 rounded-md border-[0.5px] border-border p-3">
        <div>
          <p className="text-sm font-medium">Dead-lead claims</p>
          <p className="text-xs text-muted-foreground">
            When an operator reports that a landlord had already gone, this is
            how many reports a cycle we credit back without a person reading
            them. Anything beyond it is not refused — it goes to the review
            queue instead.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="allowance_pct">Claim allowance</Label>
            <Input
              id="allowance_pct"
              type="number"
              step="0.05"
              min={0}
              max={1}
              value={allowancePct}
              onChange={(e) => setAllowancePct(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              A share of their plan size, rounded. The default 0.10 gives 1 a
              cycle on a 10-lead plan and 2 on a 20-lead plan; 0.15 gives 2 and
              3. They earn one more per run of ten leads taken without
              claiming, up to two.
            </p>
          </div>
          <div className="space-y-2">
            <Label>Where they are now</Label>
            <p className="text-sm">
              {customer.quality_claims_this_cycle ?? 0} used this cycle ·{" "}
              {customer.clean_leads_streak ?? 0} clean in a row
            </p>
            <p className="text-xs text-muted-foreground">
              Both reset on their own billing anchor day. The streak also
              resets to zero every time a claim is upheld.
            </p>
          </div>
        </div>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Always review their claims</p>
            <p className="text-xs text-muted-foreground">
              Sends every report to the queue whatever the allowance says. Use
              this rather than an allowance of zero — the earned bonus can
              still climb out of a zero.
            </p>
          </div>
          <Switch checked={reviewRequired} onCheckedChange={setReviewRequired} />
        </div>
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
