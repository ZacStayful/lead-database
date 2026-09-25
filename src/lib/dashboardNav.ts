/**
 * The customer dashboard's navigation model (§56.7).
 *
 * One pure function decides what the sidebar and the sub-tab strip offer,
 * built on the server from the same flags `dashboard/layout.tsx` has always
 * resolved (messaging switch, held products, admin). The shell renders it and
 * knows nothing about why an item is present.
 *
 * ⚠️ IMPORT-FREE ON PURPOSE. `Sidebar` and `SubTabs` are "use client"
 * components, and this file is what lets them share one definition with the
 * server without dragging supabase-js into the browser bundle (§21.8's rule).
 * The two path constants below are therefore restated here rather than
 * imported; `dashboardNav.test.ts` pins them against their sources.
 *
 * Three things the design left out and this deliberately keeps:
 * - "Request a feature" stays a DIRECT sidebar link (§50.8 — folding it into
 *   a menu puts the promoted thing one click deeper than the footer link it
 *   replaced).
 * - "Replace a lead" (§53) is a sidebar item of its own directly under Leads
 *   AND stays in the Leads tabset (§61) — a live money feature that nobody
 *   found while it was a sub-tab alone.
 * - Admin, appended for admins, exactly as the old header did.
 */

/** Restated, not imported (see header). */
export const REPLACEMENTS_HREF = "/dashboard/replacements";
export const FEATURE_REQUEST_HREF = "/feedback?type=feature&page=Header";
export const ADS_HREF = "/dashboard/ads";

export type SidebarIconKey =
  | "dashboard"
  | "conversations"
  | "leads"
  | "replacements"
  | "ads"
  | "followups"
  | "filtering"
  | "insights"
  | "learn"
  | "documents"
  | "billing"
  | "api"
  | "support"
  | "feature"
  | "admin"
  | "settings";

export interface SidebarItem {
  key: string;
  label: string;
  href: string;
  icon: SidebarIconKey;
  badge?: number;
  /** Extra path prefixes that light this item (design's tab overrides). */
  matches?: string[];
}

export interface SidebarModel {
  main: SidebarItem[];
  secondary: SidebarItem[];
  bottom: SidebarItem;
}

export interface TabItem {
  label: string;
  href: string;
}

export interface Tabset {
  /** Section title shown beside the tabs (desktop) or in the top bar (mobile). */
  title: string;
  tabs: TabItem[];
}

export interface NavFlags {
  messagingOn: boolean;
  /**
   * ⚠️ ADDING A FIELD HERE IS A `tsc` CHANGE, NOT A `vitest` ONE. Vitest
   * transpiles through esbuild and does not typecheck, so an object-literal
   * fixture missing this passes the suite and fails `next build` with TS2741.
   */
  adsOn: boolean;
  holdsManagement: boolean;
  holdsAny: boolean;
  isAdmin: boolean;
  unreadReplies: number;
}

