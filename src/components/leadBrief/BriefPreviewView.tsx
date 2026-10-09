"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  BRIEF_BOOKING_URL,
  LABEL_EXPLANATIONS,
  LABEL_NAMES,
  PREVIEW_COPY,
  SWITCH_COPY,
  bottleneckLines,
  competitionLine,
  coverageLine,
  firstPickLine,
  mixLine,
  outsideCapLine,
  similarFiguresLine,
  switchExplainer,
  tradeoffLine,
  type LabelKey,
} from "@/lib/leadBrief/briefCopy";
import type { ClientBriefPreview } from "@/lib/leadBrief/preview";

/**
 * The match preview (A8's preview screen). Renders a `ClientBriefPreview` and
 * nothing else: no lead counts and no area volumes ever reach this component
 * (A4). Every word comes from briefCopy.ts.
 *
 * The trade-offs and the bottleneck are shown exactly as the engine returns
 * them (A6, A7). The customer can always confirm (A3).
 *
 * `allowSwitch` (default true) offers "Switch to 10 leads a month". The "Your
 * brief" editor (Phase 5) passes false: a plan change there belongs on the
 * Packages page, and the area being previewed starts at the next renewal.
 */

const LABEL_ORDER: LabelKey[] = ["top_match", "strong_match", "first_pick", "nearby_opportunity"];

export interface BriefPreviewViewProps {
  preview: ClientBriefPreview;
  ticked: string[];
  minBedrooms: number | null;
  minGross: number | null;
  renewalIso: string | null;
  switched: boolean;
  switchOpen: boolean;
  busy: boolean;
  allowSwitch?: boolean;
  onToggleArea: (area: string) => void;
  onWiden: () => void;
  onOpenSwitch: () => void;
  onCancelSwitch: () => void;
  onConfirmSwitch: () => void;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-ink">{title}</h2>
      {children}
    </section>
  );
}

