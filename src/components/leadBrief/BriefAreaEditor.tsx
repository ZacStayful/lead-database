"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { BriefPreviewView } from "@/components/leadBrief/BriefPreviewView";
import { WhereStep } from "@/components/leadBrief/steps/WhereStep";
import { TravelStep, type Travel } from "@/components/leadBrief/steps/TravelStep";
import { EssentialsStep } from "@/components/leadBrief/steps/EssentialsStep";
import {
  BRIEF_COPY,
  ISSUE_QUESTION,
  issueMessage,
  type BriefIssueCode,
} from "@/lib/leadBrief/briefCopy";
import { EDIT_COPY } from "@/lib/leadBrief/editCopy";
import type { ClientBriefPreview } from "@/lib/leadBrief/preview";

/**
 * The area half of the "Your brief" editor (Lead Brief Phase 5): the three
 * questions (A8, the same step components as the questionnaire), then the
 * preview of the new area, then save. A saved change starts at the NEXT
 * RENEWAL, and the screen says the date before and after saving.
 *
 * The server decides everything: the preview is recomputed against live
 * supply, the ranking and the customer's chosen levels come from their stored
 * brief, and a save that does not match the radius shown is refused with a
 * fresh preview (409 `radius_changed`). The base postcode is read-only here
 * (batch 05, locked decision 1) and both routes refuse a different one (409
 * `postcode_locked`). There is no "Switch to 10 leads a
 * month" here (`allowSwitch={false}`). Every word is in briefCopy.ts and
 * editCopy.ts.
 */
type Issue = { code: string; value?: string; outcode?: string };

export interface BriefAreaAnswers {
  basePostcode: string;
  priorityOutcodes: string[];
  travel: Travel;
  minBedrooms: number | null;
  minGross: number | null;
  similarAreas: string[];
}

export interface BriefAreaEditorProps {
  activeId: string;
  initial: BriefAreaAnswers;
  startsOnIso: string | null;
  readOnly: boolean;
}

