"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  DEAD_LEAD_REASONS,
  DEAD_LEAD_REASON_LABELS,
  MIN_DETAIL_LENGTH,
  REASON_DETAIL_PROMPT,
  type DeadLeadReason,
} from "@/lib/quality/deadLeadCopy";
import {
  REPLACEMENT_EMPTY,
  REPLACEMENT_EXHAUSTED,
  remainingSentence,
  resetSentence,
  type ReplacementEntitlement,
} from "@/lib/quality/replacementEntitlement";
import type { LeadType } from "@/lib/types";

/**
 * The replacements shortlist: answer why the landlord was gone, then swap.
 *
 * ⚠️ IMPORTS deadLeadCopy.ts, NEVER deadLeadPolicy.ts. This is a client
 * component and the policy module reaches plans.ts through products.ts (§51.6).
 * The entitlement arrives already resolved from the server, which is also what
 * keeps claimBudget() the one definition of the arithmetic.
 */

export interface ReplacementItem {
  assignmentId: string;
  leadId: string;
  leadName: string;
  address: string | null;
  bedrooms: string | null;
  leadType: LeadType;
  grossAnnualIncome: number | null;
  ageDays: number;
  reasons: Record<string, { available: boolean; because: string | null }>;
}

interface Candidate {
  id: string;
  postcode_area: string | null;
  bedrooms: string | null;
  gross_annual_income: number | null;
  created_at: string;
  matches_filter: boolean;
}

function money(n: number | null): string | null {
  if (n == null || !Number.isFinite(n) || n <= 0) return null;
  return `£${Math.round(n).toLocaleString("en-GB")}/yr gross`;
}

function ageLabel(days: number): string {
  if (days <= 0) return "added today";
  if (days === 1) return "added yesterday";
  return `added ${days} days ago`;
}

/**
 * ⚠️ The gross line is OMITTED rather than blanked for guaranteed rent. Not one
 * guaranteed-rent lead in stock carries a figure — §25's analysis is
 * management-only by design — so a "£— gross" on every card would read as data
 * we had lost rather than a number that was never ours to show.
 */
function candidateLine(c: Candidate): string {
  const parts = [c.postcode_area ?? "Area unknown"];
  if (c.bedrooms) parts.push(`${c.bedrooms} bed`);
  const gross = money(c.gross_annual_income);
  if (gross) parts.push(gross);
  parts.push(ageLabel(Math.floor((Date.now() - new Date(c.created_at).getTime()) / 86_400_000)));
  return parts.join(" · ");
}

