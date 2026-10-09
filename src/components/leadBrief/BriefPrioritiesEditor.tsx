"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { offeredLevels, type StoredPriority } from "@/lib/leadBrief/editBrief";
import { EDIT_COPY, PRIORITY_LABELS, levelLabel } from "@/lib/leadBrief/editCopy";
import type { BriefPlan, TravelLimit } from "@/lib/leadBrief/plans";
import type { EssentialKey, PriorityKey } from "@/lib/leadBrief/types";

/**
 * The priorities half of the "Your brief" editor (Lead Brief Phase 5). The
 * ranking and the levels of NON-ESSENTIAL priorities; a change applies to the
 * next leads (a new active version, same area).
 *
 * An essential's level is the customer's Q3 answer, which shapes the service
 * area, so it is shown here and changed only under "Your area" (decided 9 Oct).
 *
 * Only the levels the customer actually changed are sent, so an engine-set
 * level is never pinned by accident (`buildEditedPriorities` judges it again).
 * Every word is in editCopy.ts.
 */
export interface BriefPrioritiesEditorProps {
  activeId: string;
  priorities: StoredPriority[];
  essentials: EssentialKey[];
  plan: BriefPlan;
  travel: TravelLimit;
  readOnly: boolean;
}

export function BriefPrioritiesEditor(props: BriefPrioritiesEditorProps) {
  const router = useRouter();
  const initialRanking = useMemo(() => props.priorities.map((p) => p.key), [props.priorities]);
  const [ranking, setRanking] = useState<PriorityKey[]>(initialRanking);
  const [levels, setLevels] = useState<Partial<Record<PriorityKey, number>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const byKey = new Map(props.priorities.map((p) => [p.key, p]));
  const isEssential = (k: PriorityKey) => (props.essentials as string[]).includes(k);
  const changed =
    ranking.some((k, i) => k !== initialRanking[i]) || Object.keys(levels).length > 0;

  function move(index: number, by: -1 | 1) {
    const to = index + by;
    if (to < 0 || to >= ranking.length) return;
    const next = [...ranking];
    [next[index], next[to]] = [next[to], next[index]];
    setRanking(next);
    setSaved(false);
  }

  function setLevel(key: PriorityKey, value: number) {
    const stored = byKey.get(key)?.threshold ?? null;
    const next = { ...levels };
    if (value === stored) delete next[key];
    else next[key] = value;
    setLevels(next);
    setSaved(false);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/customer/lead-brief/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "priorities", expectedActiveId: props.activeId, ranking, levels }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setSaved(true);
        setLevels({});
        router.refresh();
        return;
      }
      if (res.status === 409) setError(EDIT_COPY.errors.conflict);
      else if (data.code === "nothing_changed") setError(EDIT_COPY.errors.nothingChanged);
      else if (data.code === "level_invalid" || data.code === "level_essential") setError(EDIT_COPY.errors.level);
      else setError(EDIT_COPY.errors.failed);
    } catch {
      setError(EDIT_COPY.errors.failed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-ink">{EDIT_COPY.priorities.title}</h2>
          <p className="text-sm text-ink-2">{EDIT_COPY.priorities.intro}</p>
        </div>

        <ol className="space-y-2">
          {ranking.map((key, i) => {
            const stored = byKey.get(key);
            const current = levels[key] ?? stored?.threshold ?? null;
            const essential = isEssential(key);
            return (
              <li
                key={key}
                className="flex flex-wrap items-center gap-3 rounded-md border border-line px-3 py-2 text-sm"
              >
                <span className="w-5 text-ink-2">{i + 1}</span>
                <span className="min-w-[8rem] font-medium text-ink">{PRIORITY_LABELS[key]}</span>
                <span className="flex-1">
                  {essential ? (
                    <span className="text-ink-2">
                      {current !== null ? `${levelLabel(key, current)} · ` : ""}
                      {EDIT_COPY.priorities.essentialNote}
                    </span>
                  ) : (
                    <select
                      aria-label={`${PRIORITY_LABELS[key]}: ${EDIT_COPY.priorities.levelLabel}`}
                      className="h-9 w-full max-w-xs rounded-md border border-input bg-background px-2 text-sm"
                      value={current === null ? "" : String(current)}
                      disabled={props.readOnly || busy}
                      onChange={(e) => {
                        if (e.target.value !== "") setLevel(key, Number(e.target.value));
                      }}
                    >
                      {current === null && (
                        <option value="" disabled>
                          {EDIT_COPY.priorities.notSet}
                        </option>
                      )}
                      {offeredLevels(key, {
                        plan: props.plan,
                        travel: props.travel,
                        current: stored?.threshold ?? null,
                      }).map((v) => (
                        <option key={v} value={v}>
                          {levelLabel(key, v)}
                        </option>
                      ))}
                    </select>
                  )}
                </span>
                <span className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`${PRIORITY_LABELS[key]}: ${EDIT_COPY.priorities.up}`}
                    disabled={props.readOnly || busy || i === 0}
                    onClick={() => move(i, -1)}
                  >
                    <ArrowUp className="h-4 w-4" aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`${PRIORITY_LABELS[key]}: ${EDIT_COPY.priorities.down}`}
                    disabled={props.readOnly || busy || i === ranking.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    <ArrowDown className="h-4 w-4" aria-hidden />
                  </Button>
                </span>
              </li>
            );
          })}
        </ol>

        {error && <p className="text-sm text-alert">{error}</p>}
        {saved && !error && (
          <p className="rounded-md bg-brand-light p-3 text-sm text-brand-dark">{EDIT_COPY.priorities.saved}</p>
        )}
        {!props.readOnly && (
          <Button onClick={() => void save()} disabled={busy || !changed}>
            {busy ? EDIT_COPY.priorities.saving : EDIT_COPY.priorities.save}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
