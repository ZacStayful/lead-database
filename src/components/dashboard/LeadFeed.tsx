"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { LeadCard } from "./LeadCard";
import type { AssignmentWithLead } from "@/lib/types";

/** How long after a new assignment a brief customer's feed refreshes again. */
const LABEL_REFRESH_MS = 3000;

/**
 * Renders the customer's lead feed and listens for new assignments in
 * real-time. When a new-lead notification arrives we refresh server data so
 * the freshly-assigned lead appears at the top instantly.
 */
export function LeadFeed({
  customerId,
  assignments,
  labelsFollow = false,
}: {
  customerId: string;
  assignments: AssignmentWithLead[];
  /**
   * Lead Brief (Phase 5): true for a brief customer. Their label is written a
   * moment AFTER the assignment row this listens for, so one more refresh a
   * few seconds later shows the badge. Off for everyone else, whose feed
   * behaves exactly as before.
   */
  labelsFollow?: boolean;
}) {
  const router = useRouter();
  const [hasNew, setHasNew] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    const timers: ReturnType<typeof setTimeout>[] = [];
    const channel = supabase
      .channel(`lead-feed:${customerId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "lead_assignments",
          filter: `customer_id=eq.${customerId}`,
        },
        () => {
          setHasNew(true);
          router.refresh();
          if (labelsFollow) timers.push(setTimeout(() => router.refresh(), LABEL_REFRESH_MS));
        }
      )
      .subscribe();

    return () => {
      for (const t of timers) clearTimeout(t);
      supabase.removeChannel(channel);
    };
  }, [customerId, router, labelsFollow]);

  if (assignments.length === 0) {
    return (
      <div className="rounded-lg border-[0.5px] border-dashed border-border p-12 text-center text-muted-foreground">
        No leads yet. New leads will appear here the moment they’re assigned to
        you.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {hasNew && (
        <button
          onClick={() => {
            setHasNew(false);
            router.refresh();
          }}
          className="w-full rounded-md bg-brand/10 py-2 text-sm font-medium text-brand"
        >
          New lead just arrived — click to refresh
        </button>
      )}
      {assignments.map((a) => (
        <LeadCard key={a.id} assignment={a} />
      ))}
    </div>
  );
}
