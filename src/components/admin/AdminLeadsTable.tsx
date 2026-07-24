"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, X } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/utils";

export interface LeadRow {
  id: string;
  lead_name: string;
  lead_type: string;
  address: string | null;
  assignment_count: number;
  max_assignments: number;
  created_at: string;
  recipients: string[];
}

export interface CustomerRow {
  id: string;
  business_name: string;
  lead_balance: number;
  gr_lead_balance: number;
  subscription_status: string;
  gr_subscription_status: string;
}

export function AdminLeadsTable({
  leads,
  customers,
}: {
  leads: LeadRow[];
  customers: CustomerRow[];
}) {
  const router = useRouter();
  const [selectedLeads, setSelectedLeads] = useState<Set<string>>(new Set());
  const [selectedCustomers, setSelectedCustomers] = useState<Set<string>>(
    new Set()
  );
  const [override, setOverride] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Only leads still below capacity can take another recipient.
  const selectableIds = useMemo(
    () =>
      leads
        .filter((l) => l.assignment_count < l.max_assignments)
        .map((l) => l.id),
    [leads]
  );
  const allSelected =
    selectableIds.length > 0 && selectedLeads.size === selectableIds.length;

  // Which lead types are in the current selection — used to flag GR/mgmt mixing.
  const selectedTypes = useMemo(() => {
    const t = new Set<string>();
    for (const l of leads) if (selectedLeads.has(l.id)) t.add(l.lead_type);
    return t;
  }, [leads, selectedLeads]);
  const hasGr = selectedTypes.has("guaranteed_rent");
  const hasMgmt = selectedTypes.has("management");

  function toggleLead(id: string) {
    setMessage(null);
    setSelectedLeads((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setMessage(null);
    setSelectedLeads(allSelected ? new Set() : new Set(selectableIds));
  }

  function toggleCustomer(id: string) {
    setMessage(null);
    setSelectedCustomers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function clearSelection() {
    setSelectedLeads(new Set());
    setSelectedCustomers(new Set());
    setMessage(null);
  }

  async function assign() {
    if (selectedLeads.size === 0 || selectedCustomers.size === 0) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/assign/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lead_ids: Array.from(selectedLeads),
          customer_ids: Array.from(selectedCustomers),
          override,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Assignment failed");

      const failed = (data.failures ?? []) as { error: string }[];
      let msg = `Made ${data.assignments} assignment${
        data.assignments === 1 ? "" : "s"
      } across ${data.leads_affected} lead${
        data.leads_affected === 1 ? "" : "s"
      }.`;
      if (failed.length > 0) {
        msg += ` ${failed.length} pair${
          failed.length === 1 ? "" : "s"
        } skipped: ${failed[0].error}`;
      }
      setMessage(msg);
      setSelectedCustomers(new Set());
      setSelectedLeads(new Set());
      router.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Assignment failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <input
                  type="checkbox"
                  aria-label="Select all pending leads"
                  checked={allSelected}
                  onChange={toggleAll}
                  disabled={selectableIds.length === 0}
                  className="h-4 w-4 accent-brand align-middle"
                />
              </TableHead>
              <TableHead>Lead</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Address</TableHead>
              <TableHead>Assigned</TableHead>
              <TableHead>Recipients</TableHead>
              <TableHead>Received</TableHead>
              <TableHead className="text-right">View</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {leads.map((l) => {
              const full = l.assignment_count >= l.max_assignments;
              const none = l.assignment_count === 0;
              const checked = selectedLeads.has(l.id);
              return (
                <TableRow
                  key={l.id}
                  className={checked ? "bg-brand/5" : undefined}
                >
                  <TableCell>
                    <input
                      type="checkbox"
                      aria-label={`Select ${l.lead_name}`}
                      checked={checked}
                      onChange={() => toggleLead(l.id)}
                      disabled={full}
                      className="h-4 w-4 accent-brand align-middle disabled:opacity-30"
                    />
                  </TableCell>
                  <TableCell className="font-medium">{l.lead_name}</TableCell>
                  <TableCell>
                    {l.lead_type === "guaranteed_rent"
                      ? "Guaranteed Rent"
                      : "Management"}
                  </TableCell>
                  <TableCell className="max-w-[220px] truncate text-muted-foreground">
                    {l.address ?? "—"}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={full ? "muted" : "brand"}
                      className={
                        none
                          ? "border-amber-300 bg-amber-50 text-amber-700"
                          : undefined
                      }
                    >
                      {l.assignment_count} / {l.max_assignments}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-[200px] truncate text-muted-foreground">
                    {l.recipients.length ? l.recipients.join(", ") : "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(l.created_at)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Link
                      href={`/admin/leads/${l.id}`}
                      className="text-brand hover:underline"
                    >
                      View
                    </Link>
                  </TableCell>
                </TableRow>
              );
            })}
            {leads.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={8}
                  className="py-10 text-center text-muted-foreground"
                >
                  No leads yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>

      {/* Sticky bulk-assign bar — appears once leads are selected. */}
      {selectedLeads.size > 0 && (
        <div className="sticky bottom-4 z-10 mx-auto max-w-3xl rounded-xl border border-border bg-card p-4 shadow-lg">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium">
              {selectedLeads.size} lead{selectedLeads.size === 1 ? "" : "s"}{" "}
              selected
            </span>
            <button
              type="button"
              onClick={clearSelection}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" /> Clear
            </button>
          </div>

          <p className="mt-3 mb-1.5 text-xs font-medium text-muted-foreground">
            Assign to which customers?
          </p>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {customers.map((c) => {
              const isSel = selectedCustomers.has(c.id);
              const bits: string[] = [];
              if (hasMgmt) bits.push(`Mgmt ${c.lead_balance}`);
              if (hasGr) bits.push(`GR ${c.gr_lead_balance}`);
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => toggleCustomer(c.id)}
                  disabled={busy}
                  className={
                    "flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors " +
                    (isSel
                      ? "border-brand bg-brand/10"
                      : "border-border hover:bg-muted")
                  }
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-medium">
                      {c.business_name}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {bits.join(" · ") || "credits"}
                    </span>
                  </span>
                  <span
                    className={
                      "flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border " +
                      (isSel
                        ? "border-brand bg-brand text-white"
                        : "border-border")
                    }
                  >
                    {isSel && <Check className="h-3 w-3" />}
                  </span>
                </button>
              );
            })}
          </div>

          <label className="mt-3 flex cursor-pointer items-start gap-2 text-xs">
            <input
              type="checkbox"
              checked={override}
              onChange={() => setOverride((v) => !v)}
              disabled={busy}
              className="mt-0.5 h-4 w-4 accent-brand"
            />
            <span>
              <span className="font-medium text-foreground">
                Override credit limit
              </span>{" "}
              <span className="text-muted-foreground">
                — place these even with customers who are out of credits or not
                subscribed. No credit is spent. (Paused customers are still
                blocked.)
              </span>
            </span>
          </label>

          <div className="mt-3 flex items-center gap-3">
            <Button
              onClick={assign}
              disabled={busy || selectedCustomers.size === 0}
            >
              {busy
                ? "Assigning…"
                : `Assign ${selectedLeads.size} lead${
                    selectedLeads.size === 1 ? "" : "s"
                  } to ${selectedCustomers.size || ""} ${
                    selectedCustomers.size === 1 ? "customer" : "customers"
                  }`.trim()}
            </Button>
            {message && (
              <span className="text-xs text-muted-foreground">{message}</span>
            )}
          </div>
          {!override && hasGr && (
            <p className="mt-2 text-xs text-amber-700">
              GR leads are selected — without override, only customers with an
              active GR subscription and GR credits will take them.
            </p>
          )}
        </div>
      )}
      {message && selectedLeads.size === 0 && (
        <p className="text-sm text-muted-foreground">{message}</p>
      )}
    </>
  );
}
