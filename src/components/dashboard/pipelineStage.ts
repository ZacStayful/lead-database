/**
 * Display labels and badge styling for a lead assignment's pipeline_stage.
 * Independent of status — a lead can be at any pipeline stage regardless of
 * whether it is new, contacted, won, etc.
 */
import type { LeadType, PipelineStage } from "@/lib/types";

export const PIPELINE_STAGES: { value: PipelineStage; label: string }[] = [
  { value: "cold", label: "Cold" },
  { value: "interested_in_the_future", label: "Interested in the future" },
  { value: "web_meeting_booked", label: "Web meeting booked" },
  { value: "web_meeting_no_show", label: "Booked — did not attend" },
  { value: "web_meeting_attended", label: "Web meeting attended" },
  { value: "abandoned", label: "Abandoned" },
  { value: "won", label: "Won" },
];

/** Guaranteed-rent leads run a shorter, viewing-to-contract pipeline. */
export const GR_PIPELINE_STAGES: { value: PipelineStage; label: string }[] = [
  { value: "cold", label: "Cold" },
  { value: "viewing_booked", label: "Viewing booked" },
  { value: "contract_sent", label: "Contract sent" },
  { value: "contract_signed", label: "Contract signed" },
];

/** The stage options to show for a given lead type. */
export function stagesForLeadType(
  leadType: LeadType | string | undefined
): { value: PipelineStage; label: string }[] {
  return leadType === "guaranteed_rent" ? GR_PIPELINE_STAGES : PIPELINE_STAGES;
}

/**
 * The stages that mean "this operator got in front of the landlord".
 *
 * The two pipelines converge on different things, so this is not the same
 * stage set in each. Defined once here because the analytics page and the
 * dashboard both report on it, and this codebase has already been bitten by
 * two customer-facing surfaces computing the same figure differently (see the
 * header of dashboard/analytics/page.tsx on the Won figure).
 */
export function meetingStagesForLeadType(
  leadType: LeadType | string | undefined
): string[] {
  return leadType === "guaranteed_rent"
    ? ["viewing_booked", "contract_sent", "contract_signed"]
    : ["web_meeting_booked", "web_meeting_no_show", "web_meeting_attended"];
}

const LABELS: Record<string, string> = Object.fromEntries(
  [...PIPELINE_STAGES, ...GR_PIPELINE_STAGES].map((s) => [s.value, s.label])
);

export function pipelineLabel(stage: string): string {
  return LABELS[stage] ?? stage;
}

/** Badge text shown to customers — makes clear it is an editable status. */
export function pipelineStatusText(stage: string): string {
  return `Status: ${pipelineLabel(stage)}`;
}

/**
 * Colour per pipeline stage:
 *   cold → blue · interested → green · web meeting booked → amber
 *   booked no-show → dark blue · web meeting attended → red · abandoned → dark grey
 */
export function pipelineBadgeClass(stage: string): string {
  switch (stage) {
    case "cold":
      return "border-transparent bg-blue-100 text-blue-700";
    case "interested_in_the_future":
      return "border-transparent bg-green-100 text-green-700";
    case "web_meeting_booked":
      return "border-transparent bg-amber-100 text-amber-800";
    case "web_meeting_no_show":
      return "border-transparent bg-blue-900 text-white";
    case "web_meeting_attended":
      return "border-transparent bg-red-100 text-red-700";
    case "abandoned":
      return "border-transparent bg-gray-600 text-white";
    // Matches the green of the "Won" STATUS badge in leadStatus.ts — the two
    // always agree now, so they must not look like different things.
    case "won":
      return "border-transparent bg-green-100 text-green-700";
    case "viewing_booked":
      return "border-transparent bg-amber-100 text-amber-800";
    case "contract_sent":
      return "border-transparent bg-indigo-100 text-indigo-700";
    case "contract_signed":
      return "border-transparent bg-green-100 text-green-700";
    default:
      return "border-transparent bg-slate-100 text-slate-600";
  }
}
