"use client";

import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";

/**
 * Exports the current view as a PDF via the browser's print dialog
 * ("Save as PDF"). Print styles hide the dashboard chrome so only the
 * analytics content is captured.
 */
export function PrintButton({ label = "Download PDF" }: { label?: string }) {
  return (
    <Button
      variant="outline"
      size="sm"
      className="no-print"
      onClick={() => window.print()}
    >
      <Download className="h-4 w-4" />
      {label}
    </Button>
  );
}
