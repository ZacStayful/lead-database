"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  CASE_CHANNELS,
  CASE_DIRECTIONS,
  CASE_LOSS_REASONS,
  CHANNEL_LABEL,
  LOSS_REASON_LABEL,
  caseSlugFromReference,
} from "@/lib/caseStudies";
import type {
  CaseStudy,
  CaseStudyChannel,
  CaseStudyConfidence,
  CaseStudyDirection,
  CaseStudyEvent,
  CaseStudyGate,
  CaseStudyLossReason,
  CaseStudyOutcome,
} from "@/lib/types";

const INPUT =
  "mt-1 w-full rounded-md border-[0.5px] border-border bg-background px-3 py-2 text-sm disabled:opacity-60";
const CELL =
  "w-full rounded-md border-[0.5px] border-border bg-background px-2 py-1.5 text-sm disabled:opacity-60";

type EventRow = {
  day_offset: string;
  channel: CaseStudyChannel;
  direction: CaseStudyDirection;
  description: string;
  is_setback: boolean;
  is_outcome: boolean;
};

function toRow(e: CaseStudyEvent): EventRow {
  return {
    day_offset: String(e.day_offset),
    channel: e.channel,
    direction: e.direction,
    description: e.description,
    is_setback: e.is_setback,
    is_outcome: e.is_outcome,
  };
}

function blankRow(): EventRow {
  return {
    day_offset: "0",
    channel: "email",
    direction: "outbound",
    description: "",
    is_setback: false,
    is_outcome: false,
  };
}

/**
 * Create and edit form for a case study and its timeline.
 *
 * There is no field here for a name, a date, an address or a postcode. That is
 * not an omission to be corrected later — the columns do not exist (migration
 * 0057), so the anonymised shape is the only shape this form can produce.
 *
 * The event rows are sent as one array with the parent and replace the stored
 * timeline wholesale, inside a single transaction. Row order in this list is
 * the order that gets stored.
 */
