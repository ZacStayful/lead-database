"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { BriefPreviewView } from "@/components/leadBrief/BriefPreviewView";
import { WhereStep } from "@/components/leadBrief/steps/WhereStep";
import { TravelStep, type Travel } from "@/components/leadBrief/steps/TravelStep";
import { EssentialsStep } from "@/components/leadBrief/steps/EssentialsStep";
import {
  BRIEF_COPY,
  ISSUE_QUESTION,
  PREVIEW_COPY,
  SWITCH_COPY,
  issueMessage,
  radiusChangedLine,
  switchDone,
  type BriefIssueCode,
} from "@/lib/leadBrief/briefCopy";
import type { ClientBriefPreview } from "@/lib/leadBrief/preview";
import { radiusChangedSincePayment, type BriefConfirmationInitial } from "@/lib/funnel/confirmationRules";

/**
 * The Lead Brief questionnaire: three questions (A8), then the preview, then
 * confirm. All the deciding happens on the server; this only collects answers
 * and renders what comes back. Every word is in briefCopy.ts.
 *
 * "Switch to 10 leads a month" calls the existing §24 tier-change route
 * (approved 9 Oct): the plan changes at the next renewal, nothing is charged
 * or refunded today. The preview is then recomputed, and the server reads the
 * plan from the customer's row.
 *
 * CONFIRMATION MODE (batch 02 Phase 5, C1): a funnel payer arrives with
 * `initial`, the answers from the preview they paid against. The wizard
 * starts filled in, asks the server for the preview again (it is
 * non-binding, locked decision 6) and opens on it, saying so when the radius
 * has changed since they paid. Everything after that is the ordinary wizard:
 * they can go back and change any answer, and the confirm route recomputes
 * once more and reports a change (409 radius_changed).
 */

type Step = 1 | 2 | 3 | "preview";
type Issue = { code: string; value?: string; outcode?: string };

export interface BriefWizardProps {
  renewalIso: string | null;
  switchPending: boolean;
  /** A funnel payer's answers from before payment (C1). Absent: the questions start empty. */
  initial?: BriefConfirmationInitial | null;
}

