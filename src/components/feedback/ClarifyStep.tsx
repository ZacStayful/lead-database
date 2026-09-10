"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * The questions, between typing and sending (§50).
 *
 * ⚠️ THERE IS NO SKIP CONTROL, AND THAT IS THE DESIGN. The answers are the
 * whole reason the generated brief is worth anything, and a skipped question
 * puts a hole in it in exactly the place that mattered. Send stays disabled
 * until every question has an answer.
 *
 * ⚠️ WHICH IS ONLY FAIR BECAUSE "NOT SURE" LEADS SOMEWHERE. Under every
 * question sits one link that asks it again, more simply, and the ladder
 * terminates in a plain text box that anyone can answer — enforced server-side
 * in `normaliseSimplified`, not requested of the model. A customer can always
 * get to the end.
 *
 * ⚠️ CLOSING THE TAB HERE COSTS NOTHING. The ticket was written before this
 * component was ever rendered, so abandonment is a delayed email, not a lost
 * request. That is why there is no "are you sure you want to leave" prompt: it
 * would be a lie about the stakes.
 */

export type ClarifyQuestion = {
  id: string;
  question: string;
  options: string[];
  allowOther: boolean;
  depth: number;
};

const MAX_DEPTH = 2;

export function ClarifyStep({
  ticketId,
  reference,
  onDone,
}: {
  ticketId: string;
  reference: string | null;
  onDone: (reference: string | null) => void;
}) {
  const [questions, setQuestions] = useState<ClarifyQuestion[] | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [simplifying, setSimplifying] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch("/api/feedback/clarify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ticketId }),
        });
        const data = await res.json();
        if (!live) return;
        const list: ClarifyQuestion[] = Array.isArray(data.questions) ? data.questions : [];
        // No questions is a SUCCESS, not a failure — it is what every model
        // problem degrades to. Finish immediately rather than showing the
        // customer an empty step or an error they cannot act on.
        if (!list.length) {
          void send([]);
          return;
        }
        setQuestions(list);
      } catch {
        if (live) void send([]);
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticketId]);

  async function send(list: ClarifyQuestion[]) {
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/feedback/${ticketId}/answers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          answers: list.map((q) => ({ id: q.id, answer: answers[q.id] ?? "" })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not send");
      onDone(typeof data.reference === "string" ? data.reference : reference);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send");
      setSending(false);
    }
  }

  async function simplify(question: ClarifyQuestion) {
    setSimplifying(question.id);
    setError(null);
    try {
      const res = await fetch("/api/feedback/clarify/simplify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticketId, questionId: question.id }),
      });
      const data = await res.json();
      if (data?.question) {
        setQuestions((qs) =>
          (qs ?? []).map((q) => (q.id === question.id ? (data.question as ClarifyQuestion) : q))
        );
        // The question changed, so any answer to the old wording is stale.
        setAnswers((a) => {
          const next = { ...a };
          delete next[question.id];
          return next;
        });
      }
    } catch {
      // Deliberately silent. The server always returns something answerable, so
      // the only way here is a dropped connection — and an error message under
      // one question would read as though that question were broken.
    } finally {
      setSimplifying(null);
    }
  }

  if (!questions) {
    return (
      <div className="rounded-xl border-[0.5px] border-border bg-card p-6 text-center">
        <p className="text-sm font-medium">Just a couple of quick questions…</p>
        <p className="mt-1 text-sm text-muted-foreground">
          It takes about thirty seconds and means we can get straight to it.
        </p>
      </div>
    );
  }

  const answered = questions.filter((q) => (answers[q.id] ?? "").trim().length > 0).length;
  const complete = answered === questions.length;

  return (
    <div className="space-y-4 rounded-xl border-[0.5px] border-border bg-card p-6">
      <div>
        <h2 className="text-base font-semibold">A few quick questions</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Your answers go straight to whoever picks this up, so the more of this we get
          now, the less we have to come back to you about.
        </p>
      </div>

      {questions.map((q) => (
        <div key={q.id} className="space-y-2 border-t-[0.5px] border-border pt-4">
          <p className="text-sm font-medium">{q.question}</p>

          {q.options.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {q.options.map((option) => {
                const selected = answers[q.id] === option;
                return (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setAnswers((a) => ({ ...a, [q.id]: option }))}
                    className={
                      "rounded-lg border px-3 py-2 text-sm font-medium transition-colors " +
                      (selected
                        ? "border-brand bg-brand/5 text-brand ring-1 ring-brand"
                        : "border-border text-muted-foreground hover:bg-accent")
                    }
                  >
                    {option}
                  </button>
                );
              })}
            </div>
          )}

          {(q.allowOther || q.options.length === 0) && (
            <textarea
              rows={q.options.length ? 2 : 3}
              value={q.options.includes(answers[q.id] ?? "") ? "" : answers[q.id] ?? ""}
              onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
              placeholder={q.options.length ? "Or say it in your own words" : "In your own words"}
              className="w-full resize-y rounded-md border-[0.5px] border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          )}

          {/* Not a skip. It asks the question again, more simply. */}
          {q.depth < MAX_DEPTH && (
            <button
              type="button"
              onClick={() => void simplify(q)}
              disabled={simplifying === q.id}
              className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-60"
            >
              {simplifying === q.id ? "Rewording…" : "Not sure what this means?"}
            </button>
          )}
        </div>
      ))}

      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}

      <div className="border-t-[0.5px] border-border pt-4">
        <p className="mb-2 text-xs text-muted-foreground">
          {complete
            ? "That's everything — thank you."
            : `${answered} of ${questions.length} answered. If a question doesn't make sense, tap "Not sure what this means?" underneath it.`}
        </p>
        <Button
          type="button"
          className="w-full"
          disabled={!complete || sending}
          onClick={() => void send(questions)}
        >
          {sending ? "Sending…" : "Send it"}
        </Button>
      </div>
    </div>
  );
}