export function AdminCaseStudyForm({
  caseStudy,
  events: initialEvents,
  existingSlugs,
}: {
  caseStudy?: CaseStudy;
  events?: CaseStudyEvent[];
  existingSlugs: string[];
}) {
  const router = useRouter();
  const isEdit = Boolean(caseStudy);

  const [reference, setReference] = useState(caseStudy?.reference ?? "");
  const [slug, setSlug] = useState(caseStudy?.slug ?? "");
  const [slugTouched, setSlugTouched] = useState(isEdit);
  const [outcome, setOutcome] = useState<CaseStudyOutcome>(
    caseStudy?.outcome ?? "signed"
  );
  const [lossReason, setLossReason] = useState<CaseStudyLossReason | "">(
    caseStudy?.loss_reason ?? ""
  );
  const [gate, setGate] = useState<CaseStudyGate>(
    caseStudy?.gate_reached ?? "meeting_or_after"
  );
  const [days, setDays] = useState(String(caseStudy?.days_to_outcome ?? 0));
  const [propertySummary, setPropertySummary] = useState(
    caseStudy?.property_summary ?? ""
  );
  const [headline, setHeadline] = useState(caseStudy?.headline ?? "");
  const [summary, setSummary] = useState(caseStudy?.summary ?? "");
  const [lesson, setLesson] = useState(caseStudy?.lesson_markdown ?? "");
  const [emailsOut, setEmailsOut] = useState(str(caseStudy?.emails_out));
  const [callsMade, setCallsMade] = useState(str(caseStudy?.calls_made));
  const [callsAnswered, setCallsAnswered] = useState(str(caseStudy?.calls_answered));
  const [inboundReplies, setInboundReplies] = useState(str(caseStudy?.inbound_replies));
  const [meetingsSat, setMeetingsSat] = useState(str(caseStudy?.meetings_sat));
  const [hadNoShow, setHadNoShow] = useState(caseStudy?.had_no_show ?? false);
  const [offerApplied, setOfferApplied] = useState(caseStudy?.offer_applied ?? false);
  const [confidence, setConfidence] = useState<CaseStudyConfidence>(
    caseStudy?.data_confidence ?? "crm_verified"
  );
  const [sortOrder, setSortOrder] = useState(String(caseStudy?.sort_order ?? 0));
  const [published, setPublished] = useState(caseStudy?.is_published ?? false);

  const [rows, setRows] = useState<EventRow[]>(
    (initialEvents ?? []).map(toRow)
  );

  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const slugCollides = slug !== "" && existingSlugs.includes(slug);
  const outcomeCount = rows.filter((r) => r.is_outcome).length;

  function onReferenceChange(value: string) {
    setReference(value);
    if (!slugTouched) setSlug(caseSlugFromReference(value));
  }

  function updateRow(index: number, patch: Partial<EventRow>) {
    setRows((current) =>
      current.map((row, i) => (i === index ? { ...row, ...patch } : row))
    );
  }

  function moveRow(index: number, delta: number) {
    setRows((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);

    const payload = {
      slug,
      reference,
      outcome,
      loss_reason: outcome === "lost" ? lossReason || null : null,
      gate_reached: gate,
      days_to_outcome: Number(days) || 0,
      property_summary: propertySummary,
      headline,
      summary,
      lesson_markdown: lesson || null,
      emails_out: emailsOut || null,
      calls_made: callsMade || null,
      calls_answered: callsAnswered || null,
      inbound_replies: inboundReplies || null,
      meetings_sat: meetingsSat || null,
      had_no_show: hadNoShow,
      offer_applied: offerApplied,
      data_confidence: confidence,
      sort_order: Number(sortOrder) || 0,
      is_published: published,
      events: rows.map((r) => ({
        day_offset: Number(r.day_offset) || 0,
        channel: r.channel,
        direction: r.direction,
        description: r.description,
        is_setback: r.is_setback,
        is_outcome: r.is_outcome,
      })),
    };

    try {
      const res = await fetch(
        isEdit ? `/api/admin/case-studies/${caseStudy!.id}` : "/api/admin/case-studies",
        {
          method: isEdit ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      const data = await res.json().catch(() => null);

      if (!res.ok) {
        setError(data?.error ?? "Could not save this case study.");
        return;
      }

      if (!isEdit && data?.id) {
        router.push(`/admin/training/case-studies/${data.id}`);
        return;
      }

      setNotice("Saved");
      router.refresh();
    } catch {
      setError("Could not save this case study.");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/case-studies/${caseStudy!.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error ?? "Could not delete this case study.");
        return;
      }
      router.push("/admin/training/case-studies");
    } catch {
      setError("Could not delete this case study.");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="reference" className="text-sm font-medium">
            Reference
          </label>
          <input
            id="reference"
            value={reference}
            onChange={(e) => onReferenceChange(e.target.value)}
            placeholder="Case 10"
            disabled={saving}
            className={INPUT}
          />
        </div>
        <div>
          <label htmlFor="slug" className="text-sm font-medium">
            Slug
          </label>
          <input
            id="slug"
            value={slug}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value);
            }}
            disabled={saving}
            className={INPUT}
          />
          {slugCollides && (
            <p className="mt-1 text-sm text-amber-700">
              Another case already uses this slug. Saving will be refused.
            </p>
          )}
        </div>
      </div>

      <div>
        <label htmlFor="property_summary" className="text-sm font-medium">
          Property summary
        </label>
        <input
          id="property_summary"
          value={propertySummary}
          onChange={(e) => setPropertySummary(e.target.value)}
          placeholder="Two-bed, South East"
          disabled={saving}
          className={INPUT}
        />
        <p className="mt-1 text-sm text-muted-foreground">
          Region only. No town, address or postcode.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-4">
        <div>
          <label htmlFor="outcome" className="text-sm font-medium">
            Outcome
          </label>
          <select
            id="outcome"
            value={outcome}
            onChange={(e) => {
              const next = e.target.value as CaseStudyOutcome;
              setOutcome(next);
              if (next === "signed") setLossReason("");
            }}
            disabled={saving}
            className={INPUT}
          >
            <option value="signed">Signed</option>
            <option value="lost">Not signed</option>
          </select>
        </div>

        {outcome === "lost" && (
          <div>
            <label htmlFor="loss_reason" className="text-sm font-medium">
              Loss reason
            </label>
            <select
              id="loss_reason"
              value={lossReason}
              onChange={(e) =>
                setLossReason(e.target.value as CaseStudyLossReason | "")
              }
              disabled={saving}
              className={INPUT}
            >
              <option value="">Choose one</option>
              {CASE_LOSS_REASONS.map((r) => (
                <option key={r} value={r}>
                  {LOSS_REASON_LABEL[r]}
                </option>
              ))}
            </select>
          </div>
        )}

        <div>
          <label htmlFor="gate" className="text-sm font-medium">
            Gate reached
          </label>
          <select
            id="gate"
            value={gate}
            onChange={(e) => setGate(e.target.value as CaseStudyGate)}
            disabled={saving}
            className={INPUT}
          >
            <option value="pre_meeting">Before a meeting</option>
            <option value="meeting_or_after">Meeting or later</option>
          </select>
        </div>

        <div>
          <label htmlFor="days" className="text-sm font-medium">
            Days to outcome
          </label>
          <input
            id="days"
            type="number"
            min={0}
            value={days}
            onChange={(e) => setDays(e.target.value)}
            disabled={saving}
            className={INPUT}
          />
        </div>
      </div>

      <div>
        <label htmlFor="headline" className="text-sm font-medium">
          Headline
        </label>
        <input
          id="headline"
          value={headline}
          onChange={(e) => setHeadline(e.target.value)}
          disabled={saving}
          className={INPUT}
        />
      </div>

      <div>
        <label htmlFor="summary" className="text-sm font-medium">
          Summary
        </label>
        <textarea
          id="summary"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          rows={3}
          disabled={saving}
          className={INPUT}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-5">
        <NumberField label="Emails out" value={emailsOut} onChange={setEmailsOut} disabled={saving} />
        <NumberField label="Calls made" value={callsMade} onChange={setCallsMade} disabled={saving} />
        <NumberField label="Calls answered" value={callsAnswered} onChange={setCallsAnswered} disabled={saving} />
        <NumberField label="Inbound replies" value={inboundReplies} onChange={setInboundReplies} disabled={saving} />
        <NumberField label="Meetings sat" value={meetingsSat} onChange={setMeetingsSat} disabled={saving} />
      </div>

      <div className="flex flex-wrap gap-6">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={hadNoShow}
            onChange={(e) => setHadNoShow(e.target.checked)}
            disabled={saving}
          />
          Had a no-show
        </label>
        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={offerApplied}
            onChange={(e) => setOfferApplied(e.target.checked)}
            disabled={saving}
          />
          Offer applied
        </label>
        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={published}
            onChange={(e) => setPublished(e.target.checked)}
            disabled={saving}
          />
          Published
        </label>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="confidence" className="text-sm font-medium">
            Data confidence
          </label>
          <select
            id="confidence"
            value={confidence}
            onChange={(e) => setConfidence(e.target.value as CaseStudyConfidence)}
            disabled={saving}
            className={INPUT}
          >
            <option value="crm_verified">CRM verified</option>
            <option value="partly_reconstructed">Partly reconstructed</option>
          </select>
        </div>
        <div>
          <label htmlFor="sort_order" className="text-sm font-medium">
            Sort order
          </label>
          <input
            id="sort_order"
            type="number"
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value)}
            disabled={saving}
            className={INPUT}
          />
        </div>
      </div>

      <div>
        <label htmlFor="lesson" className="text-sm font-medium">
          What this teaches
        </label>
        <textarea
          id="lesson"
          value={lesson}
          onChange={(e) => setLesson(e.target.value)}
          rows={10}
          disabled={saving}
          className={INPUT + " font-mono"}
        />
        <p className="mt-1 text-sm text-muted-foreground">
          Plain text. Blank lines separate paragraphs.
        </p>
      </div>

      <div className="space-y-3 rounded-md border-[0.5px] border-border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">Timeline ({rows.length} events)</h3>
          <button
            type="button"
            onClick={() => setRows((c) => [...c, blankRow()])}
            disabled={saving}
            className="rounded-md border-[0.5px] border-border px-3 py-1.5 text-sm font-medium hover:bg-accent disabled:opacity-50"
          >
            Add event
          </button>
        </div>

        <p className="text-sm text-muted-foreground">
          Days are counted from the enquiry. There is no date field — a real date
          plus a region can identify a landlord.
        </p>

        {outcomeCount > 1 && (
          <p className="text-sm text-red-700">
            Only one event can be marked as the outcome. Currently {outcomeCount}.
          </p>
        )}

        {rows.length === 0 && (
          <p className="text-sm text-muted-foreground">No events yet.</p>
        )}

        {rows.map((row, index) => (
          <div
            key={index}
            className="grid items-center gap-2 border-t-[0.5px] border-border pt-3 sm:grid-cols-[4rem_7rem_6rem_1fr_auto]"
          >
            <input
              type="number"
              min={0}
              aria-label={`Event ${index + 1} day`}
              value={row.day_offset}
              onChange={(e) => updateRow(index, { day_offset: e.target.value })}
              disabled={saving}
              className={CELL}
            />
            <select
              aria-label={`Event ${index + 1} channel`}
              value={row.channel}
              onChange={(e) =>
                updateRow(index, { channel: e.target.value as CaseStudyChannel })
              }
              disabled={saving}
              className={CELL}
            >
              {CASE_CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {CHANNEL_LABEL[c]}
                </option>
              ))}
            </select>
            <select
              aria-label={`Event ${index + 1} direction`}
              value={row.direction}
              onChange={(e) =>
                updateRow(index, { direction: e.target.value as CaseStudyDirection })
              }
              disabled={saving}
              className={CELL}
            >
              {CASE_DIRECTIONS.map((d) => (
                <option key={d} value={d}>
                  {d === "none" ? "—" : d}
                </option>
              ))}
            </select>
            <input
              aria-label={`Event ${index + 1} description`}
              value={row.description}
              onChange={(e) => updateRow(index, { description: e.target.value })}
              placeholder="What happened"
              disabled={saving}
              className={CELL}
            />
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={row.is_setback}
                  onChange={(e) => updateRow(index, { is_setback: e.target.checked })}
                  disabled={saving}
                />
                Setback
              </label>
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={row.is_outcome}
                  onChange={(e) => updateRow(index, { is_outcome: e.target.checked })}
                  disabled={saving}
                />
                Outcome
              </label>
              <button
                type="button"
                onClick={() => moveRow(index, -1)}
                disabled={saving || index === 0}
                aria-label="Move up"
                className="rounded px-1.5 text-muted-foreground hover:bg-accent disabled:opacity-30"
              >
                ↑
              </button>
              <button
                type="button"
                onClick={() => moveRow(index, 1)}
                disabled={saving || index === rows.length - 1}
                aria-label="Move down"
                className="rounded px-1.5 text-muted-foreground hover:bg-accent disabled:opacity-30"
              >
                ↓
              </button>
              <button
                type="button"
                onClick={() => setRows((c) => c.filter((_, i) => i !== index))}
                disabled={saving}
                className="rounded px-1.5 text-muted-foreground hover:bg-accent disabled:opacity-50"
              >
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>

      {error && <p className="text-sm text-red-700">{error}</p>}
      {notice && <p className="text-sm text-muted-foreground">{notice}</p>}

      <div className="flex flex-wrap gap-3">
        <button
          type="submit"
          disabled={saving}
          className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {saving ? "Saving" : isEdit ? "Save changes" : "Create case study"}
        </button>

        {isEdit &&
          (confirmDelete ? (
            <>
              <button
                type="button"
                onClick={() => void remove()}
                disabled={deleting}
                className="rounded-md border-[0.5px] border-red-300 bg-red-50 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
              >
                {deleting ? "Deleting" : "Confirm delete"}
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                disabled={deleting}
                className="rounded-md px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-accent"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="rounded-md px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-accent"
            >
              Delete
            </button>
          ))}
      </div>
    </form>
  );
}

function str(value: number | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

function NumberField({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  return (
    <div>
      <label className="text-sm font-medium">{label}</label>
      <input
        type="number"
        min={0}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className={INPUT}
      />
    </div>
  );
}