export function BriefPreviewView(props: BriefPreviewViewProps) {
  const { preview: p, allowSwitch = true } = props;
  const coverage = [...p.coverage].sort((a, b) => b.plan - a.plan);
  const otherAreas = p.priorityAreas.length - 1;
  const outside = outsideCapLine(p.priorityOutsideCap);

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="space-y-3 pt-6">
          <h2 className="text-base font-semibold text-ink">{PREVIEW_COPY.coverageTitle}</h2>
          <ul className="space-y-1 text-sm">
            {coverage.map((c) => (
              <li
                key={c.plan}
                className={
                  c.plan === p.plan
                    ? "rounded-md bg-brand-light px-3 py-2 font-medium text-brand-dark"
                    : "px-3 py-2 text-ink-2"
                }
              >
                {coverageLine({
                  plan: c.plan,
                  radiusMiles: c.radiusMiles,
                  basePostcode: p.basePostcode,
                  otherAreas,
                })}
                {c.plan === p.plan ? ` · ${PREVIEW_COPY.yourPlan}` : ""}
              </li>
            ))}
          </ul>
          <p className="text-sm text-ink-2">{PREVIEW_COPY.coverageExplainer}</p>
          <p className="text-sm font-medium text-ink">{PREVIEW_COPY.promise}</p>
        </CardContent>
      </Card>

      {p.bottleneck && (
        <Card className="border-attention/40">
          <CardContent className="space-y-3 pt-6 text-sm">
            <h2 className="text-base font-semibold text-ink">{PREVIEW_COPY.bottleneckTitle}</h2>
            {bottleneckLines({
              causes: p.bottleneck.causes,
              current: { minBedrooms: props.minBedrooms, minGross: props.minGross },
              radiusMiles: p.serviceRadiusMiles,
            }).map((line) => (
              <p key={line}>{line}</p>
            ))}
            <p className="text-ink-2">{PREVIEW_COPY.optionsIntro}</p>
            <div className="flex flex-wrap gap-2">
              {p.bottleneck.canWiden && (
                <Button variant="outline" onClick={props.onWiden} disabled={props.busy}>
                  {PREVIEW_COPY.widen}
                </Button>
              )}
              {p.bottleneck.canSwitchToSmallerPlan && allowSwitch && !props.switched && (
                <Button variant="outline" onClick={props.onOpenSwitch} disabled={props.busy}>
                  {PREVIEW_COPY.switchTo10}
                </Button>
              )}
              <Button variant="outline" asChild>
                <a href={BRIEF_BOOKING_URL} target="_blank" rel="noopener noreferrer">
                  {PREVIEW_COPY.bookCall}
                </a>
              </Button>
            </div>
            {allowSwitch && props.switchOpen && (
              <div className="space-y-3 rounded-md border border-line bg-rail p-3">
                <p>{switchExplainer(props.renewalIso)}</p>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={props.onConfirmSwitch} disabled={props.busy}>
                    {SWITCH_COPY.confirm}
                  </Button>
                  <Button variant="ghost" onClick={props.onCancelSwitch} disabled={props.busy}>
                    {SWITCH_COPY.cancel}
                  </Button>
                </div>
              </div>
            )}
            <p className="text-ink-2">{PREVIEW_COPY.canConfirmAnyway}</p>
          </CardContent>
        </Card>
      )}

      {p.tradeoffs.length > 0 && (
        <Section title={PREVIEW_COPY.tradeoffsTitle}>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {p.tradeoffs.map((t) => (
              <li key={`${t.essential}-${t.to}`}>{tradeoffLine(t)}</li>
            ))}
          </ul>
        </Section>
      )}

      <Section title={PREVIEW_COPY.areasTitle}>
        <ul className="space-y-1 text-sm">
          {p.priorityAreas.map((a) => {
            const tier = competitionLine(a.tier);
            return (
              <li key={a.outcode}>
                <span className="font-medium">{a.outcode}</span>
                {tier ? <span className="text-ink-2">{` · ${tier}`}</span> : null}
              </li>
            );
          })}
        </ul>
        {outside && <p className="text-sm text-ink-2">{outside}</p>}
      </Section>

      {p.similarAreas.length > 0 && (
        <Section title={PREVIEW_COPY.similarTitle}>
          <p className="text-sm text-ink-2">{PREVIEW_COPY.similarIntro}</p>
          <ul className="space-y-2">
            {p.similarAreas.map((s) => {
              const tier = competitionLine(s.tier);
              const checked = props.ticked.includes(s.area);
              return (
                <li key={s.area} className="rounded-md border border-line p-3 text-sm">
                  <label className="flex cursor-pointer items-start gap-3">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={checked}
                      disabled={props.busy}
                      onChange={() => props.onToggleArea(s.area)}
                      aria-label={`${PREVIEW_COPY.includeArea}: ${s.city} (${s.area})`}
                    />
                    <span className="space-y-1">
                      <span className="block font-medium">
                        {s.city} ({s.area})
                        {s.recommended ? (
                          <span className="ml-2 rounded bg-brand-light px-2 py-0.5 text-xs text-brand-dark">
                            {PREVIEW_COPY.recommended}
                          </span>
                        ) : null}
                      </span>
                      {tier ? <span className="block text-ink-2">{tier}</span> : null}
                      <span className="block text-ink-2">{similarFiguresLine(s.figures, s.reference)}</span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </Section>
      )}

      <Section title={PREVIEW_COPY.firstPicksTitle}>
        {p.firstPicks.length > 0 ? (
          <>
            <p className="text-sm text-ink-2">{PREVIEW_COPY.firstPicksIntro}</p>
            <p className="text-sm">
              {p.firstPicks.map((f) => firstPickLine(f.outcode, f.tier)).join("; ")}
              {p.moreFirstPicks ? `, ${PREVIEW_COPY.moreFirstPicks}` : ""}
            </p>
          </>
        ) : (
          <p className="text-sm text-ink-2">{PREVIEW_COPY.noFirstPicks}</p>
        )}
      </Section>

      <Section title={PREVIEW_COPY.mixTitle}>
        <ul className="space-y-1 text-sm">
          {LABEL_ORDER.map((l) => (
            <li key={l}>{mixLine(l, p.expectedMix[l] ?? 0)}</li>
          ))}
        </ul>
        <p className="text-xs text-ink-2">{PREVIEW_COPY.mixNote}</p>
      </Section>

      <Section title={PREVIEW_COPY.labelsTitle}>
        <p className="text-sm text-ink-2">{PREVIEW_COPY.labelsIntro}</p>
        <dl className="space-y-1 text-sm">
          {LABEL_ORDER.map((l) => (
            <div key={l}>
              <dt className="inline font-medium">{LABEL_NAMES[l]}: </dt>
              <dd className="inline text-ink-2">{LABEL_EXPLANATIONS[l]}</dd>
            </div>
          ))}
        </dl>
      </Section>
    </div>
  );
}
