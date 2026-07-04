"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Bell } from "lucide-react";

/**
 * Bell icon with a live unread-notification count. Subscribes to Supabase
 * realtime so new-lead notifications appear instantly without a refresh.
 */
export function NotificationBell({
  customerId,
  initialCount,
}: {
  customerId: string;
  initialCount: number;
}) {
  const router = useRouter();
  const [count, setCount] = useState(initialCount);

  // Re-sync when the server re-renders the layout (e.g. after notifications
  // are marked read) — useState alone would keep the stale initial value.
  useEffect(() => {
    setCount(initialCount);
  }, [initialCount]);

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`notifications:${customerId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "notifications",
          filter: `customer_id=eq.${customerId}`,
        },
        () => {
          setCount((c) => c + 1);
          // Refresh server components (lead feed / stats) in the background.
          router.refresh();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [customerId, router]);

  return (
    <Link
      href="/dashboard/notifications"
      className="relative inline-flex h-9 w-9 items-center justify-center rounded-md hover:bg-accent"
      aria-label="Notifications"
    >
      <Bell className="h-5 w-5" />
      {count > 0 && (
        <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-[10px] font-semibold text-brand-foreground">
          {count > 9 ? "9+" : count}
        </span>
      )}
    </Link>
  );
}
