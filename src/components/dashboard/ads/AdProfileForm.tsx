"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AD_COPY } from "@/lib/ads/copy";

/**
 * The business details every advert is built from (§65).
 *
 * ⚠️ EVERY FIELD IS AN OVERRIDE, AND THE FORM HAS TO SAY SO. A blank box in a
 * form full of blank boxes is invisible, so each one is placeheld with what the
 * account already has — the arrangement §41.6 uses for the referral details,
 * and for the same reason: nothing here is ever written back onto an account
 * column, so leaving a box empty is a choice rather than a gap.
 */

export type AdProfileService = {
  templateId: string;
  slot: string;
  options: Array<{ key: string; label: string }>;
};

export type AdProfileFormProps = {
  profile: Record<string, unknown>;
  inherited: Record<string, string | null>;
  services: AdProfileService[];
  citySuggestions: string[];
  /**
   * ⚠️ SENTENCES, NEVER FLAG KEYS. `resolveSlots` has always produced
   * `fee_outside_usual_range` and the only reader was the model's prompt, so a
   * fee being dropped off every ad was explained to Claude and to nobody else.
   * The route words them (`warningSentences`) so this file needs no copy.
   */
  warnings: string[];
  readOnly: boolean;
};

export function AdProfileForm(props: AdProfileFormProps) {
  const router = useRouter();
  const [form, setForm] = useState<Record<string, unknown>>({ ...props.profile });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * ⚠️ WHAT WE COULD NOT STORE, AND WHAT WE STORED BUT QUESTION. Saving used to
   * say only "Saved." — so a fee of 45%, or a link we could not read, was
   * dropped in silence and the operator found out when an ad refused to
   * generate. Seeded from the server render and replaced by each save.
   */
  const [said, setSaid] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>(props.warnings);

  const set = (key: string, value: unknown) => setForm((f) => ({ ...f, [key]: value }));
  const str = (key: string) => (form[key] == null ? "" : String(form[key]));

  function toggle(slot: string, key: string) {
    const current = Array.isArray(form[slot]) ? (form[slot] as string[]) : [];
    set(slot, current.includes(key) ? current.filter((k) => k !== key) : [...current, key]);
  }

  async function save() {
    setBusy(true);
    setError(null);
    setNote(null);
    setSaid([]);
    const res = await fetch("/api/customer/ads/profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    setBusy(false);
    const strings = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    setSaid(strings(json.said));
    setWarnings(strings(json.warnings));
    if (!res.ok) {
      setError(
        json.code === "read_only_view"
          ? AD_COPY.gate.readOnly
          : typeof json.error === "string"
            ? json.error
            : AD_COPY.errors.generic
      );
      return;
    }
    setNote("Saved.");
    router.refresh();
  }

  return (
    <div className="space-y-4">
      {props.readOnly ? (
        <p className="rounded-lg border border-[#f0d9b8] bg-[#fdf8ef] px-3 py-2 text-xs text-[#7a5312]">
          {AD_COPY.gate.readOnly}
        </p>
      ) : null}

      {said.length || warnings.length ? (
        <ul className="space-y-1 rounded-lg border border-[#f0d9b8] bg-[#fdf8ef] px-3 py-2 text-xs text-[#7a5312]">
          {[...said, ...warnings].map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}

      <Card title="Who the advert is from">
        <Text
          label="Trading name"
          value={str("company_name")}
          placeholder={props.inherited.company_name ?? "Your business name"}
          onChange={(v) => set("company_name", v)}
          disabled={props.readOnly}
          hint="Leave it blank to use the name on your account."
        />
        <Text
          label="Where the button sends them"
          value={str("landing_url")}
          placeholder={props.inherited.landing_url ?? "https://…"}
          onChange={(v) => set("landing_url", v)}
          disabled={props.readOnly}
          hint="Must be https. Leave it blank to use your booking link."
        />
        <Text
          label="Town or city to name"
          value={str("city")}
          placeholder={props.citySuggestions[0] ?? "Leave blank to run it without one"}
          onChange={(v) => set("city", v)}
          disabled={props.readOnly}
          hint={
            props.citySuggestions.length
              ? `From your lead areas: ${props.citySuggestions.join(", ")}.`
              : "An advert may only name a place you actually want work in."
          }
        />
      </Card>

      <Card title="Your fee">
        {/* ⚠️ Off unless they say otherwise. An unset fee_public reads as false
            everywhere, so the fee stays off the advert. */}
        <label className="flex items-center gap-2 text-sm text-[#1a1a19]">
          <input
            type="checkbox"
            checked={form.fee_public === true}
            onChange={(e) => set("fee_public", e.target.checked)}
            disabled={props.readOnly}
          />
          Put my fee on the advert
        </label>
        {form.fee_public === true ? (
          <>
            <Text
              label="Fee, as a percentage"
              value={str("fee_pct")}
              placeholder={props.inherited.fee_pct ?? "15"}
              onChange={(v) => set("fee_pct", v)}
              disabled={props.readOnly}
            />
            <Choice
              label="Taken on"
              value={str("fee_basis")}
              options={[
                ["gross", "Of gross"],
                ["net", "Of net"],
              ]}
              onChange={(v) => set("fee_basis", v)}
              disabled={props.readOnly}
            />
            {/* ⚠️ A bare "15%" is a different price either way, and the landlord
                reading the advert cannot tell which. */}
            <Choice
              label="VAT"
              value={str("fee_vat")}
              options={[
                ["exclusive", "Plus VAT"],
                ["inclusive", "Including VAT"],
                ["not_stated", "Rather not say"],
              ]}
              onChange={(v) => set("fee_vat", v)}
              disabled={props.readOnly}
            />
          </>
        ) : null}
      </Card>

      {props.services.map((s) => (
        <Card key={s.slot} title={s.slot === "handled" ? "What you handle" : "What is included"}>
          {/* ⚠️ Only what they tick may appear on the advert. */}
          <p className="text-xs text-[#6b706a]">
            Only what you tick can appear in the advert or on the image.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {s.options.map((o) => {
              const on = Array.isArray(form[s.slot]) && (form[s.slot] as string[]).includes(o.key);
              return (
                <button
                  key={o.key}
                  type="button"
                  onClick={() => toggle(s.slot, o.key)}
                  disabled={props.readOnly}
                  className={`rounded-full border px-3 py-1 text-xs disabled:opacity-40 ${
                    on
                      ? "border-[#1a1a19] bg-[#1a1a19] text-white"
                      : "border-[#e4e6e0] bg-white text-[#1a1a19]"
                  }`}
                >
                  {o.label}
                </button>
              );
            })}
          </div>
        </Card>
      ))}

      <Card title="Your numbers">
        <Text label="Years trading" value={str("years_trading")} onChange={(v) => set("years_trading", v)} disabled={props.readOnly} />
        <Text label="Properties managed" value={str("properties_managed")} onChange={(v) => set("properties_managed", v)} disabled={props.readOnly} />
        <Text label="Google review score" value={str("review_score")} onChange={(v) => set("review_score", v)} disabled={props.readOnly} />
        <Text
          label="Out of how many reviews"
          value={str("review_count")}
          onChange={(v) => set("review_count", v)}
          disabled={props.readOnly}
          hint="A score never goes on an advert without its count."
        />
        {/*
          ⚠️ THE ATTESTATION, AND IT IS SETTABLE NOWHERE ELSE. The advertising
          code wants documentary evidence held BEFORE anything is published, so
          this is a deliberate tick by somebody attesting to it — which is why
          a chat answer can never set it.
        */}
        <label className="mt-3 flex items-start gap-2 text-xs text-[#55564f]">
          <input
            type="checkbox"
            checked={Boolean(form.stats_confirmed_at)}
            onChange={(e) => set("stats_confirmed_at", e.target.checked)}
            disabled={props.readOnly}
          />
          <span>
            These figures are current, and I could show where they come from if I were
            asked.
          </span>
        </label>
      </Card>

      <Card title="A review you want quoted">
        <Text
          label="The review, in their words"
          value={str("review_quote")}
          onChange={(v) => set("review_quote", v)}
          disabled={props.readOnly}
        />
        <Text
          label="Where it is from"
          value={str("review_quote_source")}
          placeholder="Google, March 2026"
          onChange={(v) => set("review_quote_source", v)}
          disabled={props.readOnly}
        />
        {/* ⚠️ Without this tick the quote angle is dropped from the prompt
            entirely, and the validator rejects any quoted span. */}
        <label className="mt-3 flex items-start gap-2 text-xs text-[#55564f]">
          <input
            type="checkbox"
            checked={form.review_quote_confirmed === true}
            onChange={(e) => set("review_quote_confirmed", e.target.checked)}
            disabled={props.readOnly}
          />
          <span>This is a real review somebody actually left, word for word.</span>
        </label>
      </Card>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={props.readOnly || busy}
          className="rounded-lg bg-[#1a1a19] px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        {note ? <span className="text-xs text-[#4a7a52]">{note}</span> : null}
        {error ? <span className="text-xs text-[#a8620f]">{error}</span> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-[#e4e6e0] bg-white p-4">
      <h2 className="text-sm font-semibold text-[#1a1a19]">{title}</h2>
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

function Text({
  label,
  value,
  placeholder,
  hint,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  placeholder?: string;
  hint?: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-[#55564f]">{label}</span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="mt-1 w-full rounded-lg border border-[#e4e6e0] px-3 py-2 text-sm disabled:bg-[#f7f8f5]"
      />
      {hint ? <span className="mt-1 block text-xs text-[#8a8b84]">{hint}</span> : null}
    </label>
  );
}

function Choice({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  return (
    <div>
      <span className="text-xs font-medium text-[#55564f]">{label}</span>
      <div className="mt-1 flex flex-wrap gap-2">
        {options.map(([key, text]) => (
          <button
            key={key}
            type="button"
            onClick={() => onChange(key)}
            disabled={disabled}
            className={`rounded-full border px-3 py-1 text-xs disabled:opacity-40 ${
              value === key
                ? "border-[#1a1a19] bg-[#1a1a19] text-white"
                : "border-[#e4e6e0] bg-white text-[#1a1a19]"
            }`}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}
