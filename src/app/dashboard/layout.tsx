import { redirect } from "next/navigation";
import { getCurrentCustomer, isAdminUser } from "@/lib/auth";
import { markFirstLoginAndNotify } from "@/lib/firstLogin";
import { createAdminClient } from "@/lib/supabase/admin";
import { NotificationBell } from "@/components/dashboard/NotificationBell";
import { AppShell } from "@/components/shell/AppShell";
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
  const { user, customer, viewAs } = await getCurrentCustomer();
  if (!user) redirect("/login");

  // While an admin views a customer (§62) `user` carries no admin claim, so
  // this reads false and every gate below is the customer's own.
  const isAdmin = isAdminUser(user);
  let unread = 0;
  let unreadReplies = 0;
  let messagingOn = false;
  if (customer) {
    // First authenticated render after login — send the one-time welcome email
    // if this is the customer's first-ever sign-in (idempotent, best-effort).
    // ⚠️ Never while an admin is viewing them (§62): it stamps first_login_at
    // and emails a welcome to somebody who has not logged in.
    if (!viewAs) await markFirstLoginAndNotify(customer);

    const admin = createAdminClient();
    // ⌘K's lead rows are NOT loaded here: the palette fetches
    // /api/customer/leads/palette on its first open, so a 500-row join does
    // not ride along with every dashboard request (§56.7).
    const [notif, replies, on] = await Promise.all([
      admin
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .eq("customer_id", customer.id)
        .is("read_at", null),
      unreadReplyCount(admin, customer.id),
      messagingActiveFor(admin, isAdmin),
    ]);
    unread = notif.count ?? 0;
    unreadReplies = replies;
    messagingOn = on;
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
      viewAs={viewAs}
      bell={
        customer ? (
          <NotificationBell customerId={customer.id} initialCount={unread} variant="circle" />
        ) : null
      }
    >
      {children}
    </AppShell>
  );
}
