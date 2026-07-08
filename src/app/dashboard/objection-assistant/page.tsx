"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Search, List, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  FAQS,
  CATEGORIES,
  TIERS,
  PROFILES,
  INTENTS,
  type Faq,
  type TierKey,
  type IntentKey,
} from "./_lib/faqData";
import {
  rankMatches,
  FAQ_BY_ID,
  CLOSEST_MATCH_THRESHOLD,
  type Match,
} from "./_lib/matching";

// Tier / intent badge colours, mapped to the dashboard's status-badge language
// (bg-*-100 / text-*-700 pills) rather than the reference's dark-theme dots.
const TIER_BADGE: Record<TierKey, string> = {
  1: "border-transparent bg-green-100 text-green-700",
  2: "border-transparent bg-amber-100 text-amber-700",
  3: "border-transparent bg-blue-100 text-blue-700",
  4: "border-transparent bg-gray-100 text-gray-600",
};

const INTENT_BADGE: Record<IntentKey, string> = {
  buying: "border-transparent bg-green-100 text-green-700",
  evaluating: "border-transparent bg-amber-100 text-amber-700",
  concern: "border-transparent bg-rose-100 text-rose-700",
};

const INTENT_MARK: Record<IntentKey, string> = {
  buying: "▲",
  evaluating: "•",
  concern: "▼",
};

function TierBadge({ tier }: { tier: TierKey }) {
  return <Badge className={TIER_BADGE[tier]}>{TIERS[tier].short}</Badge>;
}

function IntentBadge({ intent }: { intent: IntentKey }) {
  const i = INTENTS[intent];
  if (!i) return null;
  return (
    <Badge className={INTENT_BADGE[intent]}>
      {INTENT_MARK[intent]} {i.short}
    </Badge>
  );
}