export function ReplacementList({
  items,
  entitlement,
}: {
  items: ReplacementItem[];
  entitlement: ReplacementEntitlement;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, string>>({});

  const exhausted = entitlement.remaining <= 0;
  const reset = resetSentence(entitlement);

  return (
    <div className="space-y-4">
      {/* ⚠️ The published count. §51.3's secrecy is deliberately reversed here
          and only here — the credit claim on the lead page still says nothing
          about it. */}
      <div className="rounded-xl border border-[#e4e6e0] bg-white p-4">
        <p className="text-sm font-medium text-[#1a1a19]">
          {remainingSentence(entitlement)}
        </p>
        {reset ? <p className="mt-1 text-xs text-[#6b706a]">{reset}</p> : null}
        {exhausted && items.length > 0 ? (
          <p className="mt-2 text-xs text-[#a8620f]">{REPLACEMENT_EXHAUSTED}</p>
        ) : null}
      </div>

      {items.length === 0 ? (
        <p className="rounded-xl border border-[#e4e6e0] bg-white p-6 text-sm text-[#55564f]">
          {REPLACEMENT_EMPTY}
        </p>
      ) : (
        items.map((item) => (
          <ReplacementRow
            key={item.assignmentId}
            item={item}
            exhausted={exhausted}
            open={openId === item.assignmentId}
            doneMessage={done[item.assignmentId] ?? null}
            onOpen={() =>
              setOpenId(openId === item.assignmentId ? null : item.assignmentId)
            }
            onDone={(msg) => {
              setDone((d) => ({ ...d, [item.assignmentId]: msg }));
              setOpenId(null);
            }}
          />
        ))
      )}
    </div>
  );
}

function ReplacementRow({
  item,
  exhausted,
  open,
  doneMessage,
  onOpen,
  onDone,
}: {
  item: ReplacementItem;
  exhausted: boolean;
  open: boolean;
  doneMessage: string | null;
  onOpen: () => void;
  onDone: (message: string) => void;
}) {
  const router = useRouter();
  const [reason, setReason] = useState<DeadLeadReason | "">("");
  const [detail, setDetail] = useState("");
  const [contactedOn, setContactedOn] = useState("");
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [chosen, setChosen] = useState<string>("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [showOutside, setShowOutside] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const answered =
    reason !== "" &&
    item.reasons[reason]?.available !== false &&
    detail.trim().length >= MIN_DETAIL_LENGTH &&
    contactedOn !== "";

  // Candidates are fetched only once the questions are answered — that is the
  // order the screen promises, and it keeps the unsold-stock readout behind an
  // actual intent to replace rather than a page load.
  useEffect(() => {
    if (!open || !answered || candidates !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/customer/replacements?assignment_id=${encodeURIComponent(item.assignmentId)}`
        );
        const payload = (await res.json()) as { candidates?: Candidate[] };
        if (!cancelled) setCandidates(payload.candidates ?? []);
      } catch {
        if (!cancelled) setCandidates([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, answered, candidates, item.assignmentId]);

  const matching = (candidates ?? []).filter((c) => c.matches_filter);
  const outside = (candidates ?? []).filter((c) => !c.matches_filter);
  // ⚠️ Auto-revealed when nothing matches. Three of the five filtered customers
  // on the book today have ZERO matching replacements in stock, so a collapsed
  // group would be an empty picker for exactly the operators who were most
  // careful about what they asked for (§34's argument, one level down).
  const outsideVisible = showOutside || matching.length === 0;
  const chosenCandidate = (candidates ?? []).find((c) => c.id === chosen) ?? null;
  const needsAcknowledgement =
    chosenCandidate != null && !chosenCandidate.matches_filter && outside.length > 0;

  const choose = useCallback((id: string) => {
    setChosen(id);
    // Resets on every change, so a tick can never carry over to a lead it was
    // not given for.
    setAcknowledged(false);
  }, []);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/customer/replacements/swap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assignment_id: item.assignmentId,
          new_lead_id: chosen,
          reason,
          detail: detail.trim(),
          contacted_on: contactedOn,
          allow_filter_mismatch: needsAcknowledgement && acknowledged,
        }),
      });
      const payload = (await res.json()) as { ok?: boolean; message?: string };
      if (!res.ok || !payload.ok) {
        setError(payload.message ?? "We could not do that. Please try again.");
        return;
      }
      onDone(payload.message ?? "Thanks — we have that.");
      router.refresh();
    } catch {
      setError("We could not do that. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (doneMessage) {
    return (
      <div className="rounded-xl border border-[#cfe0d3] bg-[#f4f8f2] p-4 text-sm text-[#245f3c]">
        <span className="font-medium">{item.leadName}</span> — {doneMessage}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-[#e4e6e0] bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-[#1a1a19]">{item.leadName}</p>
          <p className="text-xs text-[#6b706a]">
            {[item.address, item.bedrooms ? `${item.bedrooms} bed` : null,
              `received ${item.ageDays} day${item.ageDays === 1 ? "" : "s"} ago`]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <button
          type="button"
          onClick={onOpen}
          className="shrink-0 rounded-lg border border-[#d7dad2] px-3 py-1.5 text-xs font-medium text-[#1a1a19] hover:bg-[#f2f3ef]"
        >
          {open ? "Cancel" : "Replace this lead"}
        </button>
      </div>

      {open ? (
        <div className="mt-4 space-y-3 border-t border-[#eceee8] pt-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-[#52514e]">
              What did they say?
            </label>
            {/* Every reason is listed; the ones that cannot be used are disabled
                with their explanation, so the seven-day competitor rule is
                legible rather than a silently missing option (§52.4). */}
            <select
              value={reason}
              onChange={(e) => {
                setReason(e.target.value as DeadLeadReason);
                setCandidates(null);
                setChosen("");
              }}
              className="w-full rounded-lg border border-[#d7dad2] px-3 py-2 text-sm"
            >
              <option value="">Choose one…</option>
              {DEAD_LEAD_REASONS.map((r) => {
                const v = item.reasons[r];
                return (
                  <option key={r} value={r} disabled={v?.available === false}>
                    {DEAD_LEAD_REASON_LABELS[r]}
                    {v?.available === false && v.because ? ` — ${v.because}` : ""}
                  </option>
                );
              })}
            </select>
          </div>

          {reason ? (
            <>
              <div>
                <label className="mb-1 block text-xs font-medium text-[#52514e]">
                  {REASON_DETAIL_PROMPT[reason]}
                </label>
                <textarea
                  value={detail}
                  onChange={(e) => setDetail(e.target.value)}
                  rows={3}
                  className="w-full rounded-lg border border-[#d7dad2] px-3 py-2 text-sm"
                />
                <p className="mt-1 text-xs text-[#8a8b84]">
                  {detail.trim().length < MIN_DETAIL_LENGTH
                    ? `${MIN_DETAIL_LENGTH - detail.trim().length} more characters.`
                    : "Thanks — that is what lets us trace the lead back."}
                </p>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-[#52514e]">
                  When did you speak to them?
                </label>
                <input
                  type="date"
                  value={contactedOn}
                  onChange={(e) => setContactedOn(e.target.value)}
                  className="rounded-lg border border-[#d7dad2] px-3 py-2 text-sm"
                />
              </div>
            </>
          ) : null}

          {answered ? (
            <div className="rounded-lg border border-[#eceee8] bg-[#fafbf8] p-3">
              <p className="mb-2 text-xs font-medium text-[#52514e]">
                Pick what you would like instead
              </p>
              {candidates === null ? (
                <p className="text-xs text-[#8a8b84]">Loading…</p>
              ) : candidates.length === 0 ? (
                <p className="text-xs text-[#8a8b84]">
                  Nothing to swap in right now. Report it and we will look into it.
                </p>
              ) : (
                <select
                  value={chosen}
                  onChange={(e) => choose(e.target.value)}
                  className="w-full rounded-lg border border-[#d7dad2] px-3 py-2 text-sm"
                >
                  <option value="">Choose a replacement…</option>
                  {matching.length > 0 ? (
                    <optgroup label={`Matches what you asked for (${matching.length})`}>
                      {matching.map((c) => (
                        <option key={c.id} value={c.id}>{candidateLine(c)}</option>
                      ))}
                    </optgroup>
                  ) : null}
                  {outsideVisible && outside.length > 0 ? (
                    <optgroup label={`Outside your filter (${outside.length})`}>
                      {outside.map((c) => (
                        <option key={c.id} value={c.id}>{candidateLine(c)}</option>
                      ))}
                    </optgroup>
                  ) : null}
                </select>
              )}

              {!outsideVisible && outside.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setShowOutside(true)}
                  className="mt-2 text-xs text-[#6b706a] underline"
                >
                  Show {outside.length} outside your filter
                </button>
              ) : null}

              {needsAcknowledgement ? (
                <label className="mt-3 flex gap-2 rounded-lg border border-[#f0d9b8] bg-[#fdf8ef] p-3 text-xs text-[#7a5312]">
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    onChange={(e) => setAcknowledged(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span>
                    This one is outside the areas and sizes you asked for. Send it
                    anyway.
                  </span>
                </label>
              ) : null}
            </div>
          ) : null}

          {error ? <p className="text-xs text-[#b91c1c]">{error}</p> : null}

          <button
            type="button"
            disabled={
              busy ||
              exhausted ||
              !answered ||
              !chosen ||
              (needsAcknowledgement && !acknowledged)
            }
            onClick={submit}
            className="rounded-lg bg-[#2f7d4f] px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {busy ? "Swapping…" : "Swap this lead"}
          </button>
          {exhausted ? (
            <p className="text-xs text-[#8a8b84]">{REPLACEMENT_EXHAUSTED}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
