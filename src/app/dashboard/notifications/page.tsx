import { redirect } from "next/navigation";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  NotificationsCentre,
  type NotificationWithLead,
} from "@/components/dashboard/NotificationsCentre";
import type { Notification } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  const { user, customer } = await getCurrentCustomer();
  if (!user) redirect("/login");
  if (!customer) redirect("/dashboard");

  const admin = createAdminClient();
  // Embed the assignment's lead_id so each notification can link straight to
  // the lead it's about (the lead detail route is keyed on lead_id).
  const { data } = await admin
    .from("notifications")
    .select("*, lead_assignments(lead_id)")
    .eq("customer_id", customer.id)
    .order("created_at", { ascending: false })
    .limit(100);

  const notifications: NotificationWithLead[] = (data ?? []).map((row) => {
    const n = row as Notification & {
      lead_assignments?: { lead_id: string } | null;
    };
    return { ...n, lead_id: n.lead_assignments?.lead_id ?? null };
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Notifications</h1>
        <p className="text-sm text-muted-foreground">
          New-lead alerts and account updates.
        </p>
      </div>
      <NotificationsCentre customerId={customer.id} initial={notifications} />
    </div>
  );
}
