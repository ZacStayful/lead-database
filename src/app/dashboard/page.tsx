import { redirect } from "next/navigation";
import Link from "next/link";
import { Plus } from "lucide-react";
import { viewerScopedLead } from "@/lib/customerLeads";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LeadFeed } from "@/components/dashboard/LeadFeed";
import { NeedsAttention } from "@/components/dashboard/NeedsAttention";
import { TodayPanel } from "@/components/dashboard/TodayPanel";
import { ExportButton } from "@/components/dashboard/ExportButton";
import { AnnouncementBanner } from "@/components/dashboard/AnnouncementBanner";
import { CompanyLetAgreement } from "@/components/dashboard/CompanyLetAgreement";
import { StatCards, type StatCard } from "@/components/home/StatCards";
import { PipelineFunnelCard } from "@/components/home/PipelineFunnelCard";
import { RecentConversations } from "@/components/home/RecentConversations";
import { FollowUpTasks, type FollowUpTask } from "@/components/home/FollowUpTasks";
import { IncomeAcrossWonCard } from "@/components/home/IncomeAcrossWonCard";
import { GoalCardWidget } from "@/components/home/GoalCardWidget";
import { LeadSourcesCard } from "@/components/home/LeadSourcesCard";
import { computeWorkSummary } from "@/lib/workSummary";
import { buildTodayLines, workingDayStreak } from "@/lib/todaySummary";
import { fetchDueAttempts } from "@/lib/contact/dueAttempts";
import { describeChannels, summariseDay } from "@/lib/contact/followUpSummary";
import { fetchInboxRows } from "@/lib/messaging/inbox";
import { fetchBannerAnnouncement, paragraphs } from "@/lib/announcements";
import { buildFunnel } from "@/lib/home/pipelineFunnel";
import { firstNameOf, greeting, greetingSubtitle } from "@/lib/home/greeting";
import { buildLeadSources } from "@/lib/home/leadSources";
import { buildIncomeAcrossWon } from "@/lib/home/incomeAcrossWon";
import { buildGoalCard } from "@/lib/home/goalCard";
import { ENGAGEMENT_EVENT_TYPES } from "@/lib/types";
import { formatDate } from "@/lib/utils";
import { cityForArea } from "@/lib/postcode";
import {
  RELEASE_SETTING_KEYS,
  computeGrPacing,
  computePacing,
  londonDate,
  pacingMessage,
  poolDebitExplanation,
  releaseSchedule,
  releaseSettingsFrom,
  type Pacing,
} from "@/lib/pacing";
import type { AssignmentWithLead, Customer, LeadType } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * The dashboard home (§56.7). Every figure comes from data the page already
 * loaded before the redesign; the two additions are the inbox rows (for
 * Recent conversations and the reply preview on Follow-up tasks) and the
 * per-product won count the funnel needs. Nothing here is windowed except
 * Lead sources, which says so on its card.
 */
