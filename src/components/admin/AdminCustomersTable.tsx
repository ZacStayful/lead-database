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
import { Filter, Pause } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { computePacing, computeGrPacing, type PacingStatus } from "@/lib/pacing";
import {
  activeLeadFilters,
  filterSummary,
  filterTooltip,
  hasLeadFilter,
} from "@/lib/leadFilter";
import type { Customer } from "@/lib/types";

type Tab =
  | "all"
  | "active"
  | "waitlisted"
  | "invited"
  | "cancelled"
  | "archived";

const TABS: { key: Tab; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "waitlisted", label: "Waitlisted" },
  { key: "invited", label: "Invited" },
  { key: "cancelled", label: "Cancelled" },
  { key: "archived", label: "Archived" },
];

/**
 * `is_active = false` means archived: a row kept for its history but taken out
 * of circulation, typically a duplicate signup superseded by a later account.
 *
 * Routing has always honoured it — both candidate functions require
 * is_active = true — but every admin list showed these rows anyway, so a stale
 * duplicate kept appearing beside the real account under the same name. They are
 * hidden from every other tab and reachable only under Archived, so archiving
 * stays reversible rather than becoming a row nobody can find again.
 */
const isArchived = (c: Customer) => c.is_active === false;

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

/**
 * Whether a product is worth showing figures for on this row.
 *
 * Deliberately looser than hasManagement/hasGuaranteedRent, which mirror the
 * routing gate: a past_due or cancelled subscription still has billing state and
 * credits an admin needs to see. A row where neither product qualifies is a
 * prospect who has never paid, and falls back to the management columns.
 */
const showsManagement = (c: Customer) =>
  c.subscription_status !== "inactive" || c.lead_balance > 0;
const showsGr = (c: Customer) =>
  c.gr_subscription_status !== "inactive" || c.gr_lead_balance > 0;

/**
 * The account state to file a customer under.
 *
 * `account_status` is management-only (CLAUDE.md §3, invariant 6) and the GR
 * webhook never writes it, so a GR-only subscriber sits at 'waitlisted' forever
 * — which read as an unconverted prospect and buried an active paying customer
 * under the Waitlisted tab. Holding GR makes them active, whatever the
 * management column says.
 */
const effectiveStatus = (c: Customer, accountStatus: string) =>
  hasGuaranteedRent(c) ? "active" : accountStatus;

// A management subscriber whose subscription is currently paused (account_status
// stays 'active', so they still appear under the Active tab).
const isPaused = (c: Customer) => Boolean(c.paused_at);

