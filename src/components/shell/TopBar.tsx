"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { Menu } from "lucide-react";
import { SignOutButton } from "@/components/dashboard/SignOutButton";

/**
 * The 60px white bar (§56.7). The design's Call button is cut — there is
 * nobody to call from here. The avatar opens a two-item menu: Settings and
 * sign out, which the old header kept as a bare icon.
 */
export function TopBar({
  title,
  bell,
  initials,
  onMenu,
}: {
  /** Shown only when the section has no sub-tab strip. */
  title: string | null;
  bell: React.ReactNode;
  initials: string;
  onMenu: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <header className="flex h-[60px] flex-shrink-0 items-center justify-between gap-3 border-b border-line bg-white px-5">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={onMenu}
          aria-label="Open menu"
          className="-ml-2 rounded-md p-2 text-ink lg:hidden"
        >
          <Menu className="h-[22px] w-[22px]" />
        </button>
        <Link href="/dashboard" className="lg:hidden" aria-label="Dashboard">
          <Image src="/logo.png" alt="Stayful" width={45} height={26} />
        </Link>
        {title && (
          <h1 className="truncate font-display text-xl font-semibold tracking-[-0.01em] text-ink">
            {title}
          </h1>
        )}
      </div>
      <div className="flex flex-shrink-0 items-center gap-2.5">
        {bell}
        <div className="relative" ref={ref}>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label="Account menu"
            className="flex h-[38px] w-[38px] items-center justify-center rounded-full bg-brand-light text-[13px] font-bold text-brand-dark"
          >
            {initials}
          </button>
          {open && (
            <div
              role="menu"
              className="absolute right-0 top-full z-50 mt-1 min-w-[10rem] rounded-lg border border-line bg-white p-1"
            >
              <Link
                href="/dashboard/settings"
                role="menuitem"
                onClick={() => setOpen(false)}
                className="block rounded-md px-3 py-2 text-sm text-ink hover:bg-page"
              >
                Settings
              </Link>
              <div className="flex items-center justify-between rounded-md px-3 py-1 text-sm text-ink-2">
                <span>Sign out</span>
                <SignOutButton />
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
