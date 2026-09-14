"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { MAX_SNIPPET_CHARS, MAX_SNIPPET_TITLE_CHARS, type Snippet, type SnippetChannel } from "@/lib/messaging/snippets";

/** Saved replies (0150): list, add, edit, delete. */
export function SnippetsPanel({ initial, emailEnabled }: { initial: Snippet[]; emailEnabled: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState<Snippet | "new" | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [channel, setChannel] = useState<SnippetChannel>("any");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function open(s: Snippet | "new") {
    setEditing(s);
    setError(null);
    if (s === "new") {
      setTitle("");
      setBody("");
      setChannel("any");
    } else {
      setTitle(s.title);
      setBody(s.body_template);
      setChannel(s.channel);
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    const isNew = editing === "new";
    const res = await fetch(isNew ? "/api/customer/messaging/snippets" : `/api/customer/messaging/snippets/${(editing as Snippet).id}`, {
      method: isNew ? "POST" : "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, body, channel }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(data.error ?? "Could not save.");
      return;
    }
    setEditing(null);
    router.refresh();
  }

  async function remove(s: Snippet) {
    if (!window.confirm(`Delete “${s.title}”?`)) return;
    const res = await fetch(`/api/customer/messaging/snippets/${s.id}`, { method: "DELETE" });
    if (res.ok) router.refresh();
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Snippets</h2>
          <p className="text-sm text-ink-2">
            Saved replies you can drop into a message. Links are refused — use {"{{booking_link}}"} for the one
            link you keep in Settings.
          </p>
        </div>
        <Button onClick={() => open("new")} className="bg-brand hover:bg-brand-dark">
          New snippet
        </Button>
      </div>

      {editing && (
        <div className="rounded-xl border border-line bg-white p-5">
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={MAX_SNIPPET_TITLE_CHARS}
              placeholder="Title"
              className="h-10 rounded-lg border border-control px-3 text-sm outline-none focus:border-brand"
            />
            <select
              value={channel}
              onChange={(e) => setChannel(e.target.value as SnippetChannel)}
              className="h-10 rounded-lg border border-control px-3 text-sm"
              aria-label="Channel"
            >
              <option value="any">Any channel</option>
              <option value="whatsapp">WhatsApp</option>
              {emailEnabled && <option value="email">Email</option>}
            </select>
          </div>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={MAX_SNIPPET_CHARS}
            rows={5}
            placeholder="Hi {{first_name}}, …"
            className="mt-3 w-full rounded-lg border border-control px-3 py-2 text-sm outline-none focus:border-brand"
          />
          <div className="mt-1 text-right text-xs text-ink-2">
            {body.length} / {MAX_SNIPPET_CHARS}
          </div>
          {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
          <div className="mt-3 flex gap-2">
            <Button onClick={() => void save()} disabled={busy || !title.trim() || !body.trim()} className="bg-brand hover:bg-brand-dark">
              {busy ? "Saving…" : "Save"}
            </Button>
            <Button variant="outline" onClick={() => setEditing(null)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {initial.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[#cfd6cf] bg-white px-6 py-14 text-center">
          <p className="font-display text-[22px] font-semibold">No snippets yet</p>
          <p className="mx-auto mt-1.5 max-w-sm text-ink-2">
            Save the replies you type most, then drop them into a message from the composer.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-rail rounded-xl border border-line bg-white">
          {initial.map((s) => (
            <li key={s.id} className="flex items-start gap-3 px-5 py-3.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{s.title}</span>
                  <span className="rounded-full bg-page px-2 py-px text-[11px] font-semibold text-ink-3">
                    {s.channel === "any" ? "Any" : s.channel === "whatsapp" ? "WhatsApp" : "Email"}
                  </span>
                </div>
                <p className="mt-0.5 whitespace-pre-line text-sm text-ink-2">{s.body_template}</p>
              </div>
              <div className="flex flex-shrink-0 gap-1">
                <Button size="sm" variant="ghost" onClick={() => open(s)}>
                  Edit
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void remove(s)}>
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