export function buildSidebar(f: NavFlags): SidebarModel {
  const main: SidebarItem[] = [
    { key: "dashboard", label: "Dashboard", href: "/dashboard", icon: "dashboard" },
    {
      key: "conversations",
      label: "Conversations",
      href: "/dashboard/conversations",
      icon: "conversations",
      badge: f.unreadReplies > 0 ? f.unreadReplies : undefined,
    },
    {
      key: "leads",
      label: "Leads",
      href: "/dashboard/leads",
      icon: "leads",
      matches: ["/dashboard/topup"],
    },
    {
      key: "replacements",
      label: "Replace a lead",
      href: REPLACEMENTS_HREF,
      icon: "replacements",
    },
    // Demo-only today (§65), which is why it is a flag rather than a constant.
    ...(f.adsOn
      ? [{ key: "ads", label: "Facebook ads", href: ADS_HREF, icon: "ads" as const }]
      : []),
    ...(f.messagingOn
      ? [
          {
            key: "followups",
            label: "Follow-ups",
            href: "/dashboard/follow-ups",
            icon: "followups" as const,
          },
        ]
      : []),
    { key: "filtering", label: "Lead filtering", href: "/dashboard/filtering", icon: "filtering" },
    {
      key: "insights",
      label: "Insights",
      href: "/dashboard/analytics",
      icon: "insights",
      matches: ["/dashboard/leaderboard", "/dashboard/goals"],
    },
    {
      key: "learn",
      label: "Learn",
      href: "/dashboard/training",
      icon: "learn",
      matches: ["/dashboard/guide", "/dashboard/objection-assistant"],
    },
    { key: "documents", label: "Documents", href: "/dashboard/documents", icon: "documents" },
  ];
  const secondary: SidebarItem[] = [
    { key: "billing", label: "Packages & top up", href: "/dashboard/packages", icon: "billing" },
    ...(f.holdsAny
      ? [{ key: "api", label: "API access", href: "/dashboard/api", icon: "api" as const }]
      : []),
    { key: "support", label: "Support", href: "/dashboard/support", icon: "support" },
    { key: "feature", label: "Request a feature", href: FEATURE_REQUEST_HREF, icon: "feature" },
    ...(f.isAdmin ? [{ key: "admin", label: "Admin", href: "/admin", icon: "admin" as const }] : []),
  ];
  return {
    main,
    secondary,
    bottom: { key: "settings", label: "Settings", href: "/dashboard/settings", icon: "settings" },
  };
}

/**
 * Which sidebar item a path lights. Longest matching prefix wins, so
 * `/dashboard/leads/priority` lights Leads and `/dashboard` lights only
 * Dashboard. `/dashboard/leads/[id]` lights Leads: the design lights
 * Conversations for a lead opened FROM the inbox, which is
 * `/dashboard/conversations/[leadId]` here and lights itself.
 */
export function activeSidebarKey(model: SidebarModel, pathname: string): string | null {
  const all = [...model.main, ...model.secondary, model.bottom];
  let best: { key: string; len: number } | null = null;
  for (const item of all) {
    for (const prefix of [item.href, ...(item.matches ?? [])]) {
      const p = prefix.split("?")[0];
      const hit = pathname === p || pathname.startsWith(p + "/");
      if (hit && (!best || p.length > best.len)) best = { key: item.key, len: p.length };
    }
  }
  return best?.key ?? null;
}

/**
 * The sub-tab strip for a path, or null for sections with none (the title
 * then moves into the top bar, as the design does).
 */
