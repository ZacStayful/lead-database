import Link from "next/link";
import { redirect } from "next/navigation";
import { getUser, isAdminUser } from "@/lib/auth";
import { SignOutButton } from "@/components/dashboard/SignOutButton";
import { MobileNav } from "@/components/dashboard/MobileNav";
import { Logo } from "@/components/Logo";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getUser();
  if (!user) redirect("/login");
  if (!isAdminUser(user)) redirect("/dashboard");

  const nav = [
    { href: "/admin", label: "Overview" },
    { href: "/admin/customers", label: "Customers" },
    { href: "/admin/leads", label: "Leads" },
    { href: "/dashboard", label: "Customer portal" },
  ];

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
