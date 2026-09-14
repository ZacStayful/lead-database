"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import {
  activeSidebarKey,
  activeTabHref,
  isColumnsPath,
  sectionTitle,
  tabsetFor,
  type NavFlags,
  type SidebarModel,
} from "@/lib/dashboardNav";
import { cn } from "@/lib/utils";
import { CommandPalette, type PaletteLead } from "./CommandPalette";
import { Sidebar, type AccountChip } from "./Sidebar";
import { SubTabs } from "./SubTabs";
import { TopBar } from "./TopBar";

/**
 * The dashboard chrome (§56.7): sidebar · top bar · sub-tabs · page. Built
 * once here so every route under /dashboard renders inside the same frame.
 * The nav model and the flags arrive from the server layout; only the active
 * state and the two open/closed toggles live in the browser.
 */
export function AppShell({
  model,
  flags,
  account,
  initials,
  bell,
  paletteLeads,
  children,
}: {
  model: SidebarModel;
  flags: NavFlags;
  account: AccountChip;
  initials: string;
  bell: React.ReactNode;
  paletteLeads: PaletteLead[];
  children: React.ReactNode;
}) {
  const pathname = usePathname() ?? "/dashboard";
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);

  useEffect(() => setDrawer(false), [pathname]);
  useEffect(() => {
    if (!drawer) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [drawer]);

  const activeKey = activeSidebarKey(model, pathname);
  const tabset = tabsetFor(pathname, flags);
  const columns = isColumnsPath(pathname);

  return (
    <div className="flex h-screen overflow-hidden bg-page font-body text-[14px] leading-[1.45] text-ink antialiased">
      <Sidebar model={model} activeKey={activeKey} account={account} onSearch={() => setPalette(true)} />

      {drawer && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setDrawer(false)} aria-hidden />
          <div className="absolute bottom-0 left-0 top-0 z-50 overflow-y-auto">
            <Sidebar
              variant="drawer"
              model={model}
              activeKey={activeKey}
              account={account}
              onSearch={() => {
                setDrawer(false);
                setPalette(true);
              }}
              onClose={() => setDrawer(false)}
            />
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          title={tabset ? null : sectionTitle(pathname)}
          bell={bell}
          initials={initials}
          onMenu={() => setDrawer(true)}
        />
        {tabset && (
          <SubTabs tabset={tabset} activeHref={activeTabHref(tabset, pathname)} showTitle />
        )}
        <main
          className={cn(
            "flex-1",
            columns ? "flex min-h-0 gap-3 overflow-hidden p-3" : "overflow-y-auto p-4 sm:p-5"
          )}
        >
          {columns ? children : <div className="mx-auto max-w-6xl">{children}</div>}
        </main>
      </div>

      <CommandPalette open={palette} onOpenChange={setPalette} model={model} leads={paletteLeads} />
    </div>
  );
}