function AnswerPanel({
  faq,
  expanded,
  onToggle,
}: {
  faq: Faq | null;
  expanded: boolean;
  onToggle: () => void;
}) {
  if (!faq) return null;
  return (
    <article
      key={faq.id}
      className="rounded-xl border border-black/10 bg-white p-5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <TierBadge tier={faq.tier} />
        <IntentBadge intent={faq.intent} />
        <span className="text-xs font-medium text-[#898781]">{faq.category}</span>
        <span className="ml-auto text-xs text-[#898781]">Q{faq.id}</span>
      </div>
      <p className="mt-3 text-sm font-medium text-[#52514e]">{faq.question}</p>
      {/* The headline is the short, speakable line — lead with it. */}
      <p className="mt-1 text-lg font-semibold leading-snug text-[#1a1a19]">
        {faq.headline}
      </p>
      {faq.profiles && faq.profiles.length < PROFILES.length && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {faq.profiles.map((p) => (
            <Badge key={p} className="border border-black/10 bg-transparent text-[#52514e]">
              {p}
            </Badge>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={onToggle}
        className="mt-4 text-sm font-medium text-[#5D8156] hover:underline"
      >
        {expanded ? "▾ Hide detail" : "▸ Need more detail?"}
      </button>
      {expanded && (
        <p className="mt-3 text-sm leading-relaxed text-[#1a1a19]">{faq.answer}</p>
      )}
    </article>
  );
}

export default function ObjectionAssistantPage() {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [pinned, setPinned] = useState<Faq | null>(null); // faq chosen from Browse / suggestion
  const [mode, setMode] = useState<"listen" | "browse">("listen");
  const [browseCat, setBrowseCat] = useState("All");
  const [profile, setProfile] = useState(""); // '' = all profiles
  const [focused, setFocused] = useState(false); // search input focus
  const [suggestIndex, setSuggestIndex] = useState(-1);
  const [viewed, setViewed] = useState<number[]>([]); // FAQ ids the lead has prompted, this call

  const inputRef = useRef<HTMLInputElement>(null);

  const ranked = useMemo(() => rankMatches(query, profile), [query, profile]);
  const current = pinned || ranked[activeIndex]?.faq || null;
  const alternates = ranked.slice(0, 6);
  const suggestions = useMemo<Match[]>(
    () => (query.trim() ? ranked.slice(0, 6) : []),
    [query, ranked]
  );
  const topScore = ranked[0]?.score ?? 0;
  const approximate = !pinned && current && topScore < CLOSEST_MATCH_THRESHOLD;
  const showSuggest = focused && !pinned && suggestions.length > 0;

  // Buying temperature — averages the intent of the questions looked up so far.
  const temp = useMemo(() => {
    if (!viewed.length) return { pct: 0, count: 0, label: "No reads yet" };
    const sum = viewed.reduce(
      (a, id) => a + (INTENTS[FAQ_BY_ID[id]?.intent]?.weight ?? 1),
      0
    );
    const pct = Math.round((sum / (viewed.length * 2)) * 100);
    const label =
      pct >= 66
        ? "Hot — strong buying signals"
        : pct >= 45
        ? "Warm — engaged"
        : pct >= 25
        ? "Cooling — mostly concerns"
        : "Cold — concerns";
    return { pct, count: viewed.length, label };
  }, [viewed]);

  // Count an answer as "read" once it's been on screen briefly (ignores the
  // flicker of partial matches while typing).
  useEffect(() => {
    if (!current) return;
    const id = current.id;
    const t = setTimeout(() => {
      setViewed((v) => (v.includes(id) ? v : [...v, id]));
    }, 1200);
    return () => clearTimeout(t);
  }, [current]);

  // New query → reset focus to the top match and clear any pinned card.
  useEffect(() => {
    setActiveIndex(0);
    setExpanded(false);
    setPinned(null);
    setSuggestIndex(-1);
  }, [query]);

  // Picking a suggestion focuses that card but keeps the ranked options
  // available below (and you can re-open suggestions with Back).
  function pickSuggestion(faq: Faq) {
    const idx = ranked.findIndex((r) => r.faq.id === faq.id);
    setActiveIndex(idx >= 0 ? idx : 0);
    setFocused(false);
    setSuggestIndex(-1);
    setExpanded(false);
    inputRef.current?.blur();
  }

  function goBack() {
    if (pinned) {
      setPinned(null);
      setMode("browse");
      return;
    }
    // Return to the recommended list: top match + re-open suggestions.
    setActiveIndex(0);
    setExpanded(false);
    setFocused(true);
    inputRef.current?.focus();
  }

  function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!showSuggest) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSuggestIndex((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSuggestIndex((i) => Math.max(i - 1, -1));
    } else if (e.key === "Enter" && suggestIndex >= 0 && suggestions[suggestIndex]) {
      e.preventDefault();
      pickSuggestion(suggestions[suggestIndex].faq);
    }
  }

  // "/" focuses search, Escape clears.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (
        e.key === "/" &&
        document.activeElement !== inputRef.current &&
        mode === "listen"
      ) {
        e.preventDefault();
        inputRef.current?.focus();
      } else if (e.key === "Escape") {
        setQuery("");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode]);

  function pickCard(faq: Faq) {
    setQuery("");
    setPinned(faq);
    setExpanded(false);
    setMode("listen");
  }

  const browseList = useMemo(() => {
    const list = FAQS.filter(
      (f) =>
        (browseCat === "All" || f.category === browseCat) &&
        (profile === "" || f.profiles?.includes(profile))
    );
    return [...list].sort((a, b) => a.tier - b.tier || a.id - b.id);
  }, [browseCat, profile]);

  const tempFill =
    temp.pct >= 66
      ? "rgb(93,129,86)"
      : temp.pct >= 45
      ? "#d99a2b"
      : temp.pct >= 25
      ? "#c98a4a"
      : "#c2685a";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[#1a1a19]">
            Objection Assistant
          </h1>
          <p className="text-sm text-[#52514e]">
            {mode === "listen"
              ? "Search a landlord objection — the answer surfaces instantly"
              : "Browse all answers by category"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setMode((m) => (m === "listen" ? "browse" : "listen"))}
          className="inline-flex items-center gap-2 rounded-lg border border-[#5D8156] px-6 py-3 text-sm font-medium text-[#5D8156] transition-colors hover:bg-[#EAF3DE]"
        >
          {mode === "listen" ? (
            <>
              <List className="h-4 w-4" /> Browse
            </>
          ) : (
            <>
              <X className="h-4 w-4" /> Close
            </>
          )}
        </button>
      </div>

      {/* Buying temperature */}
      <div className="rounded-xl border border-black/10 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-medium text-[#1a1a19]">
              Buying temperature
            </span>
            <span className="text-sm text-[#52514e]">
              {temp.label}
              {temp.count > 0 && (
                <span className="text-[#898781]"> · {temp.count} read</span>
              )}
            </span>
          </div>
          {viewed.length > 0 && (
            <button
              type="button"
              onClick={() => setViewed([])}
              className="text-xs font-medium text-[#898781] hover:text-[#52514e]"
            >
              Reset
            </button>
          )}
        </div>
        <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-black/5">
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${temp.pct}%`, background: tempFill }}
          />
        </div>
      </div>

      {/* Lead profile filter */}
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium text-[#52514e]">Lead profile</span>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setProfile("")}
            className={cn(
              "rounded-full border px-3 py-1 text-sm font-medium transition-colors",
              profile === ""
                ? "border-[#5D8156] bg-[#EAF3DE] text-[#5D8156]"
                : "border-black/10 text-[#52514e] hover:bg-muted"
            )}
          >
            All
          </button>
          {PROFILES.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setProfile((cur) => (cur === p ? "" : p))}
              className={cn(
                "rounded-full border px-3 py-1 text-sm font-medium transition-colors",
                profile === p
                  ? "border-[#5D8156] bg-[#EAF3DE] text-[#5D8156]"
                  : "border-black/10 text-[#52514e] hover:bg-muted"
              )}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      {mode === "listen" ? (
        <div className="space-y-4">
          {/* Search */}
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#898781]" />
            <Input
              ref={inputRef}
              type="text"
              inputMode="search"
              placeholder="Search a question…  ( / to focus )"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setTimeout(() => setFocused(false), 120)}
              onKeyDown={onSearchKeyDown}
              autoComplete="off"
              autoFocus
              className="h-12 pl-9 pr-9 text-base"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                title="Clear"
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[#898781] hover:text-[#52514e]"
              >
                <X className="h-4 w-4" />
              </button>
            )}

            {showSuggest && (
              <ul className="absolute z-20 mt-1 w-full overflow-hidden rounded-xl border border-black/10 bg-white shadow-sm">
                {suggestions.map((s, i) => (
                  <li key={s.faq.id}>
                    <button
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        pickSuggestion(s.faq);
                      }}
                      className={cn(
                        "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors",
                        i === suggestIndex ? "bg-[#EAF3DE]" : "hover:bg-muted"
                      )}
                    >
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ background: TIERS[s.faq.tier].color }}
                      />
                      <span className="flex-1 truncate text-[#1a1a19]">
                        {s.faq.question}
                      </span>
                      <span className="shrink-0 text-xs text-[#898781]">
                        {s.faq.category}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {approximate && (
            <p className="text-sm text-[#898781]">
              No exact answer for that — here’s the closest match that may help.
            </p>
          )}

          {current && (pinned || activeIndex > 0) && (
            <button
              type="button"
              onClick={goBack}
              className="text-sm font-medium text-[#5D8156] hover:underline"
            >
              ← Back to {pinned ? "browse" : "options"}
            </button>
          )}

          {current ? (
            <AnswerPanel
              faq={current}
              expanded={expanded}
              onToggle={() => setExpanded((e) => !e)}
            />
          ) : (
            <div className="rounded-xl border border-black/10 bg-white p-6">
              <p className="text-sm font-medium text-[#1a1a19]">
                {query ? "No match — try different words." : "Type to begin."}
              </p>
              <p className="mt-1 text-sm text-[#52514e]">
                Tip: restate the landlord’s question — “so you’re asking how the
                fees work?” — and the answer appears.
              </p>
            </div>
          )}

          {!pinned && alternates.length > 1 && (
            <div className="space-y-2">
              <span className="text-xs font-medium uppercase tracking-wide text-[#898781]">
                Other options
              </span>
              <div className="flex flex-col gap-2">
                {alternates.map((a, i) => (
                  <button
                    key={a.faq.id}
                    type="button"
                    onClick={() => {
                      setActiveIndex(i);
                      setExpanded(false);
                    }}
                    style={{ borderLeftColor: TIERS[a.faq.tier].color }}
                    className={cn(
                      "flex items-center gap-2 rounded-lg border border-black/10 border-l-4 px-3 py-2 text-left text-sm transition-colors",
                      i === activeIndex
                        ? "bg-[#EAF3DE] text-[#1a1a19]"
                        : "bg-white text-[#52514e] hover:bg-muted"
                    )}
                  >
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ background: INTENTS[a.faq.intent]?.color }}
                    />
                    {a.faq.headline}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {/* Category tabs */}
          <nav className="flex flex-wrap gap-1 border-b border-black/10 pb-2">
            {CATEGORIES.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setBrowseCat(cat)}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  browseCat === cat
                    ? "bg-[#EAF3DE] text-[#5D8156]"
                    : "text-[#52514e] hover:bg-muted"
                )}
              >
                {cat}
              </button>
            ))}
          </nav>
          <div className="grid gap-3 sm:grid-cols-2">
            {browseList.map((faq) => (
              <button
                key={faq.id}
                type="button"
                onClick={() => pickCard(faq)}
                style={{ borderLeftColor: TIERS[faq.tier].color }}
                className="flex flex-col gap-1.5 rounded-xl border border-black/10 border-l-4 bg-white p-4 text-left transition-colors hover:bg-muted"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <TierBadge tier={faq.tier} />
                  <IntentBadge intent={faq.intent} />
                  <span className="text-xs font-medium text-[#898781]">
                    {faq.category}
                  </span>
                </div>
                <span className="text-sm font-medium text-[#52514e]">
                  {faq.question}
                </span>
                <span className="text-base font-semibold leading-snug text-[#1a1a19]">
                  {faq.headline}
                </span>
                {faq.profiles && faq.profiles.length < PROFILES.length && (
                  <span className="text-xs text-[#898781]">
                    {faq.profiles.join(" · ")}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      <p className="pt-2 text-xs text-[#898781]">
        Reference answers — fill in your own figures before relying on these on a
        live call.
      </p>
    </div>
  );
}