export function BriefWizard({ renewalIso, switchPending, initial = null }: BriefWizardProps) {
  // With `initial`, a preview that cannot be built lands on question 3, one
  // Back away from everything else, rather than on an empty question 1.
  const [step, setStep] = useState<Step>(initial ? 3 : 1);
  const [postcode, setPostcode] = useState(initial?.basePostcode ?? "");
  const [areas, setAreas] = useState<string[]>(initial?.priorityOutcodes ?? []);
  const [travel, setTravel] = useState<Travel | undefined>(initial ? initial.travelLimitMiles : undefined);
  const [beds, setBeds] = useState<number | null>(initial?.minBedrooms ?? null);
  const [gross, setGross] = useState<number | null>(initial?.minGross ?? null);
  const [opening, setOpening] = useState(Boolean(initial));
  const opened = useRef(false);

  const [preview, setPreview] = useState<ClientBriefPreview | null>(null);
  const [ticked, setTicked] = useState<string[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "preview" | "confirm" | "switch">(null);
  const [switchOpen, setSwitchOpen] = useState(false);
  const [switched, setSwitched] = useState(switchPending);

  // `essentials` lets "No, show me everything" send cleared values in the same
  // click, before React has applied the state change.
  const answers = (essentials?: { beds: number | null; gross: number | null }) => ({
    basePostcode: postcode,
    priorityOutcodes: areas.map((a) => a.trim()).flatMap((a) => (a ? [a] : [])),
    travelLimitMiles: travel === undefined ? undefined : travel,
    minBedrooms: essentials ? essentials.beds : beds,
    minGross: essentials ? essentials.gross : gross,
  });

  const issuesFor = (q: 1 | 2 | 3 | "preview") =>
    issues.flatMap((i) => (ISSUE_QUESTION[i.code as BriefIssueCode] === q ? [issueMessage(i)] : []));

  async function requestPreview(
    similarAreas?: string[],
    essentials?: { beds: number | null; gross: number | null }
  ): Promise<ClientBriefPreview | null> {
    setBusy("preview");
    setError(null);
    try {
      const res = await fetch("/api/customer/lead-brief/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          similarAreas ? { ...answers(essentials), similarAreas } : answers(essentials)
        ),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setIssues([]);
        setPreview(data.preview);
        setTicked(Array.isArray(data.similarAreas) ? data.similarAreas : []);
        setStep("preview");
        return data.preview as ClientBriefPreview;
      }
      if (res.status === 400 && Array.isArray(data.issues)) {
        setIssues(data.issues);
        const first = ISSUE_QUESTION[data.issues[0]?.code as BriefIssueCode];
        setStep(first === undefined || first === "preview" ? step : first);
        return null;
      }
      setError(res.status === 503 ? BRIEF_COPY.unavailable : BRIEF_COPY.saveFailed);
    } catch {
      setError(BRIEF_COPY.unavailable);
    } finally {
      setBusy(null);
    }
    return null;
  }

  // Confirmation mode: recalculate the paid-for preview once, on arrival.
  useEffect(() => {
    if (!initial || opened.current) return;
    opened.current = true;
    void (async () => {
      const fresh = await requestPreview(initial.similarAreas);
      if (fresh && radiusChangedSincePayment(initial, fresh.serviceRadiusMiles)) {
        setNotice(radiusChangedLine(fresh.serviceRadiusMiles, fresh.basePostcode));
      }
      setOpening(false);
    })();
    // Runs once: `initial` is fixed for the page's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function confirm() {
    if (!preview) return;
    setBusy("confirm");
    setError(null);
    try {
      const res = await fetch("/api/customer/lead-brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...answers(),
          similarAreas: ticked,
          shownRadiusMiles: preview.serviceRadiusMiles,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        // A full load, so the dashboard layout reads the stamped row.
        window.location.assign("/dashboard");
        return;
      }
      if (res.status === 409 && data.code === "radius_changed" && data.preview) {
        setPreview(data.preview);
        setTicked(Array.isArray(data.similarAreas) ? data.similarAreas : []);
        setNotice(radiusChangedLine(data.preview.serviceRadiusMiles, data.preview.basePostcode));
        return;
      }
      if (res.status === 400 && Array.isArray(data.issues)) {
        setIssues(data.issues);
        return;
      }
      setError(res.status === 503 ? BRIEF_COPY.unavailable : BRIEF_COPY.saveFailed);
    } catch {
      setError(BRIEF_COPY.saveFailed);
    } finally {
      setBusy(null);
    }
  }

  async function switchTo10() {
    setBusy("switch");
    setError(null);
    try {
      const res = await fetch("/api/customer/subscription/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product: "management", plan: "lead_10" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : SWITCH_COPY.failed);
        return;
      }
      setSwitched(true);
      setSwitchOpen(false);
      setNotice(switchDone(typeof data.effectiveAt === "string" ? data.effectiveAt : renewalIso));
    } catch {
      setError(SWITCH_COPY.failed);
      return;
    } finally {
      setBusy(null);
    }
    // The server now reads the 10-lead plan from the row.
    await requestPreview(ticked);
  }

  function toggleArea(area: string) {
    const next = ticked.includes(area) ? ticked.flatMap((a) => (a === area ? [] : [a])) : [...ticked, area];
    void requestPreview(next);
  }

  const totalQuestions = 3;
  const errorBlock = error ? <p className="text-sm text-alert">{error}</p> : null;

  if (opening && !preview) {
    return (
      <Card>
        <CardContent className="space-y-2 pt-6">
          <h1 className="text-xl font-semibold text-ink">{PREVIEW_COPY.title}</h1>
          <p className="text-sm text-ink-2">{BRIEF_COPY.reopening}</p>
        </CardContent>
      </Card>
    );
  }

  if (step === "preview" && preview) {
    return (
      <div className="space-y-6">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold text-ink">{PREVIEW_COPY.title}</h1>
          {initial && <p className="text-sm text-ink-2">{BRIEF_COPY.confirmIntro}</p>}
        </div>
        {notice && <p className="rounded-md bg-brand-light p-3 text-sm text-brand-dark">{notice}</p>}
        {issuesFor("preview").map((m) => (
          <p key={m} className="text-sm text-alert">
            {m}
          </p>
        ))}
        <BriefPreviewView
          preview={preview}
          ticked={ticked}
          minBedrooms={beds}
          minGross={gross}
          renewalIso={renewalIso}
          switched={switched}
          switchOpen={switchOpen}
          busy={busy !== null}
          onToggleArea={toggleArea}
          onWiden={() => {
            setNotice(null);
            setStep(2);
          }}
          onOpenSwitch={() => setSwitchOpen(true)}
          onCancelSwitch={() => setSwitchOpen(false)}
          onConfirmSwitch={() => void switchTo10()}
        />
        {errorBlock}
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void confirm()} disabled={busy !== null}>
            {busy === "confirm" ? BRIEF_COPY.confirming : BRIEF_COPY.confirm}
          </Button>
          <Button variant="ghost" onClick={() => setStep(3)} disabled={busy !== null}>
            {BRIEF_COPY.back}
          </Button>
          {busy === "preview" && <span className="text-sm text-ink-2">{BRIEF_COPY.working}</span>}
          {busy === "switch" && <span className="text-sm text-ink-2">{SWITCH_COPY.working}</span>}
        </div>
      </div>
    );
  }

  const n = step === "preview" ? 3 : step;

  return (
    <Card>
      <CardContent className="space-y-5 pt-6">
        <div className="space-y-1">
          <p className="text-xs text-ink-2">{BRIEF_COPY.stepOf(n, totalQuestions)}</p>
          <h1 className="text-xl font-semibold text-ink">{BRIEF_COPY.pageTitle}</h1>
          {n === 1 && <p className="text-sm text-ink-2">{BRIEF_COPY.pageIntro}</p>}
        </div>

        {n === 1 && (
          <div className="space-y-4">
            <WhereStep
              postcode={postcode}
              onPostcode={setPostcode}
              areas={areas}
              onAreas={setAreas}
              issues={issuesFor(1)}
            />
            <div className="flex gap-2">
              <Button onClick={() => setStep(2)} disabled={postcode.trim() === ""}>
                {BRIEF_COPY.next}
              </Button>
            </div>
          </div>
        )}

        {n === 2 && (
          <div className="space-y-4">
            <TravelStep travel={travel} onTravel={setTravel} issues={issuesFor(2)} />
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setStep(1)}>
                {BRIEF_COPY.back}
              </Button>
              <Button onClick={() => setStep(3)} disabled={travel === undefined}>
                {BRIEF_COPY.next}
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
            />
            {errorBlock}
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="ghost" onClick={() => setStep(2)} disabled={busy !== null}>
                {BRIEF_COPY.back}
              </Button>
              <Button
                variant="outline"
                disabled={busy !== null}
                onClick={() => {
                  setBeds(null);
                  setGross(null);
                  void requestPreview(undefined, { beds: null, gross: null });
                }}
              >
                {BRIEF_COPY.q3.showEverything}
              </Button>
              <Button onClick={() => void requestPreview(undefined)} disabled={busy !== null}>
                {BRIEF_COPY.seePreview}
              </Button>
              {busy === "preview" && <span className="text-sm text-ink-2">{BRIEF_COPY.working}</span>}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
