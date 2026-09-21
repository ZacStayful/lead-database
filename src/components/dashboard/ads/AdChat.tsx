"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AD_COPY, AD_STARTER_PROMPT } from "@/lib/ads/copy";
import { META_TRUNCATION_MARKS } from "@/lib/ads/metaFields";
import type { AdCopy } from "@/lib/ads/metaFields";

/**
 * The chat (§65): a prompt already in the box, then the questions it produced,
 * then the ad.
 *
 * ⚠️ IMPORTS `copy.ts` AND `metaFields.ts`, NEVER `templates.ts`'s server
 * siblings. Both are import-free for exactly this — the split `deadLeadCopy.ts`
 * makes from `deadLeadPolicy.ts` (§51.6).
 *
 * ⚠️ AND IT HANDLES `read_only_view`. §62's middleware answers 403 with that
 * code to every write while an admin is viewing a customer; without this every
 * button looks live and fails with what reads like a product error.
 */

export type ChatQuestion = {
  id: string;
  question: string;
  options: string[];
  allowOther: boolean;
  slot: string;
  depth: number;
  answer?: string;
};

export type ChatTemplate = { id: string; name: string; audience: string };

export type AdChatProps = {
  draftId: string | null;
  initialPrompt?: string;
  templateId: string | null;
  templateReason: string | null;
  questions: ChatQuestion[];
  questionsVersion: number;
  status: string;
  copy: AdCopy | null;
  fixed: { headline: string; sub: string } | null;
  canSimplify: boolean;
  templates: ChatTemplate[];
  readOnly: boolean;
};

async function post(url: string, body?: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, json };
}

/** One place to turn a refusal into a sentence, so no branch invents its own. */
function messageFor(json: Record<string, unknown>, status: number): string {
  if (json.code === "read_only_view") return AD_COPY.gate.readOnly;
  if (typeof json.error === "string" && json.error) return json.error;
  return status === 429 ? AD_COPY.errors.budget : AD_COPY.errors.generic;
}

