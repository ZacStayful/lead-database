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
import type { Customer, PauseEpisode } from "@/lib/types";
import {
  PAUSE_BANDS,
  PAUSE_BAND_LABEL,
  pauseOutlook,
  type BillingHealth,
  type PauseBand,
  type PauseFacts,
} from "@/lib/pauseOutlook";
import { pauseMonthsLabel, pauseReasonLabel } from "@/lib/pauseOptions";

type Tab =
  | "all"
  | "active"
  | "paused"
  | "waitlisted"
  | "invited"
  | "cancelled"
  | "archived";

const TABS: { key: Tab; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "paused", label: "Paused" },
  { key: "waitlisted", label: "Waitlisted" },
  { key: "invited", label: "Invited" },
  { key: "cancelled", label: "Cancelled" },
  { key: "archived", label: "Archived" },
];

/**
 * Secondary filter on the Paused tab: is this customer coming back?
 *
 * Mirrors the PRODUCT_TABS pattern below. "all" first so the tab opens showing
 * everyone rather than a pre-filtered view.
 */
type BandFilter = "all" | PauseBand;

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

// A management subscriber whose subscription is currently paused.
//
// account_status stays 'active' during a pause (0038), so these customers still
// appear under the Active tab — they ARE active customers whose routing slot is
// reserved. The Paused tab added in 0077 is an additional lens on the same rows,
// not a relocation, so no existing tab changes meaning.
const isPaused = (c: Customer) => Boolean(c.paused_at);

// A customer with an active or pending-lift filter on either product.
const hasFilter = hasLeadFilter;

/** Band a paused customer from whatever detail we managed to load. */
function outlookFor(
  c: Customer,
  pauseDetail: Record<string, PauseEpisode>,
  pauseFacts: Record<string, PauseFacts>,
  billingHealth: Record<string, BillingHealth>
) {
  return pauseOutlook(
    pauseDetail[c.id]?.reasons ?? [],
    pauseFacts[c.id],
    billingHealth[c.id]
  );
}

const BAND_BADGE: Record<PauseBand, string> = {
  likely: "border-transparent bg-green-100 text-green-700",
  unlikely: "border-transparent bg-amber-100 text-amber-700",
  not_returning: "border-transparent bg-red-100 text-red-700",
  unclear: "border-transparent bg-gray-100 text-gray-600",
};

const ACCOUNT_BADGE: Record<string, string> = {
  active: "border-transparent bg-green-100 text-green-700",
  invited: "border-transparent bg-amber-100 text-amber-700",
  waitlisted: "border-transparent bg-gray-100 text-gray-600",
  cancelled: "border-transparent bg-red-100 text-red-700",
};

export function AdminCustomersTable({
  customers,
  lastActive = {},
  pauseDetail = {},
  pauseFacts = {},
  billingHealth = {},
}: {
  customers: Customer[];
  /** customer.id → last sign-in timestamp (null = has login, never signed in). */
  lastActive?: Record<string, string | null>;
  /** customer.id → their current pause episode (0077). Paused customers only. */
  pauseDetail?: Record<string, PauseEpisode>;
  /** customer.id → the facts behind their return-likelihood band. */
  pauseFacts?: Record<string, PauseFacts>;
  /** customer.id → what Stripe says about whether they will bill again. */
  billingHealth?: Record<string, BillingHealth>;
}) {
  const [tab, setTab] = useState<Tab>("all");
  const [product, setProduct] = useState<ProductTab>("all");
  const [band, setBand] = useState<BandFilter>("all");
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
    // "paused" is not an account_status, so it can never match the comparison
    // below — it joins "all" and "archived" as a pass-through and filters itself.
    list = list.filter((c) =>
      tab === "all" || tab === "archived"
        ? true
        : tab === "paused"
          ? isPaused(c)
          : accountStatus(c) === tab
    );
    if (tab === "paused" && band !== "all") {
      list = list.filter(
        (c) =>
          outlookFor(c, pauseDetail, pauseFacts, billingHealth).band === band
      );
    }
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
  }, [customers, tab, product, band, statusOverride, pauseDetail, pauseFacts, billingHealth]);

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

      {tab === "paused" && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="mr-2 text-xs font-medium text-muted-foreground">
            Coming back?
          </span>
          {(["all", ...PAUSE_BANDS] as BandFilter[]).map((b) => (
            <button
              key={b}
              onClick={() => setBand(b)}
              className={
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors " +
                (band === b
                  ? "bg-brand text-brand-foreground"
                  : "text-muted-foreground hover:bg-accent")
              }
            >
              {b === "all" ? "All" : PAUSE_BAND_LABEL[b]}
            </button>
          ))}
        </div>
      )}

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
              {tab === "paused" && <TableHead>Pause detail</TableHead>}
              {tab === "paused" && <TableHead>Will it re-bill?</TableHead>}
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
                  {tab === "paused" && (
                    <TableCell className="max-w-[22rem] align-top">
                      <PauseDetailCell
                        customer={c}
                        episode={pauseDetail[c.id]}
                        outlook={outlookFor(
                          c,
                          pauseDetail,
                          pauseFacts,
                          billingHealth
                        )}
                      />
                    </TableCell>
                  )}
                  {tab === "paused" && (
                    <TableCell className="max-w-[14rem] align-top">
                      <BillingHealthCell health={billingHealth[c.id]} />
                    </TableCell>
                  )}
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
                  colSpan={tab === "paused" ? 12 : 10}
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

