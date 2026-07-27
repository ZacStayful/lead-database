"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * The goal input and its "Edit goal" toggle.
 *
 * Split out of the page because the page is a server component: every figure
 * on it (won count, leads received, months remaining) is recomputed server-side
 * from the database, so after a successful save this calls router.refresh()
 * rather than adjusting numbers locally. The goal is live, not a snapshot taken
 * when it was set — an edit reshapes the whole page on the next render.
 */
export function GoalForm({ initialGoal }: { initialGoal: number | null }) {
  const router = useRouter();
  // With no goal set there is nothing to toggle open — the input IS the page.
  const [editing, setEditing] = useState(initialGoal === null);
  const [value, setValue] = useState(
    initialGoal === null ? "" : String(initialGoal)
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(goal: number | null) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/customer/goal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error ?? "Something went wrong. Please try again.");
        return;
      }
      setValue(goal === null ? "" : String(goal));
      setEditing(goal === null);
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
      setError("Enter a whole number of 1 or more.");
      return;
    }
    void save(parsed);
  }

  if (!editing) {
    return (
      <div className="rounded-xl border border-black/10 bg-white p-6">
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="rounded-lg border border-black/10 px-6 py-3 text-sm font-medium text-[#52514e] transition-colors hover:bg-gray-50"
        >
          Edit goal
        </button>
      </div>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      className="rounded-xl border border-black/10 bg-white p-6"
    >
      <label
        htmlFor="management-goal"
        className="block text-sm font-medium text-foreground"
      >
        How many new managed clients do you want from this marketplace?
      </label>
      <p className="mt-2 text-sm text-muted-foreground">
        Under the qualification model&apos;s long-run average, roughly 1 in 20
        leads converts to a signed management client.
      </p>

      <input
        id="management-goal"
        name="goal"
        type="number"
        min={1}
        step={1}
        inputMode="numeric"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        disabled={saving}
        className="mt-4 w-full max-w-[10rem] rounded-lg border border-black/10 px-4 py-3 text-sm disabled:opacity-60"
      />

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="submit"
          disabled={saving}
          className="rounded-lg bg-[#3B6D11] px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-[#2d5409] disabled:opacity-60"
        >
          {saving ? "Saving" : "Save"}
        </button>

        {initialGoal !== null && (
          <>
            <button
              type="button"
              onClick={() => {
                setValue(String(initialGoal));
                setError(null);
                setEditing(false);
              }}
              disabled={saving}
              className="rounded-lg border border-black/10 px-6 py-3 text-sm font-medium text-[#52514e] transition-colors hover:bg-gray-50 disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void save(null)}
              disabled={saving}
              className="rounded-lg px-6 py-3 text-sm font-medium text-[#898781] transition-colors hover:bg-gray-50 disabled:opacity-60"
            >
              Clear goal
            </button>
          </>
        )}
      </div>
    </form>
  );
}
