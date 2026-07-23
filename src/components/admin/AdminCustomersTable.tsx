"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Filter } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { computePacing, type PacingStatus } from "@/lib/pacing";
import type { Customer } from "@/lib/types";

type Tab = "all" | "active" | "waitlisted" | "invited";

const TABS: { key: Tab; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "waitlisted", label: "Waitlisted" },
  { key: "invited", label: "Invited" },
];

type ProductTab = "all" | "management" | "guaranteed_rent" | "both";

const PRODUCT_TABS: { key: ProductTab; label: string }[] = [
  { key: "all", label: "All products" },
  { key: "management", label: "Management" },
  { key: "guaranteed_rent", label: "Guaranteed Rent" },
  { key: "both", label: "Both" },
];

// Mirror the routing gate: management leads only reach customers who are both
// account-active and subscription-active (see get_next_customers_for_lead).
const hasManagement = (c: Customer) =>
  c.subscription_status === "active" && c.account_status === "active";
const hasGuaranteedRent = (c: Customer) => c.gr_subscription_status === "active";

// A customer with an active or pending-lift filter on either product.
const isFiltered = (s: string | null | undefined) =>
  s === "active" || s === "pending_lift";
const hasFilter = (c: Customer) =>
  isFiltered(c.filter_status) || isFiltered(c.gr_filter_status);

const ACCOUNT_BADGE: Record<string, string> = {
  active: "border-transparent bg-green-100 text-green-700",
  invited: "border-transparent bg-amber-100 text-amber-700",
  waitlisted: "border-transparent bg-gray-100 text-gray-600",
  cancelled: "border-transparent bg-red-100 text-red-700",
};