/**
 * Why this customer paused, and whether we think they are coming back.
 *
 * The band ALWAYS renders with its supporting reason. A rules-based verdict the
 * admin cannot audit is indistinguishable from a guess, and these rules are
 * stated guesses — there is no cancellation history to fit them to.
 */
function PauseDetailCell({
  customer,
  episode,
  outlook,
}: {
  customer: Customer;
  episode: PauseEpisode | undefined;
  outlook: { band: PauseBand; reason: string };
}) {
  return (
    <div className="space-y-1.5 py-1">
      <span
        className={
          "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium " +
          BAND_BADGE[outlook.band]
        }
      >
        {PAUSE_BAND_LABEL[outlook.band]}
      </span>
      <p className="text-xs text-muted-foreground">{outlook.reason}</p>

      {episode ? (
        <>
          <p className="text-xs">
            {episode.reasons.map(pauseReasonLabel).join(" · ")}
          </p>
          {episode.note && (
            <p className="whitespace-pre-wrap text-xs italic text-muted-foreground">
              “{episode.note}”
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            {pauseMonthsLabel(episode.months)} from{" "}
            {formatDate(episode.paused_at)} · resumes{" "}
            {formatDate(episode.resumes_at)} · pause #{customer.pause_count}
          </p>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          No pause record{" "}
          {customer.pause_resumes_at
            ? `· resumes ${formatDate(customer.pause_resumes_at)}`
            : ""}
        </p>
      )}
    </div>
  );
}

/**
 * Whether Stripe will actually bill this subscription again when the pause ends.
 *
 * Read live from Stripe rather than from our own columns: a scheduled
 * cancellation leaves the subscription "active" in Stripe, so our
 * subscription_status says active and cancel_at_period_end is stored nowhere.
 * An unreachable Stripe renders as "couldn't check" and never as healthy.
 */
function BillingHealthCell({ health }: { health: BillingHealth | undefined }) {
  if (!health) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  if (health.willBill === null) {
    return (
      <div className="py-1">
        <span className="inline-flex items-center rounded-full border border-transparent bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
          Couldn&apos;t check
        </span>
        {health.error && (
          <p className="mt-1 text-xs text-muted-foreground">{health.error}</p>
        )}
      </div>
    );
  }
  if (health.cancelled) {
    return (
      <span className="inline-flex items-center rounded-full border border-transparent bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
        Subscription cancelled
      </span>
    );
  }
  if (health.cancelAtPeriodEnd) {
    return (
      <div className="py-1">
        <span className="inline-flex items-center rounded-full border border-transparent bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
          Cancels at period end
        </span>
        <p className="mt-1 text-xs text-muted-foreground">
          Will not re-bill when the pause ends.
        </p>
      </div>
    );
  }
  return (
    <div className="py-1">
      <span className="inline-flex items-center rounded-full border border-transparent bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
        Will re-bill
      </span>
      {health.nextChargeAt && (
        <p className="mt-1 text-xs text-muted-foreground">
          Next charge {formatDate(health.nextChargeAt)}
        </p>
      )}
    </div>
  );
}
