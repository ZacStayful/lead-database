"use client";

/**
 * The reveal deck (§41). One piece of information, then one question; the
 * answer unlocks the next.
 *
 * ⚠️ EACH ANSWER POSTS AS IT IS GIVEN, not all at the end. A landlord who stops
 * after the first question has still told the operator how to reach them, and
 * `landlord_prefs_step` makes the drop-off measurable instead of guessed at.
 *
 * ⚠️ THE QUESTIONS RUN EVEN WITH NO CARDS. About a tenth of management leads
 * have no analysis and every GR lead has none, so a deck-driven flow would
 * silently stop asking exactly those landlords — and the answers are the half
 * the operators actually need.
 */
import { useState } from "react";
import type { DeckCard, DeckHeadline } from "@/lib/landlordDeck";
import {
  CONTACT_METHODS,
  CONTACT_METHOD_LABELS,
  CONTACT_TIMES,
  WANT_CHIPS,
  type ContactMethod,
} from "@/lib/landlordQuestions";

const CARD: React.CSSProperties = {
  background: "#fff",
  border: "0.5px solid #d9dbd8",
  borderRadius: 10,
  padding: 24,
  marginBottom: 16,
};

const CHIP = (on: boolean): React.CSSProperties => ({
  display: "inline-block",
  padding: "10px 16px",
  margin: "0 8px 8px 0",
  borderRadius: 100,
  border: `1px solid ${on ? "#5D8156" : "#d9dbd8"}`,
  background: on ? "#5D8156" : "#fff",
  color: on ? "#fff" : "#1a1a1a",
  fontSize: 14,
  cursor: "pointer",
});

function money(n: number): string {
  return `£${n.toLocaleString("en-GB")}`;
}

/** The seasonal SHAPE. Bars only — never pounds; see landlordDeck.ts rule 2/3. */
function Seasonality({ weights, months }: { weights: number[]; months: string[] }) {
  const max = Math.max(...weights, 1);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 90, marginTop: 14 }}>
      {weights.map((w, i) => (
        <div key={i} style={{ flex: 1, textAlign: "center" }}>
          <div
            title={months[i]}
            style={{
              height: Math.max(4, Math.round((w / max) * 70)),
              background: "#5D8156",
              opacity: 0.25 + 0.75 * (w / max),
              borderRadius: 3,
            }}
          />
          <div style={{ fontSize: 9, color: "#8a8f88", marginTop: 4 }}>
            {months[i].slice(0, 1)}
          </div>
        </div>
      ))}
    </div>
  );
}

function Card({ card }: { card: DeckCard }) {
  return (
    <div style={CARD}>
      <p style={{ margin: "0 0 6px", fontSize: 12, textTransform: "uppercase", letterSpacing: ".05em", color: "#8a8f88" }}>
        {card.title}
      </p>
      <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6 }}>{card.body}</p>
      {card.kind === "seasonality" && (
        <Seasonality weights={card.weights} months={card.months} />
      )}
    </div>
  );
}

type Step = { key: "method" | "time" | "wants" | "note"; prompt: string };

const STEPS: Step[] = [
  { key: "method", prompt: "How would you like them to get in touch?" },
  { key: "time", prompt: "When is the best time to reach you?" },
  { key: "wants", prompt: "What would you most like to know?" },
  { key: "note", prompt: "Anything they should know before they call?" },
];

