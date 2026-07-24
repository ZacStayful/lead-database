"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { formatDate } from "@/lib/utils";
import type { Notification } from "@/lib/types";
import { Bell } from "lucide-react";

export type NotificationWithLead = Notification & { lead_id: string | null };

export function NotificationsCentre({
  customerId,
  initial,
}: {
  customerId: string;
  initial: NotificationWithLead[];
}) {
  const router = useRouter();
  const [items, setItems] = useState<NotificationWithLead[]>(initial);

  // Mark everything as read when the centre is opened.
  useEffect(() => {
    const unreadIds = initial.filter((n) => !n.read_at).map((n) => n.id);
    if (unreadIds.length === 0) return;
    const supabase = createClient();
    void supabase
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .in("id", unreadIds)
      .then(() => router.refresh());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live-append new notifications.
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`notif-centre:${customerId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "notifications",
          filter: `customer_id=eq.${customerId}`,
        },
        (payload) => {
          const n = payload.new as Notification;
          // Realtime rows don't carry the embedded lead_id; resolved on click.
          setItems((prev) => [{ ...n, lead_id: null }, ...prev]);
        }
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [customerId]);

  // Navigate to the lead a notification is about. Uses the embedded lead_id
  // when present, otherwise resolves it from the assignment on demand.
  async function open(n: NotificationWithLead) {
    let leadId = n.lead_id;
    if (!leadId && n.lead_assignment_id) {
      const supabase = createClient();
      const { data } = await supabase
        .from("lead_assignments")
        .select("lead_id")
        .eq("id", n.lead_assignment_id)
        .maybeSingle();
      leadId = (data as { lead_id: string } | null)?.lead_id ?? null;
    }
    router.push(leadId ? `/dashboard/leads/${leadId}` : "/dashboard/leads");
  }

  if (items.length === 0) {
    return (
      <div className="rounded-lg border-[0.5px] border-dashed border-border p-12 text-center text-muted-foreground">
        No notifications yet.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {items.map((n) => {
        // Only lead notifications are clickable; account updates carry no lead.
        const clickable = Boolean(n.lead_id || n.lead_assignment_id);
        const content = (
          <>
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand/10 text-brand">
              <Bell className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm">{n.message}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {formatDate(n.created_at)}
                {clickable && (
                  <span className="ml-2 text-brand">View lead →</span>
                )}
              </p>
            </div>
            {!n.read_at && (
              <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand" />
            )}
          </>
        );

        if (!clickable) {
          return (
            <div
              key={n.id}
              className="flex items-start gap-3 rounded-lg border-[0.5px] border-border bg-card p-4"
            >
              {content}
            </div>
          );
        }

        return (
          <button
            key={n.id}
            type="button"
            onClick={() => open(n)}
            className="flex w-full items-start gap-3 rounded-lg border-[0.5px] border-border bg-card p-4 text-left transition-colors hover:border-brand/40 hover:bg-brand/5"
          >
            {content}
          </button>
        );
      })}
    </div>
  );
}
