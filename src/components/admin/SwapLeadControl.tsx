"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Candidate = {
  id: string;
  lead_name: string | null;
  postcode: string | null;
  bedrooms: string | null;
  assignment_count: number;
  max_assignments: number;
  created_at: string;
  matches_filter: boolean;
};

/** The customer's active filter for this product, or null if they have none. */
type FilterView = {
  label: string;
  status: string;
  summary: string;
  tooltip: string;
  liftDate: string | null;
};

/**
 * Swap one assigned lead for another.
 *
 * Four deliberate frictions, because this is destructive and irreversible:
 *
 *   1. The picker only lists leads the swap would actually accept, so a
 *      selection cannot fail on eligibility after the fact.
 *   2. Where the customer has a lead filter, the picker LEADS WITH the leads
 *      that match it and hides the rest behind a toggle, and placing one of
 *      the rest takes a second, named acknowledgement — a replacement reaches
 *      the customer as an ordinary new lead, email and text included, so an
 *      off-filter one is us sending exactly what they asked us not to.
 *
 *      Grouping alone was not enough. Off-filter leads outnumber matching ones
 *      heavily (11 against 80 for one live customer), so an <optgroup> label
 *      left eleven useful options buried under eighty and the picker read as
 *      broken. The one case that always reveals them is no matching stock at
 *      all, which is the case they were kept reachable for.
 *   3. The consequences are spelled out before the confirm, not after — the
 *      removed lead never goes back into circulation, and any notes or files
 *      the customer wrote on it are deleted with the assignment.
 *   4. Confirm is a separate press from choosing.
 */
