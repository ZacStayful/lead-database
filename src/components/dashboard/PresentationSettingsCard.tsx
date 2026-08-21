"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  DEFAULT_PRESENTATION_SETTINGS,
  type PresentationSettings,
} from "@/lib/presentationSettings";

/**
 * The operator's own half of the income presentation (§26).
 *
 * SET ONCE, USED ON EVERY LEAD. Before this, an operator retyped their fee,
 * contract terms and process into the presentation tool for every landlord they
 * spoke to — and the tool kept one copy for the whole browser, so opening a
 * second lead overwrote the first. Now the property's figures come from its
 * analysis and these come from here.
 *
 * The management fee is here and NOT taken from the report, which also states
 * one: that 15% is Stayful's, charged on gross, and an operator presenting it
 * would be quoting our price as theirs.
 *
 * Lists are edited as one line per item — plain textareas rather than a
 * repeater. These are five short lists changed rarely, and a row-by-row editor
 * with add and remove buttons would be more to build, more to get wrong, and
 * slower to actually use.
 */
export function PresentationSettingsCard({
  initial,
  configured,
}: {
  initial: PresentationSettings;
  configured: boolean;
}) {
  const [s, setS] = useState<PresentationSettings>(initial);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(configured);
  const [error, setError] = useState<string | null>(null);

  const lines = (list: string[]) => list.join("\n");
  const toList = (value: string) =>
    value.split("\n").map((l) => l.trim()).filter(Boolean);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/customer/settings/presentation", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: s }),
      });
      if (!res.ok) throw new Error((await res.json())?.error ?? "Could not save");
      const body = await res.json();
      setS(body.settings);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }

  const field =
    "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

  return (
    <Card id="presentation">
      <CardContent className="space-y-5 pt-6">
        <div>
          <h2 className="text-lg font-semibold">How your presentations read</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Your fee, terms and process. Every lead&rsquo;s income presentation
            is built from these plus that property&rsquo;s own analysis, so you
            only set them once.
          </p>
          {!saved && (
            <p className="mt-2 rounded-md bg-amber-50 p-2 text-sm text-amber-900">
              Not set up yet — presentations currently use generic wording.
            </p>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-sm font-medium">
              Your management fee (%)
            </span>
            <input
              type="number"
              className={field}
              value={s.fee.pct}
              onChange={(e) =>
                setS({ ...s, fee: { ...s.fee, pct: Number(e.target.value) } })
              }
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium">Charged on</span>
            <select
              className={field}
              value={s.fee.basis}
              onChange={(e) =>
                setS({
                  ...s,
                  fee: { ...s.fee, basis: e.target.value as "net" | "gross" },
                })
              }
            >
              <option value="net">Income after platform fees</option>
              <option value="gross">Gross income</option>
            </select>
          </label>
        </div>

        <Text
          label="How you describe the fee"
          value={s.fee.desc}
          onChange={(v) => setS({ ...s, fee: { ...s.fee, desc: v } })}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Text
            label="Cleaning"
            value={s.cleaning.mode}
            single
            onChange={(v) => setS({ ...s, cleaning: { ...s.cleaning, mode: v } })}
          />
          <Text
            label="Contract term"
            value={s.contract.term}
            single
            onChange={(v) => setS({ ...s, contract: { ...s.contract, term: v } })}
          />
          <Text
            label="Notice period"
            value={s.contract.notice}
            single
            onChange={(v) =>
              setS({ ...s, contract: { ...s.contract, notice: v } })
            }
          />
          <Text
            label="Exit terms"
            value={s.contract.exit}
            single
            onChange={(v) => setS({ ...s, contract: { ...s.contract, exit: v } })}
          />
        </div>

        <Text
          label="How you describe cleaning"
          value={s.cleaning.desc}
          onChange={(v) => setS({ ...s, cleaning: { ...s.cleaning, desc: v } })}
        />
        <Text
          label="Compliance"
          value={s.compliance}
          onChange={(v) => setS({ ...s, compliance: v })}
        />
        <Text
          label="Guest vetting"
          value={s.vetting}
          onChange={(v) => setS({ ...s, vetting: v })}
        />

        <Text
          label="What you manage (one per line)"
          value={lines(s.managed)}
          rows={6}
          onChange={(v) => setS({ ...s, managed: toList(v) })}
        />
        <Text
          label="The landlord's responsibilities (one per line)"
          value={lines(s.landlord)}
          rows={4}
          onChange={(v) => setS({ ...s, landlord: toList(v) })}
        />
        <Text
          label="Discovery questions (one per line)"
          value={lines(s.discovery.map((d) => d.q))}
          rows={6}
          onChange={(v) =>
            setS({ ...s, discovery: toList(v).map((q) => ({ q, done: false })) })
          }
        />
        <Text
          label="Next steps (one per line)"
          value={lines(s.nextSteps.map((n) => n.label))}
          rows={3}
          onChange={(v) =>
            setS({
              ...s,
              nextSteps: toList(v).map((label) => ({ label, done: false })),
            })
          }
        />
        <Text
          label="Onboarding steps (one per line, as 'Step — when')"
          value={lines(
            s.onboarding.map((o) => (o.when ? `${o.title} — ${o.when}` : o.title))
          )}
          rows={5}
          onChange={(v) =>
            setS({
              ...s,
              onboarding: toList(v).map((line) => {
                const [title, when] = line.split(/\s+—\s+/);
                return { title: title ?? line, when: when ?? "" };
              }),
            })
          }
        />

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex items-center gap-3">
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
          <button
            type="button"
            className="text-sm text-muted-foreground hover:underline"
            onClick={() => setS(DEFAULT_PRESENTATION_SETTINGS)}
          >
            Reset to Stayful&rsquo;s wording
          </button>
        </div>
      </CardContent>
    </Card>
  );
}

function Text({
  label,
  value,
  onChange,
  rows = 2,
  single = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  single?: boolean;
}) {
  const cls =
    "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">{label}</span>
      {single ? (
        <input
          className={cls}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <textarea
          className={cls}
          rows={rows}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </label>
  );
}
