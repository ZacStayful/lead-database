import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentCustomer, isAdminUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { NotificationBell } from "@/components/dashboard/NotificationBell";
import { SignOutButton } from "@/components/dashboard/SignOutButton";
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
    const admin = createAdminClient();
    const { count } = await admin
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("customer_id", customer.id)
      .is("read_at", null);
    unread = count ?? 0;
  }

  const nav = [
    { href: "/dashboard", label: "Dashboard" },
    { href: "/dashboard/leads", label: "Leads" },
    { href: "/dashboard/leads/priority", label: "Priority" },
    { href: "/dashboard/analytics", label: "Analytics" },
    { href: "/dashboard/notifications", label: "Notifications" },
    { href: "/dashboard/settings", label: "Settings" },
  ];
  if (isAdminUser(user)) {
    nav.push({ href: "/admin", label: "Admin" });
  }

  return (
    <div className="min-h-screen bg-muted/20">
      <header className="border-b-[0.5px] border-border bg-background">
        <div className="container flex h-16 items-center justify-between">
          <div className="flex items-center gap-6">
            <Link
              href="/dashboard"
              aria-label="Stayful Lead Database"
              className="flex items-center gap-2.5"
            >
              <Logo height={32} priority />
              <span className="border-l border-border pl-2.5 text-base font-semibold text-foreground">
                Lead Database
              </span>
            </Link>
            <nav className="hidden items-center gap-1 sm:flex">
              {nav.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-1">
            {customer && (
              <NotificationBell
                customerId={customer.id}
                initialCount={unread}
              />
            )}
            <SignOutButton />
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