export function BriefAreaEditor(props: BriefAreaEditorProps) {
  const router = useRouter();
  const [mode, setMode] = useState<"closed" | "editing" | "preview">("closed");
  const [postcode, setPostcode] = useState(props.initial.basePostcode);
  const [areas, setAreas] = useState<string[]>(props.initial.priorityOutcodes);
  const [travel, setTravel] = useState<Travel | undefined>(props.initial.travel);
  const [beds, setBeds] = useState<number | null>(props.initial.minBedrooms);
  const [gross, setGross] = useState<number | null>(props.initial.minGross);
  const [preview, setPreview] = useState<ClientBriefPreview | null>(null);
  const [ticked, setTicked] = useState<string[]>(props.initial.similarAreas);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "preview" | "save">(null);

  const answers = () => ({
    basePostcode: postcode,
    priorityOutcodes: areas.map((a) => a.trim()).flatMap((a) => (a ? [a] : [])),
    travelLimitMiles: travel === undefined ? undefined : travel,
    minBedrooms: beds,
    minGross: gross,
  });

  const issuesFor = (q: 1 | 2 | 3 | "preview") =>
    issues.flatMap((i) => (ISSUE_QUESTION[i.code as BriefIssueCode] === q ? [issueMessage(i)] : []));

  async function requestPreview(similarAreas: string[]) {
    setBusy("preview");
    setError(null);
    try {
      const res = await fetch("/api/customer/lead-brief/edit/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...answers(), similarAreas }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setIssues([]);
        setPreview(data.preview);
        setTicked(Array.isArray(data.similarAreas) ? data.similarAreas : []);
        setMode("preview");
        return;
      }
      if (res.status === 400 && Array.isArray(data.issues)) {
        setIssues(data.issues);
        setMode("editing");
        return;
      }
      if (res.status === 409 && data.code === "postcode_locked") setError(EDIT_COPY.errors.postcodeLocked);
      else if (res.status === 409) setError(EDIT_COPY.errors.conflict);
      else setError(res.status === 503 ? EDIT_COPY.errors.unavailable : EDIT_COPY.errors.failed);
    } catch {
      setError(EDIT_COPY.errors.unavailable);
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    if (!preview) return;
    setBusy("save");
    setError(null);
    try {
      const res = await fetch("/api/customer/lead-brief/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "area",
          expectedActiveId: props.activeId,
          ...answers(),
          similarAreas: ticked,
          shownRadiusMiles: preview.serviceRadiusMiles,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setNotice(EDIT_COPY.area.savedOn(typeof data.startsOn === "string" ? data.startsOn : props.startsOnIso));
        setMode("closed");
        setPreview(null);
        router.refresh();
        return;
      }
      if (res.status === 409 && data.code === "radius_changed" && data.preview) {
        setPreview(data.preview);
        setTicked(Array.isArray(data.similarAreas) ? data.similarAreas : []);
        setError(EDIT_COPY.errors.radiusChanged);
        return;
      }
      if (res.status === 409 && data.code === "postcode_locked") setError(EDIT_COPY.errors.postcodeLocked);
      else if (res.status === 409) setError(EDIT_COPY.errors.conflict);
      else if (data.code === "nothing_changed") setError(EDIT_COPY.errors.nothingChanged);
      else if (res.status === 400 && Array.isArray(data.issues)) {
        setIssues(data.issues);
        setMode("editing");
      } else setError(res.status === 503 ? EDIT_COPY.errors.unavailable : EDIT_COPY.errors.failed);
    } catch {
      setError(EDIT_COPY.errors.failed);
    } finally {
      setBusy(null);
    }
  }

  function toggleArea(area: string) {
    const next = ticked.includes(area) ? ticked.flatMap((a) => (a === area ? [] : [a])) : [...ticked, area];
    void requestPreview(next);
  }

  const errorBlock = error ? <p className="text-sm text-alert">{error}</p> : null;
  const working = busy === "preview" ? <span className="text-sm text-ink-2">{BRIEF_COPY.working}</span> : null;

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-ink">{EDIT_COPY.area.title}</h2>
          <p className="text-sm text-ink-2">{EDIT_COPY.area.intro}</p>
        </div>

        {notice && <p className="rounded-md bg-brand-light p-3 text-sm text-brand-dark">{notice}</p>}

        {mode === "closed" && !props.readOnly && (
          <Button
            variant="outline"
            onClick={() => {
              setNotice(null);
              setMode("editing");
            }}
          >
            {EDIT_COPY.area.edit}
          </Button>
        )}

        {mode === "editing" && (
          <div className="space-y-6">
            <div className="space-y-4">
              <WhereStep
                postcode={postcode}
                onPostcode={setPostcode}
                areas={areas}
                onAreas={setAreas}
                issues={issuesFor(1)}
                idPrefix="edit"
                postcodeLockedNote={EDIT_COPY.area.postcodeLocked}
              />
            </div>
            <div className="space-y-4">
              <TravelStep travel={travel} onTravel={setTravel} issues={issuesFor(2)} />
            </div>
            <div className="space-y-4">
              <EssentialsStep
                beds={beds}
                onBeds={setBeds}
                gross={gross}
                onGross={setGross}
                issues={issuesFor(3)}
                idPrefix="edit"
              />
            </div>
            {issuesFor("preview").map((m) => (
              <p key={m} className="text-sm text-alert">
                {m}
              </p>
            ))}
            {errorBlock}
            <p className="text-sm text-ink-2">{EDIT_COPY.area.startsOn(props.startsOnIso)}</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={() => void requestPreview(ticked)}
                disabled={busy !== null || postcode.trim() === "" || travel === undefined}
              >
                {EDIT_COPY.area.preview}
              </Button>
              <Button variant="ghost" onClick={() => setMode("closed")} disabled={busy !== null}>
                {EDIT_COPY.area.cancel}
              </Button>
              {working}
            </div>
          </div>
        )}

        {mode === "preview" && preview && (
          <div className="space-y-6">
            <BriefPreviewView
              preview={preview}
              ticked={ticked}
              minBedrooms={beds}
              minGross={gross}
              renewalIso={props.startsOnIso}
              switched={false}
              switchOpen={false}
              busy={busy !== null}
              allowSwitch={false}
              onToggleArea={toggleArea}
              onWiden={() => setMode("editing")}
              onOpenSwitch={() => undefined}
              onCancelSwitch={() => undefined}
              onConfirmSwitch={() => undefined}
            />
            {errorBlock}
            <p className="text-sm font-medium text-ink">{EDIT_COPY.area.startsOn(props.startsOnIso)}</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => void save()} disabled={busy !== null}>
                {busy === "save" ? EDIT_COPY.area.saving : EDIT_COPY.area.save}
              </Button>
              <Button variant="ghost" onClick={() => setMode("editing")} disabled={busy !== null}>
                {BRIEF_COPY.back}
              </Button>
              <Button variant="ghost" onClick={() => setMode("closed")} disabled={busy !== null}>
                {EDIT_COPY.area.cancel}
              </Button>
              {working}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
