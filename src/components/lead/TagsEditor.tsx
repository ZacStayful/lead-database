"use client";

import { useState } from "react";
import { Plus, X } from "lucide-react";

/** Tags on this operator's copy of the lead (0150). Pills, a dashed "+", Enter to add. */
export function TagsEditor({
  tags,
  onSave,
}: {
  tags: string[];
  onSave: (tags: string[]) => Promise<boolean>;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");

  async function add() {
    const t = draft.trim();
    setDraft("");
    setAdding(false);
    if (!t) return;
    await onSave([...tags, t]);
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {tags.map((t) => (
        <span key={t} className="inline-flex items-center gap-1 rounded-full bg-page px-2.5 py-[3px] text-xs font-semibold text-ink-3">
          {t}
          <button
            type="button"
            aria-label={`Remove tag ${t}`}
            onClick={() => void onSave(tags.filter((x) => x !== t))}
            className="rounded-full text-ink-2 hover:text-ink"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      {adding ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void add()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void add();
            } else if (e.key === "Escape") {
              setDraft("");
              setAdding(false);
            }
          }}
          maxLength={40}
          placeholder="Tag"
          className="h-6 w-28 rounded-full border border-control px-2 text-xs outline-none focus:border-brand"
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          aria-label="Add a tag"
          className="flex h-6 w-6 items-center justify-center rounded-full border border-dashed border-[#b9c2b9] text-ink-2 hover:text-ink"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
