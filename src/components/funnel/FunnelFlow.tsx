"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { BriefPreviewView } from "@/components/leadBrief/BriefPreviewView";
import { WhereStep } from "@/components/leadBrief/steps/WhereStep";
import { TravelStep, type Travel } from "@/components/leadBrief/steps/TravelStep";
import { EssentialsStep } from "@/components/leadBrief/steps/EssentialsStep";
import { FunnelExits } from "@/components/funnel/FunnelExits";
import { HowLeadsWork } from "@/components/funnel/HowLeadsWork";
import { WhyItWorks } from "@/components/funnel/WhyItWorks";
import { ISSUE_QUESTION, issueMessage, type BriefIssueCode } from "@/lib/leadBrief/briefCopy";
import { FUNNEL_COPY, discountExpiry, planPriceLine } from "@/lib/funnel/copy";
import type { DemoEmbed } from "@/lib/funnel/demo";
import type { FunnelDraft, FunnelScreen } from "@/lib/funnel/answers";
import type { FunnelPreviewBody } from "@/lib/funnel/preview";

/**
 * The self-serve funnel (batch 02 Phase 3): three questions, the preview,
 * "Why it works" and the plan screen, on one page at /start/[token].
 *
 * All the deciding happens on the server. This collects answers, saves each
 * one as it is given (POST /api/funnel/[token]/answers) so the link resumes
 * where the visitor stopped, and renders what the preview route returns. The
 * preview route returns `funnelPreviewBody` and nothing else, so no volume or
 * count ever reaches this component (02 locked decision 7).
 *
 * Every word is in funnel/copy.ts or, for the questions and the preview the
 * Lead Brief already has, briefCopy.ts. Never "Step x of 6" (02 Phase 3).
 *
 * "Continue to payment" posts to the guarded checkout (02 Phase 4) and follows
 * the Stripe URL it returns. Every refusal is a sentence on this screen, with
 * the call booking beside it; none of them loses the visitor's answers.
 */

type Plan = 10 | 20;
type Issue = { code: string; value?: string; outcode?: string };
type Ended = null | "unavailable" | "expired";

export interface FunnelFlowProps {
  token: string;
  summaryPath: string | null;
  demo: DemoEmbed | null;
  initialScreen: FunnelScreen;
  draft: FunnelDraft;
  lockedPostcode: string | null;
  snapshot: FunnelPreviewBody | null;
  initialPlan: Plan | null;
  discount: { code: string; expiresAt: string } | null;
}

type Outcome = "ok" | "stop" | "failed";

