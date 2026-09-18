"use client";

import { useState } from "react";
import { Eye } from "lucide-react";
import { VIEW_AS_PICKER_PATH, VIEW_AS_ROUTE, type ViewAs } from "@/lib/viewAs";

/**
 * The amber bar above the top bar while an admin views a customer (§62). Its
 * own file rather than a line in TopBar.tsx, which redesignGuards pins to the
 * design's wording. Exit clears the cookie through the route (a page cannot)
 * and returns to the picker with a full navigation, so every server component
 * re-resolves identity.
 */
export function ViewAsBanner({ viewAs }: { viewAs: ViewAs }) {
  const [busy, setBusy] = useState(false);

  async function exit() {
    setBusy(true);
    try {
      await fetch(VIEW_AS_ROUTE, { method: "DELETE" });
    } catch {
      /* the cookie expires on its own; the picker still opens */
    }
    window.location.assign(VIEW_AS_PICKER_PATH);
  }

  return (
    <div
      role="status"
      className="no-print flex flex-shrink-0 items-center justify-between gap-3 border-b border-amber-300 bg-amber-100 px-4 py-2 text-[13px] text-amber-900"
    >
      <p className="flex min-w-0 items-center gap-2">
        <Eye className="h-4 w-4 flex-shrink-0" aria-hidden />
        <span className="truncate">
          Viewing <strong>{viewAs.label}</strong> as they see it — read-only. Nothing you do here
          changes their account.
        </span>
      </p>
      <button
        type="button"
        onClick={exit}
        disabled={busy}
        className="flex-shrink-0 rounded-md border border-amber-400 bg-white px-3 py-1 text-[13px] font-medium text-amber-900 hover:bg-amber-50 disabled:opacity-60"
      >
        {busy ? "Leaving…" : "Exit to admin"}
      </button>
    </div>
  );
}
