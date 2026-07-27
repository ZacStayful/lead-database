import { redirect } from "next/navigation";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  EngagementBenchmarks,
  type BenchmarkRow,
} from "@/components/dashboard/EngagementBenchmarks";
import { Card, CardContent } from "@/components/ui/card";
import { PrintButton } from "@/components/dashboard/PrintButton";
import {
  stagesForLeadType,
  pipelineBadgeClass,
} from "@/components/dashboard/pipelineStage";
import { formatDate, formatGBP } from "@/lib/utils";
import type { LeadType } from "@/lib/types";

export const dynamic = "force-dynamic";

const STATUS_ORDER: { key: string; label: string }[] = [
  { key: "new", label: "New" },
  { key: "contacted", label: "Contacted" },
  { key: "in_discussion", label: "In discussion" },
  { key: "won", label: "Won" },
  { key: "not_relevant", label: "Not relevant" },
  { key: "rejected", label: "Rejected" },
];

/** Same wording as the benchmarks block, so one page uses one set of names. */
const PRODUCT_LABEL: Record<LeadType, string> = {
  management: "Management",
  guaranteed_rent: "Guaranteed Rent",
};

/**
 * The two products run different pipelines: management ends at a web meeting
 * or the terminal `won` stage (0050), guaranteed rent at a signed contract.
 * Counting them together produced a funnel that was wrong for both — and a
 * "Won" figure that disagreed with the Goals page, which has always been
 * management-only.
 *
 * Main's 0050 branch fixed the GR half of this by concatenating both stage
 * lists into a single funnel. That is superseded here: one funnel still mixes
 * the two products' totals, win rates and income, which is the part that made
 * the numbers disagree. A block per product fixes both halves.
 */
const PRODUCTS: LeadType[] = ["management", "guaranteed_rent"];

type AnalyticsAssignment = {
  status: string;
  pipeline_stage: string;
  viewed_at: string | null;
  income_estimate: number | null;
  lead: { lead_type: LeadType } | null;
};

export default async function AnalyticsPage() {
  const { user, customer } = await getCurrentCustomer();
  if (!user) redirect("/login");
  if (!customer) redirect("/dashboard");

  const admin = createAdminClient();

  // lead_assignments carries no lead_type of its own, so the product has to
  // come from the joined lead.
  const { data: rows } = await admin
    .from("lead_assignments")
    .select(
      "status, pipeline_stage, viewed_at, income_estimate, lead:leads(lead_type)"
    )
    .eq("customer_id", customer.id);

  // supabase-js types a to-one embed as an array even though PostgREST returns
  // a single object, which is why the rest of the dashboard reads
  // `a.lead?.lead_type` directly. Same runtime shape, so the cast goes through
  // unknown rather than reshaping the data.
  const assignments = (rows ?? []) as unknown as AnalyticsAssignment[];

  // Cohort benchmarks. Called through the customer's OWN session, not the
  // admin client: get_engagement_benchmarks derives identity from auth.uid()
  // and returns aggregates only, so the service role would gain nothing and
  // calling it as the user keeps the security boundary where it belongs.
  const userClient = createClient();
  const { data: benchmarkRaw } = await userClient.rpc(
    "get_engagement_benchmarks"
  );
  const benchmarkRows = (benchmarkRaw ?? []) as BenchmarkRow[];

  const { data: telemetrySetting } = await admin
    .from("system_settings")
    .select("value")
    .eq("key", "telemetry_from")
    .maybeSingle();
  const telemetryFrom =
    (telemetrySetting as { value?: string } | null)?.value ?? null;

  // Notes + files are recorded against an assignment, not a product, and are
  // reported at account level rather than split.
  const { count: notesCount } = await admin
    .from("lead_notes")
    .select("id", { count: "exact", head: true })
    .eq("customer_id", customer.id);
  const { count: filesCount } = await admin
    .from("lead_files")
    .select("id", { count: "exact", head: true })
    .eq("customer_id", customer.id);

  // Show a product's section when the customer holds it OR has ever been sent
  // one of its leads — so a cancelled subscription doesn't hide the history it
  // produced. A customer with neither still sees their management section, so
  // the page is never blank.
  const holds: Record<LeadType, boolean> = {
    management: customer.subscription_status === "active",
    guaranteed_rent: customer.gr_subscription_status === "active",
  };
  const byProduct = (product: LeadType) =>
    assignments.filter((a) => (a.lead?.lead_type ?? "management") === product);

  const visible = PRODUCTS.filter(
    (p) => holds[p] || byProduct(p).length > 0
  );
  const products = visible.length > 0 ? visible : (["management"] as LeadType[]);
  const showProductLabels = products.length > 1;

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Your lead analytics</h1>
          <p className="text-sm text-muted-foreground">
            {customer.business_name} · {formatDate(new Date().toISOString())}
          </p>
        </div>
        <PrintButton />
      </div>

      {products.map((product) => (
        <ProductAnalytics
          key={product}
          product={product}
          assignments={byProduct(product)}
          showLabel={showProductLabels}
        />
      ))}

      {/* Account-level activity: not attributable to one product. */}
      <Card>
        <CardContent className="pt-6">
          <h2 className="mb-4 text-lg font-semibold">Your record keeping</h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Metric label="Notes logged" value={notesCount ?? 0} />
            <Metric label="Files uploaded" value={filesCount ?? 0} />
          </div>
        </CardContent>
      </Card>

      {/* Cohort comparison — below the funnels, as the last block on the page:
          it is context for everything above it, not a headline. */}
      <EngagementBenchmarks rows={benchmarkRows} telemetryFrom={telemetryFrom} />
    </div>
  );
}