export function FunnelFlow(props: FunnelFlowProps) {
  const { token, draft } = props;
  const [screen, setScreen] = useState<FunnelScreen>(props.initialScreen);
  const [locked, setLocked] = useState<string | null>(props.lockedPostcode);
  const [postcode, setPostcode] = useState(props.lockedPostcode ?? draft.basePostcode ?? "");
  const [areas, setAreas] = useState<string[]>(draft.priorityOutcodes ?? []);
  const [travel, setTravel] = useState<Travel | undefined>(draft.travelLimitMiles);
  const [beds, setBeds] = useState<number | null>(draft.minBedrooms ?? null);
  const [gross, setGross] = useState<number | null>(draft.minGross ?? null);

  const [body, setBody] = useState<FunnelPreviewBody | null>(props.snapshot);
  const [ticked, setTicked] = useState<string[]>(props.snapshot?.similarAreas ?? draft.similarAreas ?? []);
  const [plan, setPlan] = useState<Plan>(props.initialPlan ?? 10);

  const [issues, setIssues] = useState<Issue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "save" | "preview" | "pay">(null);
  const [ended, setEnded] = useState<Ended>(null);

  const base = `/api/funnel/${encodeURIComponent(token)}`;
  const extraAreas = () => areas.map((a) => a.trim()).flatMap((a) => (a ? [a] : []));

  /**
   * The answers a 409, 403 or 404 ends the journey for, wherever it comes
   * from. Returns true when the visitor has been moved on.
   */
  function handleTerminal(status: number, data: Record<string, unknown>): boolean {
    if (status === 409 && data.code === "already_set_up" && typeof data.loginUrl === "string") {
      window.location.assign(data.loginUrl);
      return true;
    }
    if (status === 409 && data.code === "postcode_locked") {
      const kept = typeof data.lockedPostcode === "string" ? data.lockedPostcode : locked;
      setLocked(kept);
      if (kept) setPostcode(kept);
      setError(FUNNEL_COPY.postcodeLocked);
      setScreen("q1");
      return true;
    }
    if (status === 403) {
      setEnded("unavailable");
      return true;
    }
    if (status === 404) {
      setEnded("expired");
      return true;
    }
    return false;
  }

  async function save(patch: Record<string, unknown>): Promise<Outcome> {
    setBusy("save");
    setError(null);
    try {
      const res = await fetch(`${base}/answers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (res.ok) return "ok";
      const data = await res.json().catch(() => ({}));
      if (handleTerminal(res.status, data)) return "stop";
      setError(FUNNEL_COPY.saveFailed);
      return "failed";
    } catch {
      setError(FUNNEL_COPY.saveFailed);
      return "failed";
    } finally {
      setBusy(null);
    }
  }

  /**
   * A save that did not land is not a reason to hold the visitor up: their
   * answers are still on the page and go with the preview request. Only a
   * journey-ending answer stops them.
   */
  async function saveThen(patch: Record<string, unknown>, next: () => void) {
    if ((await save(patch)) === "stop") return;
    next();
  }

  async function requestPreview(
    similarAreas?: string[],
    essentials?: { beds: number | null; gross: number | null }
  ) {
    setBusy("preview");
    setError(null);
    const answers = {
      basePostcode: locked ?? postcode,
      priorityOutcodes: extraAreas(),
      travelLimitMiles: travel === undefined ? undefined : travel,
      minBedrooms: essentials ? essentials.beds : beds,
      minGross: essentials ? essentials.gross : gross,
    };
    try {
      const res = await fetch(`${base}/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(similarAreas ? { ...answers, similarAreas } : answers),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(data.plans)) {
        setIssues([]);
        setBody(data as FunnelPreviewBody);
        setTicked(Array.isArray(data.similarAreas) ? data.similarAreas : []);
        setScreen("preview");
        return;
      }
      if (handleTerminal(res.status, data)) return;
      if (res.status === 400 && Array.isArray(data.issues)) {
        setIssues(data.issues);
        const q = ISSUE_QUESTION[data.issues[0]?.code as BriefIssueCode];
        if (q === 1) setScreen("q1");
        else if (q === 2) setScreen("q2");
        else if (q === 3) setScreen("q3");
        return;
      }
      setError(res.status === 429 ? FUNNEL_COPY.rateLimited : FUNNEL_COPY.previewUnavailable);
    } catch {
      setError(FUNNEL_COPY.previewUnavailable);
    } finally {
      setBusy(null);
    }
  }

  async function startPayment() {
    setBusy("pay");
    setError(null);
    try {
      const res = await fetch(`${base}/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && typeof data.url === "string") {
        window.location.assign(data.url);
        return;
      }
      if (handleTerminal(res.status, data)) return;
      if (data.code === "payment_not_open") setError(FUNNEL_COPY.paymentNotReady);
      else if (data.code === "preview_required") setError(FUNNEL_COPY.noPreviewYet);
      else setError(FUNNEL_COPY.paymentFailed);
    } catch {
      setError(FUNNEL_COPY.paymentFailed);
    } finally {
      setBusy(null);
    }
  }

  function choosePlan(p: Plan) {
    setPlan(p);
    void save({ plan: p });
  }

  const issuesFor = (q: 1 | 2 | 3 | "preview") =>
    issues.flatMap((i) => (ISSUE_QUESTION[i.code as BriefIssueCode] === q ? [issueMessage(i)] : []));
  const errorBlock = error ? <p className="text-sm text-alert">{error}</p> : null;
  const working = busy !== null;
  const shown = body?.plans.find((p) => p.plan === plan) ?? null;

  if (ended) {
    return (
      <Frame label={null} summaryPath={props.summaryPath}>
        <h1 className="text-lg font-semibold text-ink">{FUNNEL_COPY.unavailableTitle}</h1>
        <p className="text-sm text-ink-2">
          {ended === "expired" ? FUNNEL_COPY.linkExpired : FUNNEL_COPY.unavailableBody}
        </p>
      </Frame>
    );
  }

  if (screen === "q1" || screen === "q2" || screen === "q3") {
    const n = screen === "q1" ? 1 : screen === "q2" ? 2 : 3;
    return (
      <Frame label={FUNNEL_COPY.questionsLabel} progress={n} summaryPath={props.summaryPath}>
        {n === 1 && <p className="text-sm text-ink-2">{FUNNEL_COPY.intro}</p>}

        {n === 1 && (
          <div className="space-y-4">
            <WhereStep
              postcode={locked ?? postcode}
              onPostcode={setPostcode}
              areas={areas}
              onAreas={setAreas}
              issues={issuesFor(1)}
              idPrefix="funnel"
              postcodeLockedNote={locked ? FUNNEL_COPY.postcodeLocked : null}
            />
            {errorBlock}
            <div className="flex gap-2">
              <Button
                disabled={working || (locked ?? postcode).trim() === ""}
                onClick={() =>
                  void saveThen({ basePostcode: locked ?? postcode.trim(), priorityOutcodes: extraAreas() }, () =>
                    setScreen("q2")
                  )
                }
              >
                {FUNNEL_COPY.next}
              </Button>
            </div>
          </div>
        )}

        {n === 2 && (
          <div className="space-y-4">
            <TravelStep travel={travel} onTravel={setTravel} issues={issuesFor(2)} />
            {errorBlock}
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setScreen("q1")} disabled={working}>
                {FUNNEL_COPY.back}
              </Button>
              <Button
                disabled={working || travel === undefined}
                onClick={() => void saveThen({ travelLimitMiles: travel }, () => setScreen("q3"))}
              >
                {FUNNEL_COPY.next}
              </Button>
            </div>
          </div>
        )}

        {n === 3 && (
          <div className="space-y-4">
            <EssentialsStep
              beds={beds}
              onBeds={setBeds}
              gross={gross}
              onGross={setGross}
              issues={issuesFor(3)}
              idPrefix="funnel"
            />
            {errorBlock}
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="ghost" onClick={() => setScreen("q2")} disabled={working}>
                {FUNNEL_COPY.back}
              </Button>
              <Button
                variant="outline"
                disabled={working}
                onClick={() => {
                  setBeds(null);
                  setGross(null);
                  void saveThen({ minBedrooms: null, minGross: null, questionsDone: true }, () =>
                    void requestPreview(undefined, { beds: null, gross: null })
                  );
                }}
              >
                {FUNNEL_COPY.showEverything}
              </Button>
              <Button
                disabled={working}
                onClick={() =>
                  void saveThen({ minBedrooms: beds, minGross: gross, questionsDone: true }, () =>
                    void requestPreview()
                  )
                }
              >
                {FUNNEL_COPY.seePreview}
              </Button>
              {busy === "preview" && <span className="text-sm text-ink-2">{FUNNEL_COPY.working}</span>}
            </div>
          </div>
        )}
      </Frame>
    );
  }

  if (screen === "why") {
    return (
      <Frame label={FUNNEL_COPY.whyTitle} summaryPath={props.summaryPath}>
        <WhyItWorks demo={props.demo} />
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" onClick={() => setScreen("preview")}>
            {FUNNEL_COPY.back}
          </Button>
          <Button onClick={() => setScreen("plan")}>{FUNNEL_COPY.toPlan}</Button>
        </div>
      </Frame>
    );
  }

  if (screen === "plan") {
    const until = props.discount ? discountExpiry(props.discount.expiresAt) : null;
    return (
      <Frame label={FUNNEL_COPY.planTitle} summaryPath={props.summaryPath}>
        {!body ? (
          <p className="text-sm text-ink-2">{FUNNEL_COPY.noPreviewYet}</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {body.plans.map((p) => {
              const leads = p.plan as Plan;
              const chosen = leads === plan;
              return (
                <button
                  key={leads}
                  type="button"
                  onClick={() => choosePlan(leads)}
                  aria-pressed={chosen}
                  className={
                    chosen
                      ? "space-y-1 rounded-xl border-2 border-brand bg-brand-light p-4 text-left"
                      : "space-y-1 rounded-xl border border-black/10 bg-white p-4 text-left hover:border-brand"
                  }
                >
                  <span className="block font-semibold text-ink">{planPriceLine(leads)}</span>
                  <span className="block text-sm text-ink-2">
                    {FUNNEL_COPY.planRadius(p.serviceRadiusMiles, p.basePostcode)}
                  </span>
                  {chosen && <span className="block text-xs font-medium text-brand-dark">{FUNNEL_COPY.planChosen}</span>}
                </button>
              );
            })}
          </div>
        )}
        {props.discount && until && (
          <p className="rounded-md bg-brand-light p-3 text-sm text-brand-dark">
            {FUNNEL_COPY.discountLine(props.discount.code, until)}
          </p>
        )}
        {errorBlock}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" onClick={() => setScreen("why")} disabled={working}>
            {FUNNEL_COPY.back}
          </Button>
          <Button onClick={() => void startPayment()} disabled={working || !body}>
            {busy === "pay" ? FUNNEL_COPY.startingPayment : FUNNEL_COPY.continueToPayment}
          </Button>
        </div>
      </Frame>
    );
  }

  // The preview.
  return (
    <Frame label={FUNNEL_COPY.previewLabel} summaryPath={props.summaryPath}>
      {!shown || !body ? (
        <>
          <p className="text-sm text-ink-2">{FUNNEL_COPY.noPreviewYet}</p>
          <Button onClick={() => setScreen("q3")}>{FUNNEL_COPY.changeAnswers}</Button>
        </>
      ) : (
        <>
          <p className="text-sm text-ink-2">{FUNNEL_COPY.previewIntro}</p>
          <div className="space-y-1">
            <p className="text-xs text-ink-2">{FUNNEL_COPY.planToggleLabel}</p>
            <div className="grid grid-cols-2 gap-2">
              {body.plans.map((p) => (
                <button
                  key={p.plan}
                  type="button"
                  onClick={() => choosePlan(p.plan as Plan)}
                  aria-pressed={p.plan === plan}
                  className={
                    p.plan === plan
                      ? "rounded-md border border-brand bg-brand-light px-3 py-2 text-sm font-medium text-brand-dark"
                      : "rounded-md border border-line px-3 py-2 text-sm hover:border-brand"
                  }
                >
                  {FUNNEL_COPY.planOption(p.plan)}
                </button>
              ))}
            </div>
          </div>
          {issuesFor("preview").map((m) => (
            <p key={m} className="text-sm text-alert">
              {m}
            </p>
          ))}
          <BriefPreviewView
            preview={shown}
            ticked={ticked}
            minBedrooms={beds}
            minGross={gross}
            renewalIso={null}
            switched={false}
            switchOpen={false}
            busy={working}
            allowSwitch={false}
            anywayLine={FUNNEL_COPY.previewAnyway}
            onToggleArea={(area) =>
              void requestPreview(
                ticked.includes(area) ? ticked.flatMap((a) => (a === area ? [] : [a])) : [...ticked, area]
              )
            }
            onWiden={() => setScreen("q2")}
            onOpenSwitch={() => {}}
            onCancelSwitch={() => {}}
            onConfirmSwitch={() => {}}
          />
          <HowLeadsWork />
          {errorBlock}
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" onClick={() => setScreen("q1")} disabled={working}>
              {FUNNEL_COPY.changeAnswers}
            </Button>
            <Button onClick={() => setScreen("why")} disabled={working}>
              {FUNNEL_COPY.toWhy}
            </Button>
            {busy === "preview" && <span className="text-sm text-ink-2">{FUNNEL_COPY.working}</span>}
          </div>
        </>
      )}
    </Frame>
  );
}

/** The card every screen sits in, with its label and the two exits. */
function Frame({
  label,
  progress,
  summaryPath,
  children,
}: {
  label: string | null;
  progress?: 1 | 2 | 3;
  summaryPath: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-5 rounded-xl border border-black/10 bg-white p-5 sm:p-6">
      {label && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-medium text-ink-2">{label}</p>
          {progress && (
            <div className="flex gap-1" aria-hidden>
              {[1, 2, 3].map((i) => (
                <span key={i} className={i <= progress ? "h-1.5 w-6 rounded-full bg-brand" : "h-1.5 w-6 rounded-full bg-line"} />
              ))}
            </div>
          )}
        </div>
      )}
      {children}
      <FunnelExits summaryPath={summaryPath} />
    </div>
  );
}
