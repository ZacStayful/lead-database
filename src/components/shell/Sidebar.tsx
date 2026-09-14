"use client";

import Image from "next/image";
import Link from "next/link";
import { Building2, ChevronsUpDown, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SidebarItem, SidebarModel } from "@/lib/dashboardNav";
import { SIDEBAR_ICONS } from "./icons";

export interface AccountChip {
  name: string;
  subtitle: string;
}

/**
 * The dark 248px rail (§56.7). A static account chip replaces the design's
 * business switcher: both products render side by side everywhere (invariant
 * 6), so there is nothing to switch between.
 */
export function Sidebar({
  model,
  activeKey,
  account,
  onSearch,
  variant = "rail",
  onClose,
}: {
  model: SidebarModel;
  activeKey: string | null;
  account: AccountChip;
  onSearch: () => void;
  /** `rail` is the fixed desktop column; `drawer` is the mobile sheet. */
  variant?: "rail" | "drawer";
  onClose?: () => void;
}) {
  const drawer = variant === "drawer";
  return (
    <aside
      className={cn(
        "no-print flex h-full flex-col bg-sidebar text-sidebar-text",
        drawer ? "w-[280px] px-2 py-4" : "hidden w-[248px] flex-shrink-0 lg:flex"
      )}
    >
      {drawer ? (
        <div className="mb-2 flex items-center justify-between px-2">
          <div className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-white">
            <Image src="/logo.png" alt="Stayful" width={28} height={16} />
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="rounded-md p-2 text-sidebar-text hover:bg-sidebar-chip"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      ) : (
        <div className="flex justify-center pb-3.5 pt-[22px]">
          <Link
            href="/dashboard"
            aria-label="Stayful Lead Database"
            className="flex h-14 w-14 items-center justify-center rounded-[14px] bg-white"
          >
            <Image src="/logo.png" alt="Stayful" width={40} height={23} priority />
          </Link>
        </div>
      )}

      <div className="mx-3.5 mb-3 flex items-center gap-2.5 rounded-[10px] bg-sidebar-chip px-3 py-2.5">
        <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-sidebar">
          <Building2 className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold text-white">{account.name}</div>
          <div className="truncate text-xs text-sidebar-muted">{account.subtitle}</div>
        </div>
        <ChevronsUpDown className="h-3.5 w-3.5 text-sidebar-muted" aria-hidden />
      </div>

      <button
        type="button"
        onClick={onSearch}
        className="mx-3.5 mb-3.5 flex items-center gap-2 rounded-lg border border-sidebar-line px-2.5 py-2 text-left text-sidebar-muted hover:text-sidebar-text"
      >
        <Search className="h-3.5 w-3.5" />
        <span className="flex-1 text-sm">Search</span>
        <kbd className="rounded bg-sidebar-chip px-[5px] py-px text-[11px]">⌘K</kbd>
      </button>

      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2" aria-label="Dashboard">
        {model.main.map((item) => (
          <NavLink key={item.key} item={item} active={activeKey === item.key} />
        ))}
        <div className="mx-3 my-2.5 h-px bg-sidebar-line" role="separator" />
        {model.secondary.map((item) => (
          <NavLink key={item.key} item={item} active={activeKey === item.key} />
        ))}
      </nav>

      <div className="border-t border-sidebar-line p-2">
        <NavLink item={model.bottom} active={activeKey === model.bottom.key} />
        <Link
          href="/feedback?type=bug"
          className="mt-1 block px-3 py-1 text-xs text-sidebar-muted hover:text-sidebar-text"
        >
          Report a bug
        </Link>
      </div>
    </aside>
  );
}

function NavLink({ item, active }: { item: SidebarItem; active: boolean }) {
  const Icon = SIDEBAR_ICONS[item.icon];
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-3 rounded-lg px-3 py-2.5 text-[15px] font-medium transition-colors",
        active ? "bg-sidebar-line text-white" : "text-sidebar-text hover:bg-sidebar-chip"
      )}
    >
      <Icon className="h-[18px] w-[18px] flex-shrink-0" />
      <span className="flex-1 truncate">{item.label}</span>
      {item.badge !== undefined && (
        <span className="rounded-full bg-brand px-[7px] py-px text-[11px] font-semibold text-white">
          {item.badge > 99 ? "99+" : item.badge}
        </span>
      )}
    </Link>
  );
}
