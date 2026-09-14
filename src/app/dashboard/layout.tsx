import { redirect } from "next/navigation";
import { getCurrentCustomer, isAdminUser } from "@/lib/auth";
import { markFirstLoginAndNotify } from "@/lib/firstLogin";
import { createAdminClient } from "@/lib/supabase/admin";
import { NotificationBell } from "@/components/dashboard/NotificationBell";
import { AppShell } from "@/components/shell/AppShell";
import type { PaletteLead } from "@/components/shell/CommandPalette";
import { messagingActiveFor } from "@/lib/messaging/service";
import { unreadReplyCount } from "@/lib/messaging/inbox";
import { holdsProduct } from "@/lib/products";
import { buildSidebar, type NavFlags } from "@/lib/dashboardNav";
import { initials } from "@/lib/utils";

/**
 * The dashboard frame (§56.7): every gate is resolved here, on the server,
 * and handed to the shell as a nav model. The rules are unchanged from the
 * header this replaced —
 *
 * - Follow-ups is hidden until the messaging switch is on, and visible to an
 *   admin throughout (§40.3). The page enforces this independently; hiding
 *   the link is a courtesy, not a control.
 * - Goals is management-only (subscription_status, exactly what
 *   set_management_customer_goal checks).
 * - "Request a feature" IS A DIRECT LINK, never folded into a menu (§50.8).
 * - Admin is appended for admins.
 */
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, customer } = await getCurrentCustomer();
  if (!user) redirect("/login");

  const isAdmin = isAdminUser(user);
  let unread = 0;
  let unreadReplies = 0;
  let messagingOn = false;
  let paletteLeads: PaletteLead[] = [];
  if (customer) {
    // First authenticated render after login — send the one-time welcome email
    // if this is the customer's first-ever sign-in (idempotent, best-effort).
    await markFirstLoginAndNotify(customer);

    const admin = createAdminClient();
    const [notif, replies, on, leads] = await Promise.all([
      admin
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .eq("customer_id", customer.id)
        .is("read_at", null),
      unreadReplyCount(admin, customer.id),
      messagingActiveFor(admin, isAdmin),
      // ⌘K rows: the customer's own leads, filtered in the browser (§27.1
      // keeps free-form search off every server surface).
      admin
        .from("lead_assignments")
        .select("lead_id, lead:leads(lead_name, address)")
        .eq("customer_id", customer.id)
        .order("assigned_at", { ascending: false })
        .limit(500),
    ]);
    unread = notif.count ?? 0;
    unreadReplies = replies;
    messagingOn = on;
    paletteLeads = ((leads.data ?? []) as unknown as {
      lead_id: string;
      lead: { lead_name: string | null; address: string | null } | null;
    }[]).map((r) => ({
      id: r.lead_id,
      name: r.lead?.lead_name ?? "Lead",
      address: r.lead?.address ?? null,
    }));
  }

  const holdsManagement = customer?.subscription_status === "active";
  const holdsMgmtProduct = customer ? holdsProduct(customer, "management") : false;
  const holdsGr = customer ? holdsProduct(customer, "guaranteed_rent") : false;

  const flags: NavFlags = {
    messagingOn,
    holdsManagement,
    holdsAny: holdsMgmtProduct || holdsGr,
    isAdmin,
    unreadReplies,
  };

  // The account chip is static (invariant 6 — nothing to switch between).
  const products: string[] = [];
  if (holdsMgmtProduct) products.push(`Management · ${customer!.monthly_allocation} leads/mo`);
  if (holdsGr) products.push(`Guaranteed Rent · ${customer!.gr_monthly_allocation} leads/mo`);
  const account = {
    name: customer?.business_name || customer?.contact_name || user.email || "Your account",
    subtitle: products.length > 0 ? products.join(" · ") : "No active package",
  };

  return (
    <AppShell
      model={buildSidebar(flags)}
      flags={flags}
      account={account}
      initials={initials(customer?.contact_name || user.email)}
      bell={
        customer ? (
          <NotificationBell customerId={customer.id} initialCount={unread} variant="circle" />
        ) : null
      }
      paletteLeads={paletteLeads}
    >
      {children}
    </AppShell>
  );
}
