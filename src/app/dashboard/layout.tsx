import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentCustomer, isAdminUser } from "@/lib/auth";
import { markFirstLoginAndNotify } from "@/lib/firstLogin";
import { createAdminClient } from "@/lib/supabase/admin";
import { NotificationBell } from "@/components/dashboard/NotificationBell";
import { SignOutButton } from "@/components/dashboard/SignOutButton";
import { MobileNav } from "@/components/dashboard/MobileNav";
import { DesktopNav, type NavGroup } from "@/components/dashboard/DesktopNav";
import { Logo } from "@/components/Logo";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, customer } = await getCurrentCustomer();
  if (!user) redirect("/login");

  let unread = 0;
  if (customer) {
    // First authenticated render after login — send the one-time welcome email
    // if this is the customer's first-ever sign-in (idempotent, best-effort).
    await markFirstLoginAndNotify(customer);

    const admin = createAdminClient();
    const { count } = await admin
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("customer_id", customer.id)
      .is("read_at", null);
    unread = count ?? 0;
  }

  // Goals is management-only: it targets signed management clients and reads a
  // management-only counter. The gate is subscription_status, which is exactly
  // what set_management_customer_goal (0050) checks — so the tab is never shown
  // to somebody the save would then refuse. Hiding it is a courtesy, not a
  // control: the page and the RPC each enforce this independently.
  const holdsManagement = customer?.subscription_status === "active";

  // Header navigation, grouped.
  //
  // Sixteen destinations rendered as one flat row no longer fitted beside the
  // logo, and since the nav shares its flex row with the notification bell and
  // sign-out, the overflow ran underneath them — "Admin", appended last for
  // admins, landed on top of the bell.
  //
  // Grouping into six top-level entries keeps every destination reachable in at
  // most two clicks with nothing hidden behind an unlabelled overflow control.
  // The groups are built here, on the server, so the visibility rules stay
  // beside the reasoning for them.
  const navGroups: NavGroup[] = [
    { label: "Dashboard", href: "/dashboard" },
    {
      label: "Leads",
      items: [
        { href: "/dashboard/leads", label: "All leads" },
        { href: "/dashboard/leads/priority", label: "Priority" },
        // The customer's own leads, imported or typed in. Ungated on product
        // here for the same reason as Expired leads below: the page resolves
        // which products they hold and explains itself when the answer is none.
        { href: "/dashboard/leads/add", label: "Add your own leads" },
        // Shown to every subscriber, not gated on holding a particular
        // product: the page resolves which pools the customer can see and
        // renders its own explanation when the answer is none.
        { href: "/dashboard/leads/expired", label: "Expired leads" },
        { href: "/dashboard/filtering", label: "Lead filtering" },
        { href: "/dashboard/topup", label: "Top up leads" },
      ],
    },
    {
      label: "Insights",
      items: [
        { href: "/dashboard/analytics", label: "Analytics" },
        // Ungated: it reports on the platform rather than on this customer's
        // own product holdings, and it renders its own explanation when there
        // are too few recorded signings to describe a group.
        { href: "/dashboard/leaderboard", label: "Leaderboard" },
        ...(holdsManagement
          ? [{ href: "/dashboard/goals", label: "Goals" }]
          : []),
      ],
    },
    {
      label: "Learn",
      items: [
        // Free to every subscriber — no product or subscription gate, unlike
        // most of what sits around it.
        { href: "/dashboard/training", label: "Training" },
        { href: "/dashboard/guide", label: "Guide" },
        { href: "/dashboard/objection-assistant", label: "Objection Assistant" },
        { href: "/dashboard/documents", label: "Documents" },
      ],
    },
    {
      label: "Account",
      items: [
        // Shown to everyone: its whole job is to tell a customer about the
        // product they do NOT have, so gating it on holding that product is
        // backwards.
        { href: "/dashboard/packages", label: "Packages" },
        { href: "/dashboard/notifications", label: "Notifications" },
        { href: "/dashboard/settings", label: "Settings" },
        { href: "/dashboard/support", label: "Support" },
      ],
    },
  ];
  if (isAdminUser(user)) {
    navGroups.push({ label: "Admin", href: "/admin" });
  }

  // The mobile menu stays a flat list — it is a full-height vertical sheet with
  // room for every link, so grouping there would add a tap for nothing.
  const nav = navGroups.flatMap((g) =>
    g.href ? [{ href: g.href, label: g.label }] : (g.items ?? [])
  );

  return (
    <div className="min-h-screen bg-muted/20">
      <header className="relative border-b-[0.5px] border-border bg-background">
        <div className="container flex h-16 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-6">
            <Link
              href="/dashboard"
              aria-label="Stayful Lead Database"
              className="flex min-w-0 items-center gap-2.5"
            >
              <Logo height={32} priority />
              <span className="truncate border-l border-border pl-2.5 text-base font-semibold text-foreground">
                Lead Database
              </span>
            </Link>
            <DesktopNav groups={navGroups} />
          </div>
          <div className="flex flex-shrink-0 items-center gap-1">
            {customer && (
              <NotificationBell
                customerId={customer.id}
                initialCount={unread}
              />
            )}
            <SignOutButton />
            <MobileNav items={nav} />
          </div>
        </div>
      </header>
      <main className="container py-8">{children}</main>
      <footer className="border-t-[0.5px] border-border">
        <div className="container flex h-14 items-center justify-center gap-6 text-xs text-muted-foreground">
          <Link href="/feedback?type=feature" className="hover:text-foreground">
            Request a feature
          </Link>
          <Link href="/feedback?type=bug" className="hover:text-foreground">
            Report a bug
          </Link>
        </div>
      </footer>
    </div>
  );
}
