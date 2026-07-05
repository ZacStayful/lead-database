/**
 * Display labels and badge styling for a lead assignment's pipeline_stage.
 * Independent of status — a lead can be at any pipeline stage regardless of
 * whether it is new, contacted, won, etc.
 */
import type { PipelineStage } from "@/lib/types";

export const PIPELINE_STAGES: { value: PipelineStage; label: string }[] = [
  { value: "cold", label: "Cold" },
  { value: "interested_in_the_future", label: "Interested in the future" },
  { value: "web_meeting_booked", label: "Web meeting booked" },
  { value: "web_meeting_no_show", label: "Booked — did not attend" },
  { value: "web_meeting_attended", label: "Web meeting attended" },
  { value: "abandoned", label: "Abandoned" },
];

const LABELS: Record<string, string> = Object.fromEntries(
  PIPELINE_STAGES.map((s) => [s.value, s.label])
);

export function pipelineLabel(stage: string): string {
  return LABELS[stage] ?? stage;
}

/** Muted badge styling; kept subtle so it reads as a secondary sub-label. */
export function pipelineBadgeClass(stage: string): string {
  if (stage === "abandoned") {
    return "border-transparent bg-gray-100 text-gray-500";
  }
  if (stage === "cold") {
    return "border-transparent bg-slate-100 text-slate-600";
  }
  return "border-transparent bg-brand/10 text-brand";
}
