"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";

/** Downloads the customer's leads as an xlsx from the export API route. */
export function ExportButton() {
  const [loading, setLoading] = useState(false);

  async function onExport() {
    setLoading(true);
    try {
      const res = await fetch("/api/leads/export");
      if (!res.ok) throw new Error("Export failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `stayful-leads-${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      alert("Could not export leads. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button variant="outline" size="sm" onClick={onExport} disabled={loading}>
      <Download className="h-4 w-4" />
      {loading ? "Exporting…" : "Export"}
    </Button>
  );
}
