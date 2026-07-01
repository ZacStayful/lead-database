"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { formatDate } from "@/lib/utils";
import type { Notification } from "@/lib/types";
import { Bell } from "lucide-react";

export function NotificationsCentre({
  customerId,
  initial,
}: {
  customerId: string;
  initial: Notification[];
}) {
  const router = useRouter();
  const [items, setItems] = useState(initial);

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
          setItems((prev) => [payload.new as Notification, ...prev]);
        }
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [customerId]);

  if (items.length === 0) {
    return (
      <div className="rounded-lg border-[0.5px] border-dashed border-border p-12 text-center text-muted-foreground">
        No notifications yet.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {items.map((n) => (
        <div
          key={n.id}
          className="flex items-start gap-3 rounded-lg border-[0.5px] border-border bg-card p-4"
        >
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand/10 text-brand">
            <Bell className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm">{n.message}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {formatDate(n.created_at)}
            </p>
          </div>
          {!n.read_at && (
            <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand" />
          )}
        </div>
      ))}
    </div>
  );
}