/** Every figure for one product, computed only from that product's leads. */
function ProductAnalytics({
  product,
  assignments,
  showLabel,
}: {
  product: LeadType;
  assignments: AnalyticsAssignment[];
  showLabel: boolean;
}) {
  const total = assignments.length;
  const pct = (n: number) => (total ? Math.round((n / total) * 100) : 0);

  const statusCounts = new Map<string, number>();
  const pipelineCounts = new Map<string, number>();
  for (const a of assignments) {
    statusCounts.set(a.status, (statusCounts.get(a.status) ?? 0) + 1);
    pipelineCounts.set(
      a.pipeline_stage,
      (pipelineCounts.get(a.pipeline_stage) ?? 0) + 1
    );
  }

  const won = statusCounts.get("won") ?? 0;
  const winRate = pct(won);
  const contacted = assignments.filter((a) => a.status !== "new").length;

  // The two pipelines converge on different things, so the "did they get in
  // front of the landlord" metric is not the same stage in each.
  const meetingStages =
    product === "guaranteed_rent"
      ? ["viewing_booked", "contract_sent", "contract_signed"]
      : ["web_meeting_booked", "web_meeting_no_show", "web_meeting_attended"];
  const meetingsBooked = assignments.filter((a) =>
    meetingStages.includes(a.pipeline_stage)
  ).length;
  const attendedStage =
    product === "guaranteed_rent" ? "contract_signed" : "web_meeting_attended";
  const meetingsAttended = pipelineCounts.get(attendedStage) ?? 0;

  const sumIncome = (rows: AnalyticsAssignment[]) =>
    rows.reduce((s, a) => s + (a.income_estimate ?? 0), 0);
  const totalIncome = sumIncome(assignments);
  const wonIncome = sumIncome(assignments.filter((a) => a.status === "won"));
  const pipelineIncome = sumIncome(
    assignments.filter((a) =>
      ["new", "contacted", "in_discussion"].includes(a.status)
    )
  );

  const stats = [
    { label: "Total leads", value: String(total) },
    { label: "Won", value: String(won) },
    { label: "Win rate", value: `${winRate}%` },
  ];

  return (
    <section className="space-y-4">
      {showLabel && (
        <h2 className="text-lg font-semibold">{PRODUCT_LABEL[product]}</h2>
      )}

      {total === 0 ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            No {PRODUCT_LABEL[product].toLowerCase()} leads yet. Your figures
            will appear here once the first one arrives.
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            {stats.map((s) => (
              <Card key={s.label}>
                <CardContent className="pt-6">
                  <p className="text-sm text-muted-foreground">{s.label}</p>
                  <p className="mt-1 text-3xl font-semibold">{s.value}</p>
                </CardContent>
              </Card>
            ))}
          </div>

          <Card>
            <CardContent className="pt-6">
              <h3 className="mb-1 text-base font-semibold">
                Lead status funnel
              </h3>
              <p className="mb-4 text-sm text-muted-foreground">
                Where your {total} lead{total === 1 ? "" : "s"} sit across the
                funnel.
              </p>
              <div className="space-y-3">
                {STATUS_ORDER.map((s) => {
                  const n = statusCounts.get(s.key) ?? 0;
                  return (
                    <FunnelRow key={s.key} label={s.label} n={n} pct={pct(n)} />
                  );
                })}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <h3 className="mb-1 text-base font-semibold">Pipeline stages</h3>
              <p className="mb-4 text-sm text-muted-foreground">
                Your own pipeline activity across every lead.
              </p>
              <div className="space-y-3">
                {stagesForLeadType(product).map((s) => {
                  const n = pipelineCounts.get(s.value) ?? 0;
                  return (
                    <FunnelRow
                      key={s.value}
                      label={s.label}
                      n={n}
                      pct={pct(n)}
                      pillClass={pipelineBadgeClass(s.value)}
                    />
                  );
                })}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <h3 className="mb-1 text-base font-semibold">
                Estimated monthly income
              </h3>
              <p className="mb-4 text-sm text-muted-foreground">
                Based on the income figures you&apos;ve entered against each
                lead.
              </p>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <Metric label="In pipeline" money value={pipelineIncome} />
                <Metric label="Won" money value={wonIncome} />
                <Metric label="Across all leads" money value={totalIncome} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <h3 className="mb-4 text-base font-semibold">Your activity</h3>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                <Metric label="Leads actioned" value={contacted} />
                <Metric
                  label={
                    product === "guaranteed_rent"
                      ? "Viewings or contracts"
                      : "Web meetings booked"
                  }
                  value={meetingsBooked}
                />
                <Metric
                  label={
                    product === "guaranteed_rent"
                      ? "Contracts signed"
                      : "Web meetings attended"
                  }
                  value={meetingsAttended}
                />
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </section>
  );
}

function FunnelRow({
  label,
  n,
  pct,
  pillClass,
}: {
  label: string;
  n: number;
  pct: number;
  pillClass?: string;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-sm">
        <span
          className={
            pillClass
              ? `inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${pillClass}`
              : "font-medium"
          }
        >
          {label}
        </span>
        <span className="text-muted-foreground">
          {n} · {pct}%
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-2 rounded-full bg-brand"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  money = false,
}: {
  label: string;
  value: number;
  money?: boolean;
}) {
  return (
    <div className="rounded-lg border-[0.5px] border-border p-4">
      <p className="text-2xl font-semibold">
        {money ? formatGBP(value) : value}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{label}</p>
    </div>
  );
}
