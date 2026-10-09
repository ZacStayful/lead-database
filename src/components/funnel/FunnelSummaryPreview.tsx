"use client";

import { BriefPreviewView } from "@/components/leadBrief/BriefPreviewView";
import type { ClientBriefPreview } from "@/lib/leadBrief/preview";

const noop = () => {};

/**
 * The preview on the partner summary page, read-only: every control is
 * disabled (`busy`) and every handler does nothing. A client wrapper only
 * because a server page cannot pass functions into BriefPreviewView.
 */
export function FunnelSummaryPreview({
  preview,
  ticked,
  minBedrooms,
  minGross,
  anywayLine,
}: {
  preview: ClientBriefPreview;
  ticked: string[];
  minBedrooms: number | null;
  minGross: number | null;
  anywayLine: string;
}) {
  return (
    <BriefPreviewView
      preview={preview}
      ticked={ticked}
      minBedrooms={minBedrooms}
      minGross={minGross}
      renewalIso={null}
      switched={false}
      switchOpen={false}
      busy
      allowSwitch={false}
      anywayLine={anywayLine}
      onToggleArea={noop}
      onWiden={noop}
      onOpenSwitch={noop}
      onCancelSwitch={noop}
      onConfirmSwitch={noop}
    />
  );
}
