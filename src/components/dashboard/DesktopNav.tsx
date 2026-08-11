"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export type NavItem = { href: string; label: string };

/**
 * A top-level header entry: either a direct link (no `items`) or a menu.
 */
export type NavGroup = {
  label: string;
  /** Direct-link groups only. */
  href?: string;
  /** Menu groups only. */
  items?: NavItem[];
};

/**
 * Desktop header navigation.
 *
 * The header used to render every destination as a flat row of links. At
 * sixteen of them the row could not fit beside the logo, and because the nav
 * sits in the same flex row as the notification bell and sign-out, the overflow
 * ran underneath them — the last item ("Admin", appended for admins) collided
 * with the bell. Nothing was clipped, so it looked like a z-index bug rather
 * than a width one.
 *
 * Grouping is the fix rather than scrolling or truncation: every destination is
 * still one or two clicks away and none is hidden behind an unlabelled overflow
 * arrow. Groups are passed in from the layout so the gating rules (management
 * only sees Goals, admins see Admin) stay in one place on the server.
 */
export function DesktopNav({ groups }: { groups: NavGroup[] }) {
  const [openLabel, setOpenLabel] = useState<string | null>(null);
  const pathname = usePathname();
  const navRef = useRef<HTMLElement | null>(null);

  // Close on route change, so following a link never leaves the menu hanging.
  useEffect(() => {
    setOpenLabel(null);
  }, [pathname]);

  // Close on Escape or a click anywhere outside the nav.
  useEffect(() => {
    if (!openLabel) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpenLabel(null);
    }
    function onPointer(e: PointerEvent) {
      if (!navRef.current?.contains(e.target as Node)) setOpenLabel(null);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [openLabel]);

  // The active destination is the LONGEST href that prefixes the current path.
  // A plain `startsWith` would light up "Dashboard" (/dashboard) on every page,
  // and "Leads" (/dashboard/leads) on /dashboard/leads/priority as well as
  // Priority itself. Longest-match picks the one the user is actually on.
  const allHrefs = groups.flatMap((g) =>
    g.href ? [g.href] : (g.items ?? []).map((i) => i.href)
  );
  const activeHref = allHrefs
    .filter((h) => pathname === h || pathname.startsWith(`${h}/`))
    .sort((a, b) => b.length - a.length)[0];

  const groupIsActive = (group: NavGroup) =>
    group.href
      ? group.href === activeHref
      : (group.items ?? []).some((i) => i.href === activeHref);

  return (
    <nav ref={navRef} className="hidden items-center gap-0.5 lg:flex">
      {groups.map((group) => {
        const active = groupIsActive(group);

        if (group.href) {
          return (
            <Link
              key={group.label}
              href={group.href}
              className={cn(
                "rounded-md px-2.5 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
            >
              {group.label}
            </Link>
          );
        }

        const open = openLabel === group.label;
        return (
          <div key={group.label} className="relative">
            <button
              type="button"
              onClick={() => setOpenLabel(open ? null : group.label)}
              aria-expanded={open}
              aria-haspopup="menu"
              className={cn(
                "flex items-center gap-1 rounded-md px-2.5 py-2 text-sm font-medium transition-colors",
                active || open
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
            >
              {group.label}
              <ChevronDown
                className={cn(
                  "h-3.5 w-3.5 transition-transform",
                  open && "rotate-180"
                )}
              />
            </button>

            {open && (
              <div
                role="menu"
                className="absolute left-0 top-full z-50 mt-1 min-w-[13rem] rounded-lg border-[0.5px] border-border bg-background p-1 shadow-lg"
              >
                {(group.items ?? []).map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    role="menuitem"
                    className={cn(
                      "block rounded-md px-3 py-2 text-sm transition-colors",
                      item.href === activeHref
                        ? "bg-accent font-medium text-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground"
                    )}
                  >
                    {item.label}
                  </Link>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}
