"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { LABEL_BADGE_TITLES, LABEL_NAMES, isLabelKey, type LabelKey } from "@/lib/leadBrief/labelCopy";

/**
 * A lead's Lead Brief label (Phase 5). Renders NOTHING without a label, which
 * is every assignment an existing customer holds: their cards are unchanged.
 * The words come from labelCopy.ts only.
 */
const STYLE: Record<LabelKey, string> = {
  top_match: "border-transparent bg-brand-light text-brand-dark",
  strong_match: "border-brand/50 bg-white text-brand-dark",
  first_pick: "border-transparent bg-brand/10 text-brand",
  nearby_opportunity: "border-line bg-white text-ink-2",
};

export function MatchLabelBadge({
  label,
  className,
}: {
  label: string | null | undefined;
  className?: string;
}) {
  if (!isLabelKey(label)) return null;
  return (
    <Badge
      variant="outline"
      className={cn(STYLE[label], className)}
      title={LABEL_BADGE_TITLES[label]}
    >
      {LABEL_NAMES[label]}
    </Badge>
  );
}
