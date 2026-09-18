"use client";

import { createContext, useContext } from "react";
import type { ViewAs } from "@/lib/viewAs";

/**
 * Whether the dashboard is an admin's read-only view of a customer (§62).
 *
 * The server refuses every write while a view is selected (src/middleware.ts);
 * this context is the courtesy layer for the two components that write through
 * the browser Supabase client with no route in between — LeadFiles (a Storage
 * upload) and NotificationsCentre (a mark-read on mount). Everything else
 * simply shows the refusal sentence the API returns.
 */
const ViewAsContext = createContext<ViewAs | null>(null);

export function ViewAsProvider({ value, children }: { value: ViewAs | null; children: React.ReactNode }) {
  return <ViewAsContext.Provider value={value}>{children}</ViewAsContext.Provider>;
}

export function useViewAs(): ViewAs | null {
  return useContext(ViewAsContext);
}

/** True while an admin is viewing a customer — nothing here may change their account. */
export function useReadOnlyView(): boolean {
  return useContext(ViewAsContext) !== null;
}