export default async function DashboardPage() {
  const { user, customer } = await getCurrentCustomer();
  if (!user) redirect("/login");

  if (!customer) {
    return (
      <div className="mx-auto max-w-lg text-center">
        <Card>
          <CardContent className="pt-8">
            <h1 className="text-lg font-semibold">Finishing setup…</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              We couldn’t find your customer record yet. If you’ve just paid,
              give it a moment and refresh. Otherwise complete your subscription
              to start receiving leads.
            </p>
            <Button className="mt-6" asChild>
              <Link href="/signup">Complete subscription</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const admin = createAdminClient();
  const { data: assignmentsRaw } = await admin
    .from("lead_assignments")
    .select("*, lead:leads(*)")
    .eq("customer_id", customer.id)
    .order("assigned_at", { ascending: false });

  // Scope each lead to this viewer before it reaches the client: a lead sold
  // on from another operator carries THEIR customer id, which is not the
  // buyer's to see (§32).
  const assignments = ((assignmentsRaw ?? []) as AssignmentWithLead[]).map((a) => ({
    ...a,
    lead: viewerScopedLead(a.lead, customer.id),
  })) as AssignmentWithLead[];

  const banner = await fetchBannerAnnouncement(admin, customer);

  const isActive = customer.subscription_status === "active";
  const hasGuaranteedRent = customer.gr_subscription_status === "active";
  const renewalDate = nextRenewalDate(customer.billing_cycle_anchor);
  const pacing = computePacing(customer);
  const grPacing = computeGrPacing(customer);
  const managementDebitNote = isActive
    ? poolDebitExplanation(pacing.effectiveAllocation, pacing.poolDebit)
    : null;
  const grDebitNote = hasGuaranteedRent
    ? poolDebitExplanation(grPacing.effectiveAllocation, grPacing.poolDebit)
    : null;
  const filterActive =
    customer.filter_status === "active" || customer.filter_status === "pending_lift";

  const grReceived = assignments.filter((a) => a.lead?.lead_type === "guaranteed_rent").length;
  const managementReceived = assignments.length - grReceived;
  const hasManagement = isActive || managementReceived > 0;
  const hasGr = hasGuaranteedRent || grReceived > 0;

  const workSummary = computeWorkSummary(assignments);
  const now = new Date();
  const today = londonDate(now);
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 86_400_000).toISOString();

  // Six reads in parallel, all scoped to this customer. The due-attempt scan
  // is the SAME query the 08:15 email runs (fetchDueAttempts), so the card
  // and the inbox never disagree.
  const [releaseRows, dueScan, inbox, poolMgmt, poolGr, eventRows] = await Promise.all([
    admin.from("system_settings").select("key, value").in("key", [...RELEASE_SETTING_KEYS]),
    fetchDueAttempts(admin, { customerId: customer.id, now }),
    fetchInboxRows(admin, customer.id),
    isActive
      ? admin.rpc("get_customer_pool_leads", { p_customer_id: customer.id, p_lead_type: "management" })
      : Promise.resolve({ data: [] as unknown[] }),
    hasGuaranteedRent
      ? admin.rpc("get_customer_pool_leads", { p_customer_id: customer.id, p_lead_type: "guaranteed_rent" })
      : Promise.resolve({ data: [] as unknown[] }),
    admin
      .from("lead_events")
      .select("created_at, lead_assignments!inner(customer_id)")
      .eq("lead_assignments.customer_id", customer.id)
      .in("event_type", [...ENGAGEMENT_EVENT_TYPES])
      .gte("created_at", sixtyDaysAgo)
      .limit(5000),
  ]);
  const releaseSettings = releaseSettingsFrom(
    (releaseRows.data ?? []) as { key: string; value: string }[]
  );
  const arrivedToday = (a: AssignmentWithLead) => londonDate(new Date(a.assigned_at)) === today;
  const marketplaceToday = assignments.filter((a) => !a.lead?.owner_customer_id && arrivedToday(a));
  const receivedTodayFor = (lt: LeadType) =>
    assignments.filter((a) => (a.lead?.lead_type ?? "management") === lt && arrivedToday(a)).length;
  const schedules = [
    ...(isActive
      ? [{
          label: hasGuaranteedRent ? "Management" : null,
          schedule: releaseSchedule(customer, "management", receivedTodayFor("management"), releaseSettings, now),
        }]
      : []),
    ...(hasGuaranteedRent
      ? [{
          label: isActive ? "Guaranteed Rent" : null,
          schedule: releaseSchedule(customer, "guaranteed_rent", receivedTodayFor("guaranteed_rent"), releaseSettings, now),
        }]
      : []),
  ];
  const inboxRows = inbox.rows;
  const unreadReplies = inboxRows.reduce((n, r) => n + r.unread, 0);
  const activeDays = ((eventRows.data ?? []) as unknown as { created_at: string }[]).map((e) =>
    londonDate(new Date(e.created_at))
  );
  const dueAttempts = dueScan.byCustomer.get(customer.id) ?? [];
  const dueSummary = summariseDay(dueAttempts);
  const todayLines = buildTodayLines({
    today,
    newLeadsToday: marketplaceToday.length,
    schedules,
    dueFollowUps: dueSummary,
    dueTodayCallbacks: workSummary.dueTodayCallbacks,
    overdueCallbacks: workSummary.overdueCallbacks,
    unreadReplies,
    poolLeads: ((poolMgmt.data ?? []) as unknown[]).length + ((poolGr.data ?? []) as unknown[]).length,
    streakDays: workingDayStreak(activeDays, today),
  });
  // The greeting takes the two "today" lines; the panel keeps the rest.
  const otherLines = todayLines.filter((l) => l.key !== "new_leads" && l.key !== "next_lead");

  // ── Stat cards ────────────────────────────────────────────────────────
  const uncontacted = assignments.filter((a) => a.status === "new").length;
  const cards: StatCard[] = [];
  if (isActive || (!hasGr && !isActive)) {
    cards.push(balanceCard("management", customer, hasGr ? "Management balance" : "Lead balance", renewalDate));
  }
  if (hasGuaranteedRent) {
    cards.push(
      balanceCard("guaranteed_rent", customer, "Guaranteed Rent balance", nextRenewalDate(customer.gr_billing_cycle_anchor))
    );
  }
  if (hasManagement) {
    cards.push(thisMonthCard("management", customer, pacing, hasGr ? "Management this month" : "Leads this month", filterActive, renewalDate));
  }
  if (hasGuaranteedRent) {
    cards.push(thisMonthCard("guaranteed_rent", customer, grPacing, "Guaranteed Rent this month", false, null));
  }
  cards.push({
    key: "attention",
    label: "Needs attention",
    value: String(uncontacted),
    unit: "uncontacted",
    caption: [
      `${marketplaceToday.length} arrived today`,
      workSummary.overdueCallbacks > 0
        ? `${workSummary.overdueCallbacks} callback${workSummary.overdueCallbacks === 1 ? "" : "s"} past ${workSummary.overdueCallbacks === 1 ? "its" : "their"} date`
        : null,
    ]
      .filter(Boolean)
      .join(" · "),
    trailing: "attention",
    href: "/dashboard/leads?activity=new",
  });
  cards.push({
    key: "followups",
    label: "Follow-ups due",
    value: String(dueSummary.total),
    unit: "today",
    caption:
      dueSummary.total > 0
        ? `About ${dueSummary.minutes} minute${dueSummary.minutes === 1 ? "" : "s"} · ${describeChannels(dueSummary)}`
        : "Nothing due today",
    trailing: "clock",
    href: "#follow-up-tasks",
  });

  // ── Widgets ───────────────────────────────────────────────────────────
  const funnels = [
    ...(hasManagement ? [buildFunnel(assignments, "management")] : []),
    ...(hasGr ? [buildFunnel(assignments, "guaranteed_rent")] : []),
  ].filter((f) => f.received > 0);

  const replyByAssignment = new Map(
    inboxRows
      .filter((r) => r.preview.kind === "message" && r.preview.direction === "inbound")
      .map((r) => [r.assignmentId, r.preview.text] as const)
  );
  const tasks: FollowUpTask[] = dueAttempts
    .slice()
    .sort((x, y) => y.overdueDays - x.overdueDays)
    .map((a) => ({ ...a, lastReply: replyByAssignment.get(a.assignmentId) ?? null }));

  const income = buildIncomeAcrossWon(assignments);
  const goalWon = assignments.filter(
    (a) =>
      a.status === "won" &&
      (a.lead?.lead_type ?? "management") === "management" &&
      a.lead?.owner_customer_id !== customer.id
  ).length;
  const goal = isActive
    ? buildGoalCard(customer.management_customer_goal, customer.management_customer_goal_due ?? null, goalWon, today)
    : null;
  const sources = buildLeadSources(assignments, now);

  return (
    <div className="space-y-3.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-[-0.01em] text-ink">
            {greeting(now, firstNameOf(customer.contact_name))}
          </h1>
          <p className="text-ink-2">{greetingSubtitle(today, todayLines)}</p>
        </div>
        <div className="flex items-center gap-2">
          <ExportButton />
          <Button asChild className="h-[38px] rounded-lg bg-brand font-semibold text-white hover:bg-brand-dark">
            <Link href="/dashboard/leads/add">
              <Plus className="mr-1.5 h-4 w-4" />
              Add your own leads
            </Link>
          </Button>
        </div>
      </div>

      {banner && (
        <AnnouncementBanner
          id={banner.id}
          title={banner.title}
          paragraphs={paragraphs(banner.body_text)}
          linkUrl={banner.link_url}
          linkLabel={banner.link_label}
        />
      )}

      <StatCards cards={cards} />

      {(managementDebitNote || grDebitNote) && (
        <div className="space-y-1 text-sm text-ink-2">
          {managementDebitNote && <p>{managementDebitNote}</p>}
          {grDebitNote && <p>Guaranteed rent: {grDebitNote}</p>}
        </div>
      )}

      <div className="grid gap-3.5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))" }}>
        <PipelineFunnelCard funnels={funnels} />
        <RecentConversations rows={inboxRows} now={now} />
      </div>

      <div className="grid gap-3.5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
        <FollowUpTasks tasks={tasks} />
        {income && <IncomeAcrossWonCard data={income} />}
        {goal && <GoalCardWidget goal={goal} />}
        <LeadSourcesCard rows={sources} />
        <TodayPanel lines={otherLines} />
        <NeedsAttention summary={workSummary} />
      </div>

      {hasGuaranteedRent && <CompanyLetAgreement compact />}

      <div className="pt-2">
        <h2 className="mb-3 text-lg font-semibold">Your leads</h2>
        <LeadFeed customerId={customer.id} assignments={assignments} />
      </div>
    </div>
  );
}