export function AdChat(props: AdChatProps) {
  const router = useRouter();
  const [prompt, setPrompt] = useState(props.initialPrompt ?? AD_STARTER_PROMPT);
  const [questions, setQuestions] = useState(props.questions);
  const [version, setVersion] = useState(props.questionsVersion);
  const [answers, setAnswers] = useState<Record<string, string>>(() =>
    Object.fromEntries(props.questions.filter((q) => q.answer).map((q) => [q.id, q.answer!]))
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSwitch, setShowSwitch] = useState(false);

  const template = props.templates.find((t) => t.id === props.templateId) ?? null;
  const answered = questions.filter((q) => (answers[q.id] ?? "").trim()).length;
  const complete = questions.length > 0 && answered === questions.length;

  async function start() {
    setBusy("start");
    setError(null);
    const { ok, status, json } = await post("/api/customer/ads", { prompt });
    setBusy(null);
    if (!ok) return setError(messageFor(json, status));
    router.push(`/dashboard/ads/${json.id as string}`);
    router.refresh();
  }

  async function simplify(id: string) {
    if (!props.draftId) return;
    setBusy(id);
    setError(null);
    const { ok, status, json } = await post(
      `/api/customer/ads/${props.draftId}/simplify`,
      { question_id: id }
    );
    setBusy(null);
    if (!ok) return setError(messageFor(json, status));
    const next = json.question as ChatQuestion;
    setQuestions((qs) => qs.map((q) => (q.id === id ? { ...next, answer: q.answer } : q)));
    if (typeof json.questions_version === "number") setVersion(json.questions_version);
    // ⚠️ The answer is NOT cleared. §50's route preserves it server-side and
    // only the browser threw it away — a customer who answered, then asked for
    // the question again more simply, has not withdrawn their answer.
  }

  async function switchTemplate(id: string) {
    if (!props.draftId) return;
    setBusy("switch");
    setError(null);
    const { ok, status, json } = await post(
      `/api/customer/ads/${props.draftId}/template`,
      { template_id: id }
    );
    setBusy(null);
    setShowSwitch(false);
    if (!ok) return setError(messageFor(json, status));
    setQuestions(json.questions as ChatQuestion[]);
    setVersion(json.questions_version as number);
    // ⚠️ A different angle asks different questions, so answers filed against
    // the old ones are answers to questions that no longer exist.
    setAnswers({});
    router.refresh();
  }

  async function send() {
    if (!props.draftId) return;
    setBusy("send");
    setError(null);
    const { ok, status, json } = await post(`/api/customer/ads/${props.draftId}/answers`, {
      answers: questions.map((q) => ({ id: q.id, answer: answers[q.id] ?? "" })),
    });
    setBusy(null);
    if (!ok) return setError(messageFor(json, status));
    router.refresh();
  }

  // ------------------------------------------------------------------
  // Nothing started yet: the pre-written prompt, and one button.
  // ------------------------------------------------------------------
  if (!props.draftId) {
    return (
      <div className="space-y-3">
        {props.readOnly ? <ReadOnly /> : null}
        <label className="block text-sm font-medium text-[#1a1a19]" htmlFor="ad-prompt">
          What do you want the ad to do?
        </label>
        <textarea
          id="ad-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          className="w-full rounded-xl border border-[#e4e6e0] bg-white p-3 text-sm text-[#1a1a19]"
        />
        <button
          type="button"
          onClick={start}
          disabled={props.readOnly || busy !== null || !prompt.trim()}
          className="rounded-lg bg-[#1a1a19] px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy === "start" ? AD_COPY.chat.thinking : "Send"}
        </button>
        {error ? <Problem>{error}</Problem> : null}
      </div>
    );
  }

  // ------------------------------------------------------------------
  // Written: show it.
  // ------------------------------------------------------------------
  if (props.status === "ready" && props.copy) {
    return <AdResult draftId={props.draftId} copy={props.copy} readOnly={props.readOnly} />;
  }

  // ------------------------------------------------------------------
  // Collecting: the angle, then the questions.
  // ------------------------------------------------------------------
  return (
    <div className="space-y-4">
      {props.readOnly ? <ReadOnly /> : null}

      {template ? (
        <div className="rounded-xl border border-[#e4e6e0] bg-white p-4">
          <p className="text-sm text-[#1a1a19]">
            {AD_COPY.chat.pickedPrefix} <strong>{template.name}</strong>.
            {props.templateReason ? ` ${props.templateReason}` : ""}
          </p>
          {props.fixed?.headline ? (
            <p className="mt-2 text-xs text-[#6b706a]">
              The image will say: “{props.fixed.headline.replace(/\*/g, "")}”
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => setShowSwitch((v) => !v)}
            disabled={props.readOnly}
            className="mt-3 text-xs font-medium text-[#1a1a19] underline disabled:opacity-40"
          >
            {AD_COPY.chat.switchCta}
          </button>
          {showSwitch ? (
            <div className="mt-3 space-y-2 rounded-lg border border-[#f0d9b8] bg-[#fdf8ef] p-3">
              {/* ⚠️ Said BEFORE the tap, not after. */}
              <p className="text-xs text-[#7a5312]">{AD_COPY.chat.switchWarning}</p>
              {props.templates
                .filter((t) => t.id !== props.templateId)
                .map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => switchTemplate(t.id)}
                    disabled={busy !== null}
                    className="block w-full rounded-lg border border-[#e4e6e0] bg-white px-3 py-2 text-left text-xs text-[#1a1a19] disabled:opacity-40"
                  >
                    <strong>{t.name}</strong>
                    <span className="block text-[#6b706a]">{t.audience}</span>
                  </button>
                ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <p className="text-sm text-[#55564f]">{AD_COPY.chat.questionsIntro}</p>

      {questions.map((q) => (
        <div key={`${q.id}:${version}`} className="rounded-xl border border-[#e4e6e0] bg-white p-4">
          <p className="text-sm font-medium text-[#1a1a19]">{q.question}</p>
          {q.options.length ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {q.options.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => setAnswers((a) => ({ ...a, [q.id]: opt }))}
                  disabled={props.readOnly}
                  className={`rounded-full border px-3 py-1 text-xs disabled:opacity-40 ${
                    answers[q.id] === opt
                      ? "border-[#1a1a19] bg-[#1a1a19] text-white"
                      : "border-[#e4e6e0] bg-white text-[#1a1a19]"
                  }`}
                >
                  {opt}
                </button>
              ))}
            </div>
          ) : null}
          {q.allowOther || !q.options.length ? (
            <input
              type="text"
              value={answers[q.id] ?? ""}
              onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
              disabled={props.readOnly}
              placeholder="Or type it"
              className="mt-2 w-full rounded-lg border border-[#e4e6e0] px-3 py-2 text-sm"
            />
          ) : null}
          {/* ⚠️ NO SKIP CONTROL, which is fair only because the ladder ends in
              a plain text box anybody can answer. */}
          {props.canSimplify && !props.readOnly ? (
            <button
              type="button"
              onClick={() => simplify(q.id)}
              disabled={busy !== null}
              className="mt-2 text-xs text-[#6b706a] underline disabled:opacity-40"
            >
              {busy === q.id ? AD_COPY.chat.simplifying : AD_COPY.chat.simplify}
            </button>
          ) : null}
        </div>
      ))}

      {!complete && questions.length ? (
        <p className="text-xs text-[#6b706a]">
          {AD_COPY.chat.incomplete(answered, questions.length)}
        </p>
      ) : null}

      <button
        type="button"
        onClick={send}
        disabled={props.readOnly || !complete || busy !== null}
        className="rounded-lg bg-[#1a1a19] px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
      >
        {busy === "send" ? AD_COPY.chat.sending : AD_COPY.chat.send}
      </button>
      {error ? <Problem>{error}</Problem> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

function ReadOnly() {
  return (
    <p className="rounded-lg border border-[#f0d9b8] bg-[#fdf8ef] px-3 py-2 text-xs text-[#7a5312]">
      {AD_COPY.gate.readOnly}
    </p>
  );
}

function Problem({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-[#a8620f]">{children}</p>;
}

/**
 * The finished ad.
 *
 * ⚠️ THE TRUNCATION MARKS ARE DRAWN, NEVER ENFORCED. 125/40/30 are where
 * Facebook shortens the rendered ad with a "See more"; the API accepts far
 * longer, and rejecting on them would fail nearly every generation.
 */
function AdResult({
  draftId,
  copy,
  readOnly,
}: {
  draftId: string;
  copy: AdCopy;
  readOnly: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);

  async function run(action: "regenerate" | "render") {
    setBusy(action);
    setError(null);
    const { ok, status, json } = await post(`/api/customer/ads/${draftId}/${action}`);
    setBusy(null);
    if (!ok) return setError(messageFor(json, status));
    router.refresh();
  }

  async function remove() {
    setBusy("delete");
    const res = await fetch(`/api/customer/ads/${draftId}`, { method: "DELETE" });
    setBusy(null);
    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return setError(messageFor(json, res.status));
    }
    router.push("/dashboard/ads");
    router.refresh();
  }

  return (
    <div className="space-y-4">
      {readOnly ? <ReadOnly /> : null}

      <div className="rounded-xl border border-[#e4e6e0] bg-white p-4">
        <h2 className="text-sm font-semibold text-[#1a1a19]">{AD_COPY.result.copyHeading}</h2>
        <Field label="Primary text" value={copy.message} mark={META_TRUNCATION_MARKS.message} />
        <Field label="Headline" value={copy.headline} mark={META_TRUNCATION_MARKS.headline} />
        <Field label="Description" value={copy.description} mark={META_TRUNCATION_MARKS.description} />
        <dl className="mt-3 text-xs text-[#6b706a]">
          <dt className="inline font-medium">Button: </dt>
          <dd className="inline">{copy.call_to_action_type.replace(/_/g, " ").toLowerCase()}</dd>
          <br />
          <dt className="inline font-medium">Sends them to: </dt>
          <dd className="inline break-all">{copy.link_url}</dd>
        </dl>
        <p className="mt-3 text-xs text-[#6b706a]">{AD_COPY.result.truncationNote}</p>
      </div>

      {/* ⚠️ SAID PLAINLY, AND IT CARRIES NO META SEMANTICS. Meta's
          self_ai_disclosure declares AI-generated MEDIA; ours is a card we
          drew, and only the words are model-written. */}
      <p className="rounded-lg border border-[#e4e6e0] bg-[#f7f8f5] px-3 py-2 text-xs text-[#55564f]">
        {AD_COPY.result.aiNotice}
      </p>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => run("render")}
          disabled={readOnly || busy !== null}
          className="rounded-lg bg-[#1a1a19] px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy === "render" ? "Drawing…" : AD_COPY.result.creativeHeading}
        </button>
        <button
          type="button"
          onClick={() => run("regenerate")}
          disabled={readOnly || busy !== null}
          className="rounded-lg border border-[#e4e6e0] px-4 py-2 text-sm text-[#1a1a19] disabled:opacity-40"
        >
          {busy === "regenerate" ? "Rewriting…" : AD_COPY.result.regenerate}
        </button>
        {armed ? (
          <button
            type="button"
            onClick={remove}
            disabled={readOnly || busy !== null}
            className="rounded-lg border border-[#c9776a] px-4 py-2 text-sm text-[#a8442f] disabled:opacity-40"
          >
            Yes, delete it
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setArmed(true)}
            disabled={readOnly || busy !== null}
            className="rounded-lg border border-[#e4e6e0] px-4 py-2 text-sm text-[#6b706a] disabled:opacity-40"
          >
            {AD_COPY.result.deleteCta}
          </button>
        )}
      </div>
      {error ? <Problem>{error}</Problem> : null}
      <p className="text-xs text-[#6b706a]">
        <Link href="/dashboard/ads" className="underline">
          All your ads
        </Link>
      </p>
    </div>
  );
}

function Field({ label, value, mark }: { label: string; value: string; mark: number }) {
  const clipped = value.length > mark;
  return (
    <div className="mt-3">
      <p className="text-xs font-medium uppercase tracking-wide text-[#8a8b84]">{label}</p>
      <p className="mt-1 whitespace-pre-wrap text-sm text-[#1a1a19]">
        {clipped ? (
          <>
            {value.slice(0, mark)}
            <span className="text-[#a8620f]">│</span>
            {value.slice(mark)}
          </>
        ) : (
          value
        )}
      </p>
    </div>
  );
}
