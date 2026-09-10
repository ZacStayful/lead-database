"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";

const RATINGS = [1, 2, 3, 4, 5];

const QUESTIONS = [
  {
    key: "overall_rating" as const,
    label: "Overall, how were this month's leads?",
    low: "Poor",
    high: "Excellent",
  },
  {
    key: "contactability_rating" as const,
    label: "Could you actually reach them?",
    low: "Rarely",
    high: "Nearly always",
  },
  {
    key: "fit_rating" as const,
    label: "Were they the kind of property you want?",
    low: "Wrong fit",
    high: "Right fit",
  },
];

type Answers = {
  overall_rating: number | null;
  contactability_rating: number | null;
  fit_rating: number | null;
};

/**
 * Cycle-end lead quality survey.
 *
 * Shown once per billing cycle, when the cycle's leads have been delivered.
 * Nothing here affects billing or credits — it exists purely to tell us which
 * sources and areas are producing leads that go nowhere, which is the only way
 * the underlying quality problem actually gets fixed.
 */
export function CycleQualitySurvey({ leadsInCycle }: { leadsInCycle: number }) {
  const router = useRouter();
  const [answers, setAnswers] = useState<Answers>({
    overall_rating: null,
    contactability_rating: null,
    fit_rating: null,
  });
  const [improve, setImprove] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    if (answers.overall_rating === null || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/customer/quality-survey", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...answers, what_would_improve: improve.trim() }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setError(data?.error ?? "Something went wrong. Please try again.");
        setSubmitting(false);
        return;
      }
      setDone(true);
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm font-medium">Thanks — that is genuinely useful.</p>
          <p className="mt-1 text-sm text-muted-foreground">
            We read every one of these and it feeds straight into where we go
            looking for the next batch.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="space-y-5 pt-6">
        <div>
          <h2 className="text-base font-semibold">
            How were your {leadsInCycle} lead{leadsInCycle === 1 ? "" : "s"} this
            month?
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Four questions, about two minutes. This does not affect your billing
            — it tells us where to find better leads for you next month.
          </p>
        </div>

        {QUESTIONS.map((q) => (
          <div key={q.key} className="space-y-2">
            <p className="text-sm font-medium">{q.label}</p>
            <div className="flex items-center gap-2">
              <span className="w-20 text-xs text-muted-foreground">{q.low}</span>
              <div className="flex gap-1.5">
                {RATINGS.map((value) => {
                  const selected = answers[q.key] === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      disabled={submitting}
                      aria-pressed={selected}
                      aria-label={`${q.label} — ${value} out of 5`}
                      onClick={() =>
                        setAnswers((prev) => ({ ...prev, [q.key]: value }))
                      }
                      className={
                        "h-9 w-9 rounded-lg border text-sm font-medium transition-colors disabled:opacity-60 " +
                        (selected
                          ? "border-[#3B6D11] bg-[#3B6D11] text-white"
                          : "border-black/10 text-[#52514e] hover:bg-gray-50")
                      }
                    >
                      {value}
                    </button>
                  );
                })}
              </div>
              <span className="w-24 text-xs text-muted-foreground">{q.high}</span>
            </div>
          </div>
        ))}

        <label className="block space-y-2">
          <span className="text-sm font-medium">
            What would make these leads better?
          </span>
          <textarea
            value={improve}
            onChange={(e) => setImprove(e.target.value)}
            disabled={submitting}
            rows={3}
            placeholder="Areas, property types, how quickly they reach you — anything."
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm outline-none focus:border-[#3B6D11] disabled:opacity-60"
          />
        </label>

        {error && (
          <p className="text-sm text-red-600" role="alert">
            {error}
          </p>
        )}

        <button
          type="button"
          onClick={() => handleSubmit()}
          disabled={answers.overall_rating === null || submitting}
          className="rounded-lg bg-[#3B6D11] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#2d5409] disabled:opacity-60"
        >
          {submitting ? "Sending…" : "Send feedback"}
        </button>
      </CardContent>
    </Card>
  );
}