function balanceCard(product: LeadType, customer: Customer, label: string, renews: string): StatCard {
  const balance = product === "management" ? customer.lead_balance : customer.gr_lead_balance;
  const allocation = product === "management" ? customer.monthly_allocation : customer.gr_monthly_allocation;
  const carried = balance - allocation;
  return {
    key: `balance:${product}`,
    label,
    value: String(balance),
    unit: balance === 1 ? "credit" : "credits",
    caption: `${carried > 0 ? `Includes ${carried} carried forward · ` : ""}renews ${renews}`,
    trailing: "credit",
    valueTone: balance === 0 ? "amber" : undefined,
  };
}

function thisMonthCard(
  product: LeadType,
  customer: Customer,
  pacing: Pacing,
  label: string,
  filterActive: boolean,
  renewalDate: string | null
): StatCard {
  const received =
    product === "management" ? customer.leads_received_this_month : customer.gr_leads_received_this_month;
  const allocation = pacing.effectiveAllocation;
  const pill =
    pacing.status === "behind"
      ? { pill: "Behind", tone: "amber" as const }
      : pacing.status === "ahead"
        ? { pill: "Ahead", tone: "grey" as const }
        : { pill: "On track", tone: "green" as const };
  const balance = product === "management" ? customer.lead_balance : customer.gr_lead_balance;
  const caption =
    product === "management" && filterActive
      ? filterMessage(customer)
      : balance === 0 && renewalDate
        ? `No lead credit left. Your balance updates when your next payment is processed on ${renewalDate}.`
        : pacingMessage(pacing.deficit, pacing.effectiveAllocation);
  return {
    key: `month:${product}`,
    label,
    value: String(received),
    unit: `of ${allocation}`,
    progressPct: allocation > 0 ? (received / allocation) * 100 : 0,
    trailing: pill,
    caption,
  };
}