export function AdminCustomersTable({
  customers,
  lastActive = {},
}: {
  customers: Customer[];
  /** customer.id → last sign-in timestamp (null = has login, never signed in). */
  lastActive?: Record<string, string | null>;
}) {
  const [tab, setTab] = useState<Tab>("all");
  const [product, setProduct] = useState<ProductTab>("all");
  // Local overrides so a row's badge updates after invite without a reload.
  const [statusOverride, setStatusOverride] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const accountStatus = (c: Customer) => statusOverride[c.id] ?? c.account_status;

  const rows = useMemo(() => {
    let list = customers.filter((c) => tab === "all" || accountStatus(c) === tab);
    list = list.filter((c) => {
      if (product === "management") return hasManagement(c);
      if (product === "guaranteed_rent") return hasGuaranteedRent(c);
      if (product === "both") return hasManagement(c) && hasGuaranteedRent(c);
      return true;
    });
    if (tab === "waitlisted") {
      // Earliest signup first.
      list = [...list].sort(
        (a, b) => +new Date(a.created_at) - +new Date(b.created_at)
      );
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customers, tab, product, statusOverride]);

  async function handleInvite(id: string, email: string) {
    setBusyId(id);
    setToast(null);
    try {
      const res = await fetch(`/api/admin/customers/${id}/invite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (!res.ok) {
        setToast(data.error ?? "Could not send invitation.");
        return;
      }
      setStatusOverride((s) => ({ ...s, [id]: "invited" }));
      // Capacity is non-blocking: the invite always succeeds, but flag it when
      // this customer would push weighted usage over the limit.
      setToast(
        data.capacityWarning && data.warningMessage
          ? `Invitation sent to ${email}. ${data.warningMessage}`
          : `Invitation sent to ${email}`
      );
    } catch {
      setToast("Could not send invitation.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleResendInvite(id: string, email: string) {
    setBusyId(id);
    setToast(null);
    try {
      const res = await fetch(`/api/admin/customers/${id}/resend-invite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (!res.ok) {
        setToast(data.error ?? "Could not resend invitation.");
        return;
      }
      setToast(`Invitation resent to ${email}`);
    } catch {
      setToast("Could not resend invitation.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors " +
                (tab === t.key
                  ? "bg-brand text-brand-foreground"
                  : "text-muted-foreground hover:bg-accent")
              }
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="hidden h-5 w-px bg-border sm:block" />
        <div className="flex gap-1">
          {PRODUCT_TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setProduct(t.key)}
              className={
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors " +
                (product === t.key
                  ? "bg-brand text-brand-foreground"
                  : "text-muted-foreground hover:bg-accent")
              }
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {toast && (
        <div className="rounded-md border-[0.5px] border-border bg-muted/50 px-4 py-2 text-sm">
          {toast}
        </div>
      )}

      <div className="rounded-lg border-[0.5px] border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Business</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Products</TableHead>
              <TableHead>Account</TableHead>
              <TableHead>Billing</TableHead>
              <TableHead>Leads</TableHead>
              <TableHead>Pacing</TableHead>
              <TableHead>Last lead</TableHead>
              <TableHead>Last active</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((c) => {
              const status = accountStatus(c);
              const pacing = computePacing(c);
              return (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">
                    <span className="flex items-center gap-1.5">
                      {c.business_name}
                      {hasFilter(c) && (
                        <span
                          title="Lead filter active"
                          className="inline-flex items-center gap-1 rounded-full bg-brand/10 px-1.5 py-0.5 text-[10px] font-medium text-brand"
                        >
                          <Filter className="h-3 w-3" />
                          Filtered
                        </span>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{c.email}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {hasManagement(c) && (
                        <Badge
                          variant="outline"
                          className="border-transparent bg-[#EAF3DE] text-[#3B6D11]"
                        >
                          Management
                        </Badge>
                      )}
                      {hasGuaranteedRent(c) && (
                        <Badge
                          variant="outline"
                          className="border-transparent bg-blue-50 text-blue-700"
                        >
                          Guaranteed Rent
                        </Badge>
                      )}
                      {!hasManagement(c) && !hasGuaranteedRent(c) && (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={
                        ACCOUNT_BADGE[status] ??
                        "border-transparent bg-gray-100 text-gray-600"
                      }
                    >
                      {status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        c.subscription_status === "active" ? "brand" : "muted"
                      }
                    >
                      {c.subscription_status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {c.leads_received_this_month} / {c.monthly_allocation}
                  </TableCell>
                  <TableCell>
                    <PacingBadge status={pacing.status} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {c.last_assignment_at ? formatDate(c.last_assignment_at) : "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    <LastActive
                      hasLogin={c.user_id != null}
                      lastSignInAt={lastActive[c.id] ?? null}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-3">
                      {status === "waitlisted" && (
                        <button
                          onClick={() => handleInvite(c.id, c.email)}
                          disabled={busyId === c.id}
                          className="text-sm font-medium text-[#5D8156] hover:underline disabled:opacity-50"
                        >
                          Invite to subscribe
                        </button>
                      )}
                      {status === "invited" && (
                        <button
                          onClick={() => handleResendInvite(c.id, c.email)}
                          disabled={busyId === c.id}
                          className="text-sm font-medium text-[#5D8156] hover:underline disabled:opacity-50"
                        >
                          Resend invitation
                        </button>
                      )}
                      <Link
                        href={`/admin/customers/${c.id}`}
                        className="text-sm text-brand hover:underline"
                      >
                        Edit
                      </Link>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
            {rows.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={10}
                  className="py-10 text-center text-muted-foreground"
                >
                  No customers in this view.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/** Last time the customer signed in to the portal (their "last active"). */
function LastActive({
  hasLogin,
  lastSignInAt,
}: {
  hasLogin: boolean;
  lastSignInAt: string | null;
}) {
  if (!hasLogin) {
    return (
      <span title="No portal login has been created yet">No account</span>
    );
  }
  if (!lastSignInAt) {
    return (
      <span
        title="Login exists but the customer has never signed in"
        className="text-amber-700"
      >
        Never
      </span>
    );
  }
  return <span title={lastSignInAt}>{formatDate(lastSignInAt)}</span>;
}

function PacingBadge({ status }: { status: PacingStatus }) {
  if (status === "behind") {
    return (
      <span className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800">
        Behind
      </span>
    );
  }
  if (status === "ahead") {
    return (
      <span className="inline-flex items-center rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
        Ahead
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-brand/10 px-2.5 py-0.5 text-xs font-medium text-brand">
      On track
    </span>
  );
}
