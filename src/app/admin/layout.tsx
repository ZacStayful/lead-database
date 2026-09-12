import Link from "next/link";
import { redirect } from "next/navigation";
import { getUser, isAdminUser } from "@/lib/auth";
import { SignOutButton } from "@/components/dashboard/SignOutButton";
import { MobileNav } from "@/components/dashboard/MobileNav";
import { DesktopNav, type NavGroup } from "@/components/dashboard/DesktopNav";
import { Logo } from "@/components/Logo";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getUser();
  if (!user) redirect("/login");
  if (!isAdminUser(user)) redirect("/dashboard");

  /**
   * Grouped, as the customer header has been since §50.8.
   *
   * Fourteen flat links had outgrown the row: they wrapped on a laptop, carried
   * no active state at all, and the two pages an admin opens daily sat between
   * Training and Announcements with nothing to tell them apart.
   *
   * `DesktopNav` is reused unchanged — it takes only `groups` and derives
   * active state from `usePathname()` by longest-prefix match, so `/admin`
   * under Insights does not light up on `/admin/leads`.
   */
  const navGroups: NavGroup[] = [
    {
      label: "Leads",
      items: [
        { href: "/admin/leads", label: "Leads" },
        { href: "/admin/imported-leads", label: "Imported leads" },
        { href: "/admin/pool", label: "Expired leads" },
        { href: "/admin/quality", label: "Lead quality" },
        { href: "/admin/allocation", label: "Allocation" },
      ],
    },
    {
      label: "Customers",
      items: [
        { href: "/admin/customers", label: "Customers" },
        { href: "/admin/offers", label: "Offers" },
      ],
    },
    {
      label: "Insights",
      items: [
        { href: "/admin", label: "Overview" },
        { href: "/admin/outcomes", label: "Outcomes" },
      ],
    },
    {
      label: "Content",
      items: [
        { href: "/admin/training", label: "Training" },
        { href: "/admin/announcements", label: "Announcements" },
      ],
    },
    {
      label: "System",
      items: [
        { href: "/admin/messaging", label: "Messaging" },
        { href: "/admin/api", label: "API" },
        { href: "/admin/support", label: "Support" },
      ],
    },
    { label: "Customer portal", href: "/dashboard" },
  ];

  // The mobile menu stays a flat list, exactly as the dashboard layout does it:
  // a full-height sheet has room for every link, so grouping there would add a
  // tap for nothing.
  const nav = navGroups.flatMap((g) =>
    g.href ? [{ href: g.href, label: g.label }] : (g.items ?? [])
  );

  return (
    <div className="min-h-screen bg-muted/20">
      <header className="relative border-b-[0.5px] border-border bg-background">
        <div className="container flex h-16 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-6">
            <Link href="/admin" className="flex min-w-0 items-center gap-2" aria-label="Stayful admin">
              <Logo height={32} priority />
              <span className="rounded bg-brand/10 px-2 py-0.5 text-xs font-medium text-brand">
                Admin
              </span>
            </Link>
            {/*
              ⚠️ This also fixes a breakpoint bug. The old row was `sm:flex`
              while `MobileNav` is `lg:hidden`, so between those two widths BOTH
              rendered. `DesktopNav` is `lg:flex`, which puts the pair back in
              step — the dashboard layout has always had them that way.
            */}
            <DesktopNav groups={navGroups} />
          </div>
          <div className="flex flex-shrink-0 items-center gap-1">
            <SignOutButton />
            <MobileNav items={nav} />
          </div>
        </div>
      </header>
      <main className="container py-8">{children}</main>
    </div>
  );
}