export function tabsetFor(pathname: string, f: NavFlags): Tabset | null {
  const p = pathname.split("?")[0];
  const under = (base: string) => p === base || p.startsWith(base + "/");

  if (under("/dashboard/conversations") || under("/dashboard/follow-ups")) {
    return {
      title: "Conversations",
      tabs: [
        { label: "Inbox", href: "/dashboard/conversations" },
        ...(f.messagingOn ? [{ label: "Follow-ups", href: "/dashboard/follow-ups" }] : []),
        { label: "Snippets", href: "/dashboard/conversations/snippets" },
        ...(f.messagingOn
          ? [{ label: "Messaging setup", href: "/dashboard/settings/messaging" }]
          : []),
      ],
    };
  }
  if (
    under("/dashboard/leads") ||
    under(REPLACEMENTS_HREF) ||
    under("/dashboard/filtering") ||
    under("/dashboard/topup")
  ) {
    return {
      title: "Leads",
      tabs: [
        { label: "All leads", href: "/dashboard/leads" },
        { label: "Priority", href: "/dashboard/leads/priority" },
        { label: "Expired", href: "/dashboard/leads/expired" },
        { label: "Add your own", href: "/dashboard/leads/add" },
        { label: "Replace a lead", href: REPLACEMENTS_HREF },
        { label: "Lead filtering", href: "/dashboard/filtering" },
        { label: "Top up", href: "/dashboard/topup" },
      ],
    };
  }
  if (under("/dashboard/analytics") || under("/dashboard/leaderboard") || under("/dashboard/goals")) {
    return {
      title: "Insights",
      tabs: [
        { label: "Analytics", href: "/dashboard/analytics" },
        { label: "Leaderboard", href: "/dashboard/leaderboard" },
        ...(f.holdsManagement ? [{ label: "Goals", href: "/dashboard/goals" }] : []),
      ],
    };
  }
  if (
    under("/dashboard/training") ||
    under("/dashboard/guide") ||
    under("/dashboard/objection-assistant") ||
    under("/dashboard/documents")
  ) {
    return {
      title: "Learn",
      tabs: [
        { label: "Training", href: "/dashboard/training" },
        { label: "Guide", href: "/dashboard/guide" },
        { label: "Objection Assistant", href: "/dashboard/objection-assistant" },
        { label: "Documents", href: "/dashboard/documents" },
      ],
    };
  }
  if (f.adsOn && under(ADS_HREF)) {
    return {
      title: "Facebook ads",
      tabs: [
        { label: "Make an ad", href: ADS_HREF },
        { label: "Business details", href: `${ADS_HREF}/profile` },
      ],
    };
  }
  if (under("/dashboard/packages")) {
    return {
      title: "Packages & top up",
      tabs: [
        { label: "Packages", href: "/dashboard/packages" },
        { label: "Top up", href: "/dashboard/topup" },
      ],
    };
  }
  if (under("/dashboard/settings")) {
    return {
      title: "Settings",
      tabs: [
        { label: "Profile", href: "/dashboard/settings#profile" },
        { label: "Notifications", href: "/dashboard/settings#notifications" },
        ...(f.messagingOn ? [{ label: "Messaging", href: "/dashboard/settings/messaging" }] : []),
        { label: "Billing", href: "/dashboard/settings#subscription" },
      ],
    };
  }
  return null;
}

/** The top-bar title for a path with no tabset. */
export function sectionTitle(pathname: string): string {
  const p = pathname.split("?")[0];
  if (p === "/dashboard") return "Dashboard";
  if (p.startsWith("/dashboard/api")) return "API access";
  if (p.startsWith("/dashboard/support")) return "Support";
  if (p.startsWith("/dashboard/notifications")) return "Notifications";
  if (p.startsWith("/dashboard/replacements")) return "Replace a lead";
  // ⚠️ Without this the top bar reads "Lead Database" on a page that is
  // plainly about something else, which an existing test encodes as a rule
  // without tripping on it.
  if (p.startsWith(ADS_HREF)) return "Facebook ads";
  return "Lead Database";
}

/**
 * Which tab is active. A hash tab (Settings) is active only when the path
 * matches and no other tab is a longer match; the strip cannot see the hash on
 * the server, so the first hash tab of a section is the resting state.
 */
export function activeTabHref(tabset: Tabset, pathname: string): string | null {
  const p = pathname.split("?")[0];
  let best: { href: string; len: number } | null = null;
  for (const t of tabset.tabs) {
    const base = t.href.split("#")[0];
    const hit = p === base || p.startsWith(base + "/");
    if (!hit) continue;
    // Prefer an exact, hash-free match; among hash tabs the first wins.
    const len = base.length + (t.href.includes("#") ? 0 : 1);
    if (!best || len > best.len) best = { href: t.href, len };
  }
  return best?.href ?? null;
}

/**
 * Pages that own the whole viewport as three columns (§56.7): the inbox and a
 * lead's workspace. The shell gives them `overflow:hidden` and 12px gutters
 * instead of the scrolling 20px page every other route gets.
 */
export function isColumnsPath(pathname: string): boolean {
  const p = pathname.split("?")[0].replace(/\/$/, "");
  if (/^\/dashboard\/conversations(\/[^/]+)?$/.test(p) && !p.endsWith("/snippets")) return true;
  if (/^\/dashboard\/leads\/[^/]+$/.test(p)) {
    return !["priority", "add", "expired"].includes(p.split("/").pop() ?? "");
  }
  return false;
}
