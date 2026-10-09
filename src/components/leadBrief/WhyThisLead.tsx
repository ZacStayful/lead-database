"use client";

import { useState, type ReactNode } from "react";
import { Check, Minus, ChevronDown, ChevronUp } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { BRIEF_EDITOR_HREF } from "@/lib/leadBrief/editCopy";
import {
  WHY_COPY,
  checklistLines,
  isLabelKey,
  nearbyTip,
  parseMatchReasons,
  reasonLine,
} from "@/lib/leadBrief/labelCopy";

/**
 * "Why you got this lead" (Lead Brief Phase 5): the checklist, the one-line
 * reason and, on a Nearby opportunity, the one change that would turn leads
 * like it into strong matches.
 *
 * Renders NOTHING without a label or with reasons it cannot read, so an
 * existing customer's card is unchanged and a malformed row never breaks one.
 * Every word comes from labelCopy.ts.
 *
 * `footer` is where the contact panel puts "Not for me"; the card passes none
 * (it must never sit beside the dead-lead report, §51.6, §51.10).
 */
export function WhyThisLead({
  label,
  reasons: rawReasons,
  leadOutcode,
  defaultOpen = false,
  className,
  footer,
}: {
  label: string | null | undefined;
  reasons: unknown;
  leadOutcode: string | null | undefined;
  defaultOpen?: boolean;
  className?: string;
  footer?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (!isLabelKey(label)) return null;
  const reasons = parseMatchReasons(rawReasons);
  if (!reasons) return null;

  const lines = checklistLines(reasons);
  const tip = label === "nearby_opportunity" ? nearbyTip(reasons, leadOutcode ?? null) : null;
  const firstPickTag = label === "top_match" && reasons.first_pick;

  return (
    <div className={cn("rounded-md border border-line bg-rail/60", className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm font-medium text-ink"
        aria-expanded={open}
      >
        <span>{WHY_COPY.title}</span>
        {open ? (
          <ChevronUp className="h-4 w-4 text-ink-2" aria-hidden />
        ) : (
          <ChevronDown className="h-4 w-4 text-ink-2" aria-hidden />
        )}
      </button>
      {open && (
        <div className="space-y-3 border-t border-line px-3 py-3 text-sm">
          <p className="text-ink">{reasonLine(label, reasons)}</p>
          {firstPickTag && <p className="text-ink-2">{WHY_COPY.firstPickTag}</p>}
          {lines.length > 0 && (
            <ul className="space-y-1.5">
              {lines.map((l) => (
                <li key={l.key} className="flex items-start gap-2">
                  {l.met ? (
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-label="Met" />
                  ) : (
                    <Minus className="mt-0.5 h-4 w-4 shrink-0 text-ink-2" aria-label="Missed" />
                  )}
                  <span>
                    <span className="font-medium text-ink">{l.name}</span>
                    <span className="text-ink-2"> — {l.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {tip && (
            <p className="rounded-md bg-brand-light px-3 py-2 text-brand-dark">
              <span className="font-medium">{WHY_COPY.tipLead}: </span>
              {tip}{" "}
              <Link href={BRIEF_EDITOR_HREF} className="font-medium underline underline-offset-2">
                {WHY_COPY.editBrief}
              </Link>
            </p>
          )}
          {footer}
        </div>
      )}
    </div>
  );
}
