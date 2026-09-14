/**
 * The dashboard's pipeline funnel (§56.7). PURE.
 *
 * Rows: Received → Contacted → each meeting stage for the product → Won.
 * ⚠️ NO "In discussion" ROW. `in_discussion` is a legal status no customer
 * UI ever sets (§56.2), so a row for it would read 0 for ever.
 *
 * "At or beyond" a stage is decided by the product's own stage order
 * (`stagesForLeadType`), because nothing records stage history before 0150
 * — an assignment at web_meeting_attended is counted as having been booked.
 * A won assignment counts in every meeting row for the same reason: a
 * signed landlord got there through the pipeline whether or not the stage
 * column was moved along the way.
 */
import {
  meetingStagesForLeadType,
  pipelineLabel,
  stagesForLeadType,
} from "@/components/dashboard/pipelineStage";
import type { LeadType } from "@/lib/types";

export interface FunnelAssignment {
  status: string;
  pipeline_stage: string;
  first_contacted_at: string | null;
  assigned_at: string;
  lead?: { lead_type?: LeadType | string | null } | null;
}

export interface FunnelRow {
  key: string;
  label: string;
  count: number;
  /** Bar width as a percentage of the top row, floored so a label fits. */
  widthPct: number;
  fill: string;
  /** Share of the top row, whole percent. */
  cumulativePct: number;
  /** Share of this row that reached the next one; null on the last row. */
  nextStepPct: number | null;
}

export interface Funnel {
  leadType: LeadType;
  rows: FunnelRow[];
  received: number;
  won: number;
  /** won / received, whole percent; null with nothing received. */
  signedPct: number | null;
  medianResponseMinutes: number | null;
}

/** The design's six-step ramp, lightest at the top. */
export const FUNNEL_FILLS = ["#C9D9BE", "#B5CCA6", "#A0BE8E", "#8FAE82", "#729869", "#5D8156"];
export const MIN_BAR_PCT = 12;

const CONTACTED_STATUSES = new Set(["contacted", "in_discussion", "won"]);

export function isContacted(a: Pick<FunnelAssignment, "status" | "first_contacted_at">): boolean {
  return CONTACTED_STATUSES.has(a.status) || Boolean(a.first_contacted_at);
}

/** Median minutes from delivery to first contact; null until one exists. */
export function medianResponseMinutes(
  assignments: Pick<FunnelAssignment, "first_contacted_at" | "assigned_at">[]
): number | null {
  const mins = assignments
    .filter((a) => a.first_contacted_at)
    .map(
      (a) =>
        (new Date(a.first_contacted_at as string).getTime() - new Date(a.assigned_at).getTime()) /
        60_000
    )
    .filter((m) => m >= 0)
    .sort((x, y) => x - y);
  if (mins.length === 0) return null;
  const mid = Math.floor(mins.length / 2);
  return mins.length % 2 === 1 ? mins[mid] : (mins[mid - 1] + mins[mid]) / 2;
}

export function buildFunnel(assignments: FunnelAssignment[], leadType: LeadType): Funnel {
  const mine = assignments.filter((a) => (a.lead?.lead_type ?? "management") === leadType);
  const order = stagesForLeadType(leadType).map((s) => s.value as string);
  const meeting = meetingStagesForLeadType(leadType);
  const rank = (stage: string) => order.indexOf(stage);

  const counts: { key: string; label: string; count: number }[] = [
    { key: "received", label: "Received", count: mine.length },
    { key: "contacted", label: "Contacted", count: mine.filter(isContacted).length },
    ...meeting.map((stage) => ({
      key: stage,
      label: pipelineLabel(stage),
      count: mine.filter(
        (a) => a.status === "won" || (rank(a.pipeline_stage) >= rank(stage) && rank(stage) >= 0)
      ).length,
    })),
    { key: "won", label: "Won", count: mine.filter((a) => a.status === "won").length },
  ];

  const top = counts[0].count;
  const rows: FunnelRow[] = counts.map((c, i) => {
    const next = counts[i + 1];
    const pct = top > 0 ? (c.count / top) * 100 : 0;
    return {
      key: c.key,
      label: c.label,
      count: c.count,
      widthPct: top > 0 ? Math.max(pct, MIN_BAR_PCT) : 0,
      fill: FUNNEL_FILLS[Math.min(i, FUNNEL_FILLS.length - 1)],
      cumulativePct: top > 0 ? Math.round(pct) : 0,
      nextStepPct: next ? (c.count > 0 ? Math.round((next.count / c.count) * 100) : 0) : null,
    };
  });

  const won = counts[counts.length - 1].count;
  return {
    leadType,
    rows,
    received: top,
    won,
    signedPct: top > 0 ? Math.round((won / top) * 100) : null,
    medianResponseMinutes: medianResponseMinutes(mine),
  };
}

/** "42 min", "1h 5m", "under a minute". */
export function formatMinutes(mins: number): string {
  if (mins < 1) return "under a minute";
  if (mins < 60) return `${Math.round(mins)} min`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}
