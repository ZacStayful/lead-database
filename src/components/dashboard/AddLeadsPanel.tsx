"use client";

import { useState } from "react";
import { FileSpreadsheet, PencilLine } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { ImportLeadsPanel } from "./ImportLeadsPanel";
import { ManualLeadForm } from "./ManualLeadForm";
import type { LeadType } from "@/lib/types";

type Mode = "import" | "manual";

const TABS: { key: Mode; label: string; icon: typeof FileSpreadsheet }[] = [
  { key: "import", label: "Import a spreadsheet", icon: FileSpreadsheet },
  { key: "manual", label: "Add one lead", icon: PencilLine },
];

/**
 * The two ways in, side by side. Tabs are hand-rolled because the repo vendors
 * only nine shadcn primitives and a tabs component is not one of them — the
 * same approach AdminCustomersTable takes.
 */
export function AddLeadsPanel({ available }: { available: LeadType[] }) {
  const [mode, setMode] = useState<Mode>("import");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const active = mode === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => setMode(tab.key)}
              className={`inline-flex items-center gap-2 rounded-lg border-[0.5px] px-3 py-2 text-sm transition-colors ${
                active
                  ? "border-primary bg-primary/10 font-medium text-foreground"
                  : "border-border text-muted-foreground hover:bg-muted/50"
              }`}
            >
              <Icon className="h-4 w-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      <Card>
        <CardContent className="pt-6">
          {mode === "import" ? (
            <ImportLeadsPanel available={available} />
          ) : (
            <ManualLeadForm available={available} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Shared product chooser. Hidden entirely when the customer holds one product,
 * because a control with a single option is a question with one answer.
 *
 * The product decides which pipeline stages the lead gets, so it is a real
 * choice for anyone holding both and not a preference (invariant 6).
 */
export function ProductChooser({
  available,
  value,
  onChange,
  disabled,
}: {
  available: LeadType[];
  value: LeadType;
  onChange: (next: LeadType) => void;
  disabled?: boolean;
}) {
  if (available.length < 2) return null;

  return (
    <div className="space-y-1.5">
      <span className="text-sm font-medium">Which pipeline are these for?</span>
      <div className="flex flex-wrap gap-2">
        {available.map((product) => (
          <button
            key={product}
            type="button"
            disabled={disabled}
            onClick={() => onChange(product)}
            className={`rounded-lg border-[0.5px] px-3 py-1.5 text-sm transition-colors disabled:opacity-50 ${
              value === product
                ? "border-primary bg-primary/10 font-medium"
                : "border-border text-muted-foreground hover:bg-muted/50"
            }`}
          >
            {product === "management" ? "Management" : "Guaranteed rent"}
          </button>
        ))}
      </div>
    </div>
  );
}