export function SwapLeadControl({
  assignmentId,
  leadName,
  status,
}: {
  assignmentId: string;
  leadName: string | null;
  status: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [filter, setFilter] = useState<FilterView | null>(null);
  const [chosen, setChosen] = useState<Candidate | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [swapping, setSwapping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Off-filter leads are hidden until asked for. They outnumber the matching
  // ones badly — one live customer filtered to six areas has 11 matching
  // against 80 outside — and in a native <select> that is eleven useful
  // options buried under eighty, behind an <optgroup> label that scrolls past
  // unnoticed. Grouping them was not enough; the list has to lead with what
  // the customer actually asked for.
  const [showOutside, setShowOutside] = useState(false);
  const [query, setQuery] = useState("");

  // A won lead is a conversion record; the function refuses it and so does the
  // button, so the refusal is visible before it is pressed.
  const isWon = status === "won";

  const matching = candidates.filter((c) => c.matches_filter);
  const outside = candidates.filter((c) => !c.matches_filter);

  // Only meaningful when the customer actually has a filter. Without one every
  // candidate comes back matching, so this is false throughout and the whole
  // acknowledgement path stays out of the way.
  const needsAcknowledgement = Boolean(filter) && chosen != null && !chosen.matches_filter;

  // Revealed on request, and ALWAYS when nothing matches. A filtered customer
  // owed a replacement today may have no matching stock at all — that is the
  // case 0109 kept these leads reachable for — and an empty dropdown hiding its
  // own escape hatch behind a toggle would be worse than the noise it fixes.
  const outsideVisible = !filter || showOutside || matching.length === 0;

  // Debounced so a typed postcode is one request, not one per keystroke. Only
  // while the picker is open, and never on the first render — `start()` does
  // that fetch, and firing both would double every open.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      void load(query.trim());
    }, 300);
    return () => clearTimeout(t);
    // `load` is stable enough for this: it closes over assignmentId only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, open]);

  async function load(search = "") {
    setLoading(true);
    setError(null);
    try {
      // The route has always accepted ?q= and the SQL has always implemented
      // p_search, but nothing ever sent it — so the picker was a hard 50-row
      // cap with no way past it. Matching-first ordering means the matching
      // group survives that cap today, which is luck rather than design: a
      // customer with 60 matching leads would silently lose some.
      const url = search
        ? `/api/admin/assignments/${assignmentId}/swap?q=${encodeURIComponent(search)}`
        : `/api/admin/assignments/${assignmentId}/swap`;
      const res = await fetch(url);
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        // A 404 here almost always means this row is stale: the assignment was
        // swapped (or discarded) since the page rendered, so the id the button
        // carries no longer exists. "Assignment not found" is accurate and
        // useless; the actionable version names the cause and the remedy.
        setError(
          res.status === 404
            ? "This lead is no longer assigned to this customer — it has probably already been swapped. Refresh the page."
            : `Could not load leads (HTTP ${res.status}): ${
                data?.error ?? "no message from the server"
              }`
        );
        return;
      }
      setCandidates((data?.candidates ?? []) as Candidate[]);
      setFilter((data?.filter ?? null) as FilterView | null);
    } catch (err) {
      setError(
        `Could not reach the server: ${
          err instanceof Error ? err.message : "unknown error"
        }`
      );
    } finally {
      setLoading(false);
    }
  }

  function start() {
    setOpen(true);
    setChosen(null);
    setAcknowledged(false);
    setError(null);
    setShowOutside(false);
    setQuery("");
    void load();
  }

  /**
   * Hide the off-filter group again, and drop a selection made from it.
   *
   * Leaving `chosen` pointing at an option that is no longer rendered would
   * show a confirm button for a lead the admin can no longer see.
   */
  function hideOutside() {
    setShowOutside(false);
    if (chosen && !chosen.matches_filter) {
      setChosen(null);
      setAcknowledged(false);
    }
  }

  function choose(id: string) {
    setChosen(candidates.find((c) => c.id === id) ?? null);
    // Never carried from one lead to the next: the tick names a specific lead
    // and a specific filter it misses.
    setAcknowledged(false);
  }

  async function swap() {
    if (!chosen) return;
    if (needsAcknowledgement && !acknowledged) return;
    setSwapping(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/assignments/${assignmentId}/swap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          new_lead_id: chosen.id,
          // Only ever sent for a lead the admin has been shown is off-filter
          // and has ticked for. Anything else and the function refuses.
          allow_filter_mismatch: needsAcknowledgement && acknowledged,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(
          res.status === 404
            ? "This lead is no longer assigned to this customer — it has probably already been swapped. Refresh the page."
            : (data?.error ?? "Could not swap this lead.")
        );
        return;
      }
      // The swap succeeded either way; a failed send is worth saying out loud
      // rather than leaving the admin to assume the customer was told.
      if (data?.notified === false) {
        setError(
          "Swapped, but the customer could not be notified. Let them know by hand."
        );
        router.refresh();
        return;
      }

      setOpen(false);
      router.refresh();
    } catch {
      setError("Could not swap this lead.");
    } finally {
      setSwapping(false);
    }
  }

  if (isWon) {
    return (
      <span className="text-sm text-muted-foreground" title="A won lead cannot be swapped out">
        —
      </span>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={start}
        className="text-sm font-medium text-[#5D8156] hover:underline"
      >
        Swap
      </button>
    );
  }

  const optionLabel = (c: Candidate) =>
    [
      c.lead_name ?? "Unnamed lead",
      c.postcode ?? null,
      c.bedrooms ? `${c.bedrooms} bed` : null,
      `${c.assignment_count}/${c.max_assignments} assigned`,
    ]
      .filter(Boolean)
      .join(" · ");

  return (
    <div className="space-y-3 rounded-md border-[0.5px] border-border bg-muted/30 p-3 text-left">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">
          Replace {leadName ?? "this lead"}
        </p>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-sm text-muted-foreground hover:underline"
        >
          Cancel
        </button>
      </div>

      <p className="text-sm text-muted-foreground">
        {leadName ?? "This lead"} will be removed from this customer and taken
        out of circulation — it will not be offered to anyone else. Any notes or
        files they added to it are deleted with it. No credit is charged; the
        replacement carries the same price. The customer gets the usual new-lead
        email and text for the replacement.
      </p>

      {filter && (
        <p
          className="text-sm text-muted-foreground"
          title={filter.tooltip}
        >
          <span className="font-medium text-foreground">
            {filter.label} lead filter:
          </span>{" "}
          {filter.summary}
          {filter.status === "pending_lift" && (
            <>
              {" "}
              — a lift is scheduled
              {filter.liftDate ? ` for ${filter.liftDate}` : ""}, so it still
              applies today.
            </>
          )}
        </p>
      )}

      <div>
        <label htmlFor={`swap-search-${assignmentId}`} className="sr-only">
          Search leads by name or postcode
        </label>
        <input
          id={`swap-search-${assignmentId}`}
          type="text"
          value={query}
          disabled={swapping}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name or postcode…"
          className="mb-2 w-full rounded-md border-[0.5px] border-border bg-background px-3 py-2 text-sm disabled:opacity-60"
        />

        <label htmlFor={`swap-${assignmentId}`} className="sr-only">
          Replacement lead
        </label>
        <select
          id={`swap-${assignmentId}`}
          value={chosen?.id ?? ""}
          disabled={loading || swapping}
          onChange={(e) => choose(e.target.value)}
          className="w-full rounded-md border-[0.5px] border-border bg-background px-3 py-2 text-sm disabled:opacity-60"
        >
          <option value="">
            {loading
              ? "Loading leads…"
              : error
                ? "Could not load leads — see below"
                : candidates.length === 0
                  ? "No eligible leads"
                  : filter && !outsideVisible
                    ? `Choose a replacement (${matching.length} match their filter)`
                    : `Choose a replacement (${candidates.length} available)`}
          </option>

          {/* Grouped only when there is a filter to group against. An
              unfiltered customer gets the flat list they always had. */}
          {filter ? (
            <>
              {matching.length > 0 && (
                <optgroup label={`Matches their filter (${matching.length})`}>
                  {matching.map((c) => (
                    <option key={c.id} value={c.id}>
                      {optionLabel(c)}
                    </option>
                  ))}
                </optgroup>
              )}
              {outside.length > 0 && outsideVisible && (
                <optgroup label={`Outside their filter (${outside.length})`}>
                  {outside.map((c) => (
                    <option key={c.id} value={c.id}>
                      {optionLabel(c)}
                    </option>
                  ))}
                </optgroup>
              )}
            </>
          ) : (
            candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {optionLabel(c)}
              </option>
            ))
          )}
        </select>
        {/* The escape hatch. Deliberately a quiet text button rather than
            anything that reads as the primary action: placing an off-filter
            lead is the exception, and it still has to pass the tick below. */}
        {!loading && filter && outside.length > 0 && matching.length > 0 && (
          <button
            type="button"
            onClick={() => (showOutside ? hideOutside() : setShowOutside(true))}
            disabled={swapping}
            className="mt-1 text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-60"
          >
            {showOutside
              ? `Hide the ${outside.length} outside their filter`
              : `Show ${outside.length} lead${outside.length === 1 ? "" : "s"} outside their filter`}
          </button>
        )}

        {!loading && candidates.length === 0 && !error && (
          <p className="mt-1 text-sm text-muted-foreground">
            {query.trim()
              ? "No leads match that search. Clear it to see everything eligible."
              : "A replacement must be the same product, have room left, and not already be with this customer."}
          </p>
        )}
        {!loading && filter && matching.length === 0 && candidates.length > 0 && (
          <p className="mt-1 text-sm text-muted-foreground">
            Nothing in stock matches their filter right now. Anything you pick
            is a lead they asked not to receive.
          </p>
        )}
      </div>

      {needsAcknowledgement && filter && (
        <div className="space-y-2 rounded-md border-[0.5px] border-amber-300 bg-amber-50 p-3">
          <p className="text-sm text-amber-900">
            <span className="font-medium">
              {chosen?.lead_name ?? "This lead"} is outside their {filter.label}{" "}
              filter
            </span>{" "}
            ({filter.summary}). They chose that filter and their volume forecast
            and cost per lead were quoted on it. They will get the ordinary
            new-lead email and text for this one, with nothing to say it is not
            what they asked for.
          </p>
          <label className="flex items-start gap-2 text-sm text-amber-900">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="mt-0.5"
            />
            <span>Send it anyway — I have a reason and I will tell them.</span>
          </label>
        </div>
      )}

      {error && <p className="text-sm text-red-700">{error}</p>}

      <button
        type="button"
        onClick={() => void swap()}
        disabled={!chosen || swapping || (needsAcknowledgement && !acknowledged)}
        className="rounded-md bg-[#3B6D11] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#2d5409] disabled:opacity-50"
      >
        {swapping
          ? "Swapping"
          : chosen
            ? `Replace with ${chosen.lead_name ?? "this lead"}`
            : "Choose a replacement"}
      </button>
    </div>
  );
}