// A customer with an active or pending-lift filter on either product.
const hasFilter = hasLeadFilter;

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

  const accountStatus = (c: Customer) =>
    effectiveStatus(c, statusOverride[c.id] ?? c.account_status);

  const rows = useMemo(() => {
    // Archived rows appear under their own tab and nowhere else — including
    // "All", which otherwise put a dead duplicate right beside the live account
    // it was superseded by.
    let list = customers.filter((c) =>
      tab === "archived" ? isArchived(c) : !isArchived(c)
    );
    list = list.filter((c) => tab === "all" || tab === "archived" || accountStatus(c) === tab);
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

  /**
   * Invite a customer to subscribe to ONE product.
   *
   * The product is explicit at the call site rather than inferred, because the
   * two products cost the same for the same number of leads: a wrong guess here
   * bills the customer correctly and provisions them onto the wrong product,
   * which is invisible on the invoice and only shows up as the wrong leads
   * arriving.
   */
  async function handleInvite(
    id: string,
    email: string,
    product: "management" | "guaranteed_rent"
  ) {
    setBusyId(id);
    setToast(null);
    const productLabel =
      product === "guaranteed_rent" ? "Guaranteed Rent" : "Management";
    try {
      const res = await fetch(`/api/admin/customers/${id}/invite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product }),
      });
      const data = await res.json();
      if (!res.ok) {
        setToast(data.error ?? "Could not send invitation.");
        return;
      }
      // Only a management invite moves account_status — 'invited' is a
      // management-only state, and the GR route deliberately leaves it alone.
      if (product === "management") {
        setStatusOverride((s) => ({ ...s, [id]: "invited" }));
      }
      // Capacity is non-blocking: the invite always succeeds, but flag it when
      // this customer would push weighted usage over the limit.
      setToast(
        data.capacityWarning && data.warningMessage
          ? `${productLabel} invitation sent to ${email}. ${data.warningMessage}`
          : `${productLabel} invitation sent to ${email}`
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
              <TableHead>Credits / received</TableHead>
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
              const filters = activeLeadFilters(c);
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
                      {isPaused(c) && (
                        <span
                          title={
                            c.pause_resumes_at
                              ? `Subscription paused · resumes ${formatDate(c.pause_resumes_at)}`
                              : "Subscription paused"
                          }
                          className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700"
                        >
                          <Pause className="h-3 w-3" />
                          Paused
                        </span>
                      )}
                    </span>
                    {/* What they actually filtered for. The badge alone said a
                        filter existed but not what it excluded, so judging why a
                        customer is starved of leads meant opening their page. */}
                    {filters.map((f) => (
                      <span
                        key={f.leadType}
                        title={filterTooltip(f)}
                        className="mt-0.5 block text-xs font-normal text-muted-foreground"
                      >
                        {filters.length > 1 && (
                          <span className="font-medium">
                            {f.leadType === "guaranteed_rent" ? "GR" : "Mgmt"}:{" "}
                          </span>
                        )}
                        {filterSummary(f)}
                        {f.status === "pending_lift" && (
                          <span className="text-amber-700">
                            {" "}
                            · lifting
                            {f.liftDate ? ` ${formatDate(f.liftDate)}` : ""}
                          </span>
                        )}
                      </span>
                    ))}
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
                  {/*
                    Billing, credits and pacing are all per product. Showing only
                    the management columns reported a GR-only subscriber as
                    inactive with zero credits — the figures for the product they
                    actually pay for were nowhere on the page.
                  */}
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {showsManagement(c) && (
                        <Badge
                          variant={
                            c.subscription_status === "active" ? "brand" : "muted"
                          }
                        >
                          Mgmt {c.subscription_status}
                        </Badge>
                      )}
                      {showsGr(c) && (
                        <Badge
                          variant={
                            c.gr_subscription_status === "active"
                              ? "brand"
                              : "muted"
                          }
                        >
                          GR {c.gr_subscription_status}
                        </Badge>
                      )}
                      {!showsManagement(c) && !showsGr(c) && (
                        <Badge variant="muted">{c.subscription_status}</Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="space-y-0.5">
                      {(showsManagement(c) || !showsGr(c)) && (
                        <CreditLine
                          label={showsGr(c) ? "Mgmt" : null}
                          balance={c.lead_balance}
                          received={c.leads_received_this_month}
                          allocation={c.monthly_allocation}
                        />
                      )}
                      {showsGr(c) && (
                        <CreditLine
                          label="GR"
                          balance={c.gr_lead_balance}
                          received={c.gr_leads_received_this_month}
                          allocation={c.gr_monthly_allocation}
                        />
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {(showsManagement(c) || !showsGr(c)) && (
                        <PacingBadge status={pacing.status} />
                      )}
                      {showsGr(c) && (
                        <PacingBadge status={computeGrPacing(c).status} />
                      )}
                    </div>
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
                          onClick={() =>
                            handleInvite(c.id, c.email, "management")
                          }
                          disabled={busyId === c.id}
                          className="text-sm font-medium text-[#5D8156] hover:underline disabled:opacity-50"
                        >
                          Invite: Management
                        </button>
                      )}
                      {/*
                        Offered independently of account_status. A GR invite is
                        valid both for a waitlisted prospect and for an existing
                        management subscriber adding the second product — the
                        only disqualifier is already holding GR.
                      */}
                      {!hasGuaranteedRent(c) && (
                        <button
                          onClick={() =>
                            handleInvite(c.id, c.email, "guaranteed_rent")
                          }
                          disabled={busyId === c.id}
                          className="text-sm font-medium text-[#5D8156] hover:underline disabled:opacity-50"
                        >
                          Invite: Guaranteed Rent
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

/**
 * One product's credit balance and cycle progress. `label` is omitted when the
 * customer holds a single product, so the common one-product row reads exactly
 * as it always has.
 */
function CreditLine({
  label,
  balance,
  received,
  allocation,
}: {
  label: string | null;
  balance: number;
  received: number;
  allocation: number;
}) {
  return (
    <div className="whitespace-nowrap">
      {label && (
        <span className="mr-1 text-xs font-medium text-muted-foreground">
          {label}
        </span>
      )}
      <span
        className={
          balance <= 0
            ? "font-medium text-amber-700"
            : "font-medium text-foreground"
        }
      >
        {balance} credit{balance === 1 ? "" : "s"}
      </span>
      <span className="ml-1 text-xs text-muted-foreground">
        · {received}/{allocation} this cycle
      </span>
    </div>
  );
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