export default function LandlordDeckFlow(props: {
  token: string;
  firstName: string | null;
  address: string | null;
  headline: DeckHeadline | null;
  cards: DeckCard[];
  alreadyAnswered: boolean;
}) {
  const { token, firstName, address, headline, cards } = props;

  const [step, setStep] = useState(0);
  const [method, setMethod] = useState<ContactMethod | null>(null);
  const [time, setTime] = useState<string | null>(null);
  const [wants, setWants] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [done, setDone] = useState(false);
  const [saving, setSaving] = useState(false);

  async function save(patch: Record<string, unknown>, nextStep: number) {
    setSaving(true);
    try {
      await fetch("/api/public/lead-preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, step: nextStep, ...patch }),
      });
    } catch {
      // Deliberately swallowed. A landlord doing us a favour must never be
      // shown a network error; the next answer re-posts anyway.
    }
    setSaving(false);
    if (nextStep >= STEPS.length) setDone(true);
    else setStep(nextStep);
  }

  if (done) {
    return (
      <div style={CARD}>
        <h1 style={{ margin: "0 0 8px", fontSize: 18 }}>Thank you.</h1>
        <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6 }}>
          We&apos;ve passed that on. They&apos;ll be in touch{" "}
          {time ? `${time.toLowerCase()}` : "shortly"}
          {method ? ` by ${CONTACT_METHOD_LABELS[method].toLowerCase()}` : ""}.
        </p>
      </div>
    );
  }

  const current = STEPS[step];
  // Cards attach to whichever steps this lead's report supports; the questions
  // run regardless.
  const cardForStep = cards[step] ?? null;

  return (
    <>
      {step === 0 && (
        <div style={CARD}>
          <h1 style={{ margin: "0 0 8px", fontSize: 20 }}>
            {firstName ? `Hi ${firstName},` : "Hello,"}
          </h1>
          {address && (
            <p style={{ margin: "0 0 10px", fontSize: 14, color: "#6b706a" }}>{address}</p>
          )}
          {headline ? (
            <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6 }}>
              Our analysis models your property at{" "}
              <strong>
                {money(headline.grossLow)}–{money(headline.grossHigh)}
              </strong>{" "}
              a year gross as a short let. It&apos;s an estimate, not a promise —
              here&apos;s where it comes from.
            </p>
          ) : (
            <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6 }}>
              A local operator is going to be in touch about your property. Three
              quick questions so they can reach you the way you prefer.
            </p>
          )}
        </div>
      )}

      {cardForStep && <Card card={cardForStep} />}

      <div style={CARD}>
        <p style={{ margin: "0 0 14px", fontSize: 16, fontWeight: 600 }}>{current.prompt}</p>

        {current.key === "method" && (
          <div>
            {CONTACT_METHODS.map((m) => (
              <button
                key={m}
                type="button"
                style={CHIP(method === m)}
                onClick={() => {
                  setMethod(m);
                  void save({ contact_method: m }, 1);
                }}
                disabled={saving}
              >
                {CONTACT_METHOD_LABELS[m]}
              </button>
            ))}
          </div>
        )}

        {current.key === "time" && (
          <div>
            {CONTACT_TIMES.map((t) => (
              <button
                key={t}
                type="button"
                style={CHIP(time === t)}
                onClick={() => {
                  setTime(t);
                  void save({ contact_time: t }, 2);
                }}
                disabled={saving}
              >
                {t}
              </button>
            ))}
          </div>
        )}

        {current.key === "wants" && (
          <div>
            {WANT_CHIPS.map((w) => {
              const on = wants.includes(w);
              return (
                <button
                  key={w}
                  type="button"
                  style={CHIP(on)}
                  onClick={() =>
                    setWants((prev) => (on ? prev.filter((x) => x !== w) : [...prev, w]))
                  }
                  disabled={saving}
                >
                  {w}
                </button>
              );
            })}
            <div style={{ marginTop: 12 }}>
              <button
                type="button"
                onClick={() => void save({ wants }, 3)}
                disabled={saving || wants.length === 0}
                style={{
                  padding: "12px 22px",
                  borderRadius: 6,
                  border: "none",
                  background: wants.length ? "#5D8156" : "#c9ccc7",
                  color: "#fff",
                  fontWeight: 600,
                  fontSize: 14,
                  cursor: wants.length ? "pointer" : "default",
                }}
              >
                Continue
              </button>
            </div>
          </div>
        )}

        {current.key === "note" && (
          <div>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={4}
              maxLength={1000}
              placeholder="Optional"
              style={{
                width: "100%",
                padding: 12,
                borderRadius: 6,
                border: "1px solid #d9dbd8",
                fontSize: 14,
                fontFamily: "inherit",
                boxSizing: "border-box",
              }}
            />
            <div style={{ marginTop: 12 }}>
              <button
                type="button"
                onClick={() => void save(note.trim() ? { note: note.trim() } : {}, 4)}
                disabled={saving}
                style={{
                  padding: "12px 22px",
                  borderRadius: 6,
                  border: "none",
                  background: "#5D8156",
                  color: "#fff",
                  fontWeight: 600,
                  fontSize: 14,
                  cursor: "pointer",
                }}
              >
                {note.trim() ? "Send" : "Skip"}
              </button>
            </div>
          </div>
        )}

        <p style={{ margin: "14px 0 0", fontSize: 12, color: "#8a8f88" }}>
          Question {step + 1} of {STEPS.length}
        </p>
      </div>
    </>
  );
}
