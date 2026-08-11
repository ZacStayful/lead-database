"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { cn } from "@/lib/utils";

type NavItem = { href: string; label: string };

/**
 * Small-screen navigation. The desktop nav is hidden below `lg`, so on phones
 * and tablets this hamburger button reveals a full-width dropdown of the same
 * links — otherwise the whole dashboard is unreachable there.
 *
 * The list stays flat rather than mirroring the desktop grouping: this is a
 * full-height vertical sheet with room for every link, so collapsing them into
 * sections would add a tap and hide nothing worth hiding.
 */
export function MobileNav({ items }: { items: NavItem[] }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Close the menu whenever the route changes (e.g. after tapping a link).
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Prevent the page body from scrolling behind the open menu.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  return (
    /* Hidden from `lg` up, where DesktopNav takes over. These two breakpoints
       must stay in step: the grouped desktop nav needs more room than the old
       flat row, so it starts at `lg`, and anything narrower — tablets included
       — gets this menu instead of a cramped, overlapping header. */
    <div className="lg:hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? "Close menu" : "Open menu"}
        aria-expanded={open}
        className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
      </button>

      {open && (
        <>
          {/* Backdrop below the header; tap to dismiss. */}
          <button
            type="button"
            aria-label="Close menu"
            className="fixed inset-x-0 bottom-0 top-16 z-40 bg-black/20"
            onClick={() => setOpen(false)}
          />
          <nav className="absolute inset-x-0 top-16 z-50 flex flex-col gap-0.5 border-b-[0.5px] border-border bg-background p-2 shadow-sm">
            {items.map((item) => {
              const active =
                item.href === "/dashboard" || item.href === "/admin"
                  ? pathname === item.href
                  : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "rounded-md px-3 py-2.5 text-sm font-medium",
                    active
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground"
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </>
      )}
    </div>
  );
}