/** Dashboard sentence shown to a customer with an active/pending-lift filter. */
function filterMessage(customer: Customer): string {
  const areas =
    customer.filter_areas && customer.filter_areas.length > 0
      ? customer.filter_areas.map((a) => cityForArea(a) || a).join(", ")
      : "any location";
  const beds = bedroomPhrase(customer.filter_min_bedrooms, customer.filter_max_bedrooms);
  // "At least", and no clause about what happens if we fall short: the figure
  // is a lower bound at FORECAST_CONFIDENCE and nothing is credited back.
  const expected = customer.filter_expected_leads;
  const likelihood = customer.filter_forecast_likelihood_pct;
  let msg = `Your filter is active — you'll receive leads matching ${areas} and ${beds} as they become available.`;
  msg +=
    expected != null && expected > 0
      ? ` You can expect at least ${expected} lead${expected === 1 ? "" : "s"} a month on this filter${likelihood != null ? ` (${likelihood}% likely)` : ""} — some months will be quieter than others.`
      : ` Volume varies based on how many matching leads come through the marketplace each month.`;
  if (customer.filter_status === "pending_lift" && customer.filter_lift_effective_date) {
    msg += ` Your filter is scheduled to lift on ${formatDate(customer.filter_lift_effective_date)}.`;
  }
  return msg;
}

function bedroomPhrase(min: number | null, max: number | null): string {
  if (min == null && max == null) return "any bedroom size";
  if (min != null && max != null) {
    return min === max ? `exactly ${min} bedroom${min === 1 ? "" : "s"}` : `${min}–${max} bedrooms`;
  }
  if (min != null) return `${min}+ bedrooms`;
  return `up to ${max} bedrooms`;
}

function nextRenewalDate(anchor: string | null): string {
  // The anchor is re-set to the current period start on every invoice.paid,
  // so the next renewal is one month after it. Fall back to the 1st of next
  // month for accounts with no Stripe billing anchor yet.
  if (anchor) {
    const a = new Date(anchor);
    if (!isNaN(a.getTime())) {
      const next = new Date(a);
      next.setMonth(next.getMonth() + 1);
      return formatDate(next.toISOString());
    }
  }
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return formatDate(next.toISOString());
}
