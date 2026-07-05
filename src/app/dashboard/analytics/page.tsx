import { redirect } from "next/navigation";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent } from "@/components/ui/card";
import { PrintButton } from "@/components/dashboard/PrintButton";
import {
  PIPELINE_STAGES,
  pipelineBadgeClass,
} from "@/components/dashboard/pipelineStage";
import { formatDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

const STATUS_ORDER: { key: string; label: string }[] = [
  { key: "new", label: "New" },
  { key: "contacted", label: "Contacted" },
  { key: "in_discussion", label: "In discussion" },
  { key: "won", label: "Won" },
  { key: "not_relevant", label: "Not relevant" },
  { key: "rejected", label: "Rejected" },
];

export default async function AnalyticsPage() {
  const { user, customer } = await getCurrentCustomer();
  if (!user) redirect("/login");
  if (!customer) redirect("/dashboard");

  const admin = createAdminClient();

  const { data: rows } = await admin
    .from("lead_assignments")
    .select("status, pipeline_stage, viewed_at")
    .eq("customer_id", customer.id);

  const assignments = (rows ?? []) as {
    status: string;
    pipeline_stage: string;
    viewed_at: string | null;
  }[];

  // Notes + files activity (files table may not exist yet — tolerate errors).
  const { count: notesCount } = await admin
    .from("lead_notes")
    .select("id", { count: "exact", head: true })
    .eq("customer_id", customer.id);
  const { count: filesCount } = await admin
    .from("lead_files")
    .select("id", { count: "exact", head: true })
    .eq("customer_id", customer.id);

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
  const meetingsBooked = assignments.filter((a) =>
    ["web_meeting_booked", "web_meeting_no_show", "web_meeting_attended"].includes(
      a.pipeline_stage
    )
  ).length;
  const meetingsAttended = pipelineCounts.get("web_meeting_attended") ?? 0;

  const stats = [
    { label: "Total leads", value: String(total) },
    { label: "Won", value: String(won) },
    { label: "Win rate", value: `${winRate}%` },
    { label: "Notes logged", value: String(notesCount ?? 0) },
  ];

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

      {/* Headline stats */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label}>
            <CardContent className="pt-6">
              <p className="text-sm text-muted-foreground">{s.label}</p>
              <p className="mt-1 text-3xl font-semibold">{s.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Status funnel */}
      <Card>
        <CardContent className="pt-6">
          <h2 className="mb-1 text-lg font-semibold">Lead status funnel</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Where your {total} lead{total === 1 ? "" : "s"} sit across the funnel.
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

      {/* Pipeline stages */}
      <Card>
        <CardContent className="pt-6">
          <h2 className="mb-1 text-lg font-semibold">Pipeline stages</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Your own pipeline activity across every lead.
          </p>
          <div className="space-y-3">
            {PIPELINE_STAGES.map((s) => {
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

      {/* Activity */}
      <Card>
        <CardContent className="pt-6">
          <h2 className="mb-4 text-lg font-semibold">Your activity</h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Metric label="Leads actioned" value={contacted} />
            <Metric label="Web meetings booked" value={meetingsBooked} />
            <Metric label="Web meetings attended" value={meetingsAttended} />
            <Metric label="Files uploaded" value={filesCount ?? 0} />
          </div>
        </CardContent>
      </Card>
    </div>
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

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border-[0.5px] border-border p-4">
      <p className="text-2xl font-semibold">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{label}</p>
    </div>
  );
}
