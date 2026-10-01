"use client";

/**
 * The monthly batch review (§73): one row per lead, one tap each.
 *
 * Everything this decides comes from src/lib/batchReview/answers.ts and
 * pipeline.ts, which are import-free precisely so this component can use them
 * and the suite can still test the rules (§21.8).
 *
 * ⚠️ NO SKIPPING (§50.2): Save stays disabled until every editable row is
 * answered, and the server refuses a partial submission regardless. A disabled
 * button is a courtesy, not a control.
 */
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  DEAD_REASONS,
  DEAD_REASON_LABELS,
  asksForReason,
  type AnswerOption,
  type BatchAnswer,
  type DeadReason,
} from "@/lib/batchReview/answers";
import { READ_ONLY_LABEL, type ReadOnlyReason } from "@/lib/batchReview/pipeline";

export interface FormItem {
  id: string;
  leadId: string | null;
  name: string;
  postcodeArea: string | null;
  bedrooms: string | null;
  assignedAt: string;
  readOnly: ReadOnlyReason | null;
  answer: BatchAnswer | null;
  deadReason: DeadReason | null;
  /** Set when this lead was sent to replace one the customer reported (§73.8). */
  replacementFor?: string | null;
}

const REPORTABLE: ReadonlySet<DeadReason> = new Set<DeadReason>(["with_other_company", "not_letting"]);

function received(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Europe/London" });
}

function bedsLabel(b: string | null): string | null {
  if (!b) return null;
  const n = Number(b);
  return Number.isFinite(n) ? `${n} bed` : b;
}

export function BatchReviewForm({
  items,
  options,
  submitUrl,
  leadHrefBase,
  initialRating,
  initialComment,
  submitted,
}: {
  items: FormItem[];
  options: AnswerOption[];
  submitUrl: string;
  /**
   * Prefix for a "report it" link to the lead page. A string rather than a
   * function, because this crosses from a server component into the client
   * and a function cannot be serialised there.
   */
  leadHrefBase: string;
  initialRating: number | null;
  initialComment: string | null;
  submitted: boolean;
}) {
  const router = useRouter();
  const [answers, setAnswers] = useState<Record<string, BatchAnswer | null>>(() =>
    Object.fromEntries(items.map((i) => [i.id, i.answer]))
  );
  const [reasons, setReasons] = useState<Record<string, DeadReason | null>>(() =>
    Object.fromEntries(items.map((i) => [i.id, i.deadReason]))
  );
  const [rating, setRating] = useState<number | null>(initialRating);
  const [comment, setComment] = useState(initialComment ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const editable = items.filter((i) => i.readOnly === null);
  const remaining = useMemo(
    () => editable.filter((i) => !answers[i.id]).length,
    [editable, answers]
  );

  async function submit() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch(submitUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          answers: editable.map((i) => ({
            item_id: i.id,
            answer: answers[i.id],
            dead_reason: asksForReason(answers[i.id]) ? reasons[i.id] ?? null : null,
          })),
          quality_rating: rating,
          comment,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "We could not save your answers just now.");
        return;
      }
      setSaved(true);
      router.refresh();
    } catch {
      setError("We could not reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <ul className="space-y-3">
        {items.map((item) => {
          const current = answers[item.id];
          const meta = [item.postcodeArea, bedsLabel(item.bedrooms), `received ${received(item.assignedAt)}`]
            .filter(Boolean)
            .join(" · ");
          return (
            <li key={item.id} className="rounded-lg border-[0.5px] border-border bg-background p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-medium">{item.name}</p>
                <p className="text-xs text-muted-foreground">{meta}</p>
              </div>
              {item.replacementFor && (
                <p className="mt-1 text-xs text-brand">Sent to replace {item.replacementFor}</p>
              )}
              {item.readOnly ? (
                <p className="mt-2 text-xs text-muted-foreground">{READ_ONLY_LABEL[item.readOnly]}</p>
              ) : (
                <>
                  <div className="mt-3 flex flex-wrap gap-2" role="radiogroup" aria-label={`Where ${item.name} got to`}>
                    {options.map((o) => (
                      <button
                        key={o.value}
                        type="button"
                        role="radio"
                        aria-checked={current === o.value}
                        onClick={() => setAnswers((prev) => ({ ...prev, [item.id]: o.value }))}
                        className={`rounded-full border-[0.5px] px-3 py-1 text-xs transition-colors ${
                          current === o.value
                            ? "border-brand bg-brand text-brand-foreground"
                            : "border-border hover:bg-muted"
                        }`}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                  {asksForReason(current) && (
                    <div className="mt-3">
                      <p className="text-xs text-muted-foreground">Why? (optional)</p>
                      <div className="mt-1 flex flex-wrap gap-2">
                        {DEAD_REASONS.map((r) => (
                          <button
                            key={r}
                            type="button"
                            onClick={() =>
                              setReasons((prev) => ({ ...prev, [item.id]: prev[item.id] === r ? null : r }))
                            }
                            className={`rounded-full border-[0.5px] px-3 py-1 text-xs ${
                              reasons[item.id] === r ? "border-foreground bg-muted font-medium" : "border-border"
                            }`}
                          >
                            {DEAD_REASON_LABELS[r]}
                          </button>
                        ))}
                      </div>
                      {item.leadId && reasons[item.id] && REPORTABLE.has(reasons[item.id]!) && (
                        <p className="mt-2 text-xs text-muted-foreground">
                          If the landlord had already gone before you reached them, you can report it{" "}
                          <a href={`${leadHrefBase}${item.leadId}`} className="underline">
                            from the lead
                          </a>
                          .
                        </p>
                      )}
                    </div>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ul>

      <div className="rounded-lg border-[0.5px] border-border bg-background p-4">
        <p className="text-sm font-medium">How good were this month&apos;s leads overall?</p>
        <div className="mt-2 flex gap-2" role="radiogroup" aria-label="Lead quality">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={rating === n}
              onClick={() => setRating(rating === n ? null : n)}
              className={`h-9 w-9 rounded-md border-[0.5px] text-sm ${
                rating === n ? "border-brand bg-brand text-brand-foreground" : "border-border hover:bg-muted"
              }`}
            >
              {n}
            </button>
          ))}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">1 is poor, 5 is excellent. Optional.</p>
        <label htmlFor="batch-comment" className="mt-4 block text-sm font-medium">
          Anything we could do better? (optional)
        </label>
        <textarea
          id="batch-comment"
          value={comment}
          maxLength={2000}
          onChange={(e) => setComment(e.target.value)}
          rows={3}
          className="mt-1 w-full rounded-md border-[0.5px] border-border bg-background p-2 text-sm"
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy || remaining > 0}
          onClick={submit}
          className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Saving…" : submitted ? "Save changes" : "Send my answers"}
        </button>
        {remaining > 0 && (
          <p className="text-xs text-muted-foreground">
            {remaining} lead{remaining === 1 ? "" : "s"} still to answer.
          </p>
        )}
        {saved && <p className="text-xs text-muted-foreground">Saved. Your pipeline has been updated.</p>}
        {error && <p className="text-xs text-red-700">{error}</p>}
      </div>
    </div>
  );
}
