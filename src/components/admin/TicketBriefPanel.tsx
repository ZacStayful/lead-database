"use client";

import { useState } from "react";

/**
 * The clarifying answers and the implementation prompt, on the ticket (§47).
 *
 * ⚠️ ADMIN ONLY. `clarifications`, `brief` and `generated_prompt` are columns on
 * `support_tickets`, which the customer also reads on /dashboard/support. §46.3
 * put notes in a separate TABLE precisely so a select("*") could not ship them;
 * these could not take that route, so the boundary is the fixed column list on
 * the customer page, pinned by `supportTicketBoundary.test.ts`. Nothing here is
 * ever rendered on a customer-facing screen.
 */

export type TicketClarification = {
  id: string;
  question: string;
  answer: string | null;
  depth: number;
};

export type TicketBrief = {
  title?: string;
  understanding?: string;
  could_not_determine?: string[];
  prior_art_kind?: string;
  prior_art_detail?: string;
};

export function TicketBriefPanel({
  aiStatus,
  clarifications,
  brief,
  generatedPrompt,
}: {
  aiStatus: string | null;
  clarifications: TicketClarification[] | null;
  brief: TicketBrief | null;
  generatedPrompt: string | null;
}) {
  const [copied, setCopied] = useState(false);

  // NULL is the pre-§47 shape and the signed-out shape: no questions were ever
  // offered. Rendering an empty panel on nine backfilled tickets and every
  // anonymous submission would be noise, so say nothing at all.
  if (!aiStatus) return null;

  async function copy() {
    if (!generatedPrompt) return;
    try {
      await navigator.clipboard.writeText(generatedPrompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // A clipboard permission failure is not worth an error state — the
      // textarea below is selectable and is the fallback.
    }
  }

  return (
    <div className="space-y-3 rounded-lg border-[0.5px] border-border bg-background p-3">
      {clarifications?.length ? (
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            What they said when asked
          </p>
          {clarifications.map((c) => (
            <div key={c.id} className="text-sm">
              <p className="font-medium">{c.question}</p>
              <p className="text-muted-foreground">{c.answer ?? "— not answered —"}</p>
              {/*
                Depth is a finding, not trivia: it means the customer could not
                follow the product's own wording here, and that is very often
                where the real problem is.
              */}
              {c.depth > 0 && (
                <p className="text-xs text-amber-700">
                  needed simplifying {c.depth}× — they did not follow the wording
                </p>
              )}
            </div>
          ))}
        </div>
      ) : null}

      {brief?.prior_art_kind && brief.prior_art_kind !== "none" && (
        <p className="rounded border-[0.5px] border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
          <strong>
            {brief.prior_art_kind === "shipped"
              ? "This already shipped."
              : brief.prior_art_kind === "duplicate"
                ? "Possible duplicate."
                : "Matches a deferred decision."}
          </strong>{" "}
          {brief.prior_art_detail}
        </p>
      )}

      {brief?.could_not_determine?.length ? (
        <div className="text-xs text-muted-foreground">
          <p className="font-semibold uppercase tracking-wide">Still unknown</p>
          <ul className="list-disc pl-4">
            {brief.could_not_determine.map((u) => (
              <li key={u}>{u}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {generatedPrompt ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Implementation prompt
            </p>
            <button
              type="button"
              onClick={() => void copy()}
              className="rounded-md border-[0.5px] border-border px-2 py-1 text-xs font-medium hover:bg-accent"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <textarea
            readOnly
            value={generatedPrompt}
            rows={12}
            className="w-full resize-y rounded-md border-[0.5px] border-input bg-muted/30 p-2 font-mono text-xs"
          />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          {aiStatus === "awaiting_answers"
            ? "Waiting on the customer's answers. If they never finish, the sweep emails it unclarified within a couple of hours."
            : aiStatus === "abandoned"
              ? "They did not finish the questions, so this arrived as they typed it."
              : aiStatus === "failed"
                ? "The brief could not be generated. The hourly sweep retries these, so it may fill in shortly."
                : "No questions were asked for this one."}
        </p>
      )}
    </div>
  );
}
