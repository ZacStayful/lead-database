"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Candidate = {
  id: string;
  lead_name: string | null;
  postcode: string | null;
  assignment_count: number;
  max_assignments: number;
  created_at: string;
};

/**
 * Swap one assigned lead for another.
 *
 * Three deliberate frictions, because this is destructive and irreversible:
 *
 *   1. The picker only lists leads the swap would actually accept, so a
 *      selection cannot fail on eligibility after the fact.
 *   2. The consequences are spelled out before the confirm, not after — the
 *      removed lead never goes back into circulation, and any notes or files
 *      the customer wrote on it are deleted with the assignment.
 *   3. Confirm is a separate press from choosing.
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
  const [search, setSearch] = useState("");
  const [chosen, setChosen] = useState<Candidate | null>(null);
  const [swapping, setSwapping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A won lead is a conversion record; the function refuses it and so does the
  // button, so the refusal is visible before it is pressed.
  const isWon = status === "won";

  async function load(term: string) {
    setLoading(true);
    setError(null);
    try {
      const url = new URL(
        `/api/admin/assignments/${assignmentId}/swap`,
        window.location.origin
      );
      if (term) url.searchParams.set("q", term);
      const res = await fetch(url.toString());
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? "Could not load leads.");
        return;
      }
      setCandidates((data.candidates ?? []) as Candidate[]);
    } catch {
      setError("Could not load leads.");
    } finally {
      setLoading(false);
    }
  }

  function start() {
    setOpen(true);
    setChosen(null);
    setError(null);
    void load("");
  }

  async function swap() {
    if (!chosen) return;
    setSwapping(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/assignments/${assignmentId}/swap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ new_lead_id: chosen.id }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? "Could not swap this lead.");
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
        replacement carries the same price.
      </p>

      <div className="flex gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void load(search);
            }
          }}
          placeholder="Search name or postcode"
          className="w-full rounded-md border-[0.5px] border-border bg-background px-3 py-1.5 text-sm"
        />
        <button
          type="button"
          onClick={() => void load(search)}
          disabled={loading}
          className="rounded-md border-[0.5px] border-border px-3 py-1.5 text-sm font-medium hover:bg-accent disabled:opacity-50"
        >
          {loading ? "…" : "Search"}
        </button>
      </div>

      <div className="max-h-56 space-y-1 overflow-y-auto">
        {candidates.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setChosen(c)}
            className={
              "block w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors " +
              (chosen?.id === c.id
                ? "bg-[#5D8156] text-white"
                : "hover:bg-accent")
            }
          >
            <span className="font-medium">{c.lead_name ?? "Unnamed lead"}</span>
            <span
              className={
                "ml-2 " +
                (chosen?.id === c.id ? "text-white/80" : "text-muted-foreground")
              }
            >
              {c.postcode ?? "no postcode"} · {c.assignment_count}/
              {c.max_assignments} assigned
            </span>
          </button>
        ))}
        {!loading && candidates.length === 0 && (
          <p className="px-2 py-1.5 text-sm text-muted-foreground">
            No eligible leads. A replacement must be the same product, have room
            left, and not already be with this customer.
          </p>
        )}
      </div>

      {error && <p className="text-sm text-red-700">{error}</p>}

      <button
        type="button"
        onClick={() => void swap()}
        disabled={!chosen || swapping}
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
