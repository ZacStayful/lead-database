"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/utils";
import { statusBadge } from "@/components/dashboard/leadStatus";
import type { AssignmentWithLead } from "@/lib/types";
import { ArrowLeft, BarChart3, Mail, Phone, MapPin, Calendar } from "lucide-react";

export function LeadDetail({
  assignment,
}: {
  assignment: AssignmentWithLead;
}) {
  const router = useRouter();
  const lead = assignment.lead;
  const [status, setStatus] = useState(assignment.status);
  const [showRejectConfirm, setShowRejectConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  async function handleAccept() {
    setBusy(true);
    setStatus("contacted");
    try {
      await fetch(`/api/customer/assignments/${assignment.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contacted: true }),
      });
      router.refresh();
    } catch {
      setStatus(assignment.status); // revert on failure
    } finally {
      setBusy(false);
    }
  }

  async function handleReject() {
    setBusy(true);
    try {
      const res = await fetch(`/api/leads/${assignment.lead_id}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignment_id: assignment.id }),
      });
      if (!res.ok) throw new Error();
      setStatus("rejected");
      setShowRejectConfirm(false);
      setToast("Lead rejected — a replacement will arrive shortly");
      router.refresh();
    } catch {
      setToast("Could not reject this lead. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const badge = statusBadge(status);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <Link
        href="/dashboard/leads"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        All leads
      </Link>

      {toast && (
        <div className="rounded-lg border-[0.5px] border-border bg-muted/50 px-4 py-3 text-sm">
          {toast}
        </div>
      )}

      <div className="rounded-xl border-[0.5px] border-border bg-card p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold">{lead.lead_name}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Assigned {formatDate(assignment.assigned_at)}
            </p>
          </div>
          <Badge variant="outline" className={badge.className}>
            {badge.label}
          </Badge>
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <Detail icon={Mail} label="Email" value={lead.email} isEmail />
          <Detail icon={Phone} label="Phone" value={lead.phone} isPhone />
          <Detail icon={MapPin} label="Address" value={lead.address} />
          <Detail
            icon={Calendar}
            label="Enquiry date"
            value={formatDate(lead.enquiry_date)}
          />
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <FieldRow label="Bedrooms" value={lead.bedrooms} />
        </div>

        {lead.lead_profile && (
          <div className="mt-4 rounded-md bg-muted/50 p-3 text-sm">
            <p className="mb-1 font-medium text-muted-foreground">
              Lead profile notes
            </p>
            <p>{lead.lead_profile}</p>
          </div>
        )}

        <div className="mt-4">
          <Button size="sm" asChild>
            <a
              href="https://intelligence.stayful.co.uk"
              target="_blank"
              rel="noopener noreferrer"
            >
              <BarChart3 className="h-4 w-4" />
              Open STR Analyser
            </a>
          </Button>
        </div>

        {status === "new" && (
          <div className="mt-6 flex flex-col gap-3">
            <button
              onClick={() => handleAccept()}
              disabled={busy}
              className="w-full rounded-lg bg-[#3B6D11] px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-[#2d5409] disabled:opacity-60"
            >
              Mark as contacted
            </button>
            {!showRejectConfirm ? (
              <button
                onClick={() => setShowRejectConfirm(true)}
                disabled={busy}
                className="w-full rounded-lg border border-black/10 px-6 py-3 text-sm font-medium text-[#898781] transition-colors hover:bg-gray-50"
              >
                Reject this lead
              </button>
            ) : (
              <div className="rounded-xl border border-black/10 bg-white p-4">
                <p className="mb-3 text-sm text-[#52514e]">
                  Are you sure? This lead will be reassigned and you will receive
                  another lead in its place.
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleReject()}
                    disabled={busy}
                    className="flex-1 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-60"
                  >
                    Confirm rejection
                  </button>
                  <button
                    onClick={() => setShowRejectConfirm(false)}
                    disabled={busy}
                    className="flex-1 rounded-lg border border-black/10 px-4 py-2 text-sm font-medium text-[#52514e] transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function FieldRow({
  label,
  value,
}: {
  label: string;
  value?: string | null;
}) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm">{value || "—"}</p>
    </div>
  );
}

function Detail({
  icon: Icon,
  label,
  value,
  isEmail,
  isPhone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value?: string | null;
  isEmail?: boolean;
  isPhone?: boolean;
}) {
  const display = value || "—";
  return (
    <div className="flex items-start gap-2">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        {isEmail && value ? (
          <a href={`mailto:${value}`} className="text-sm text-brand hover:underline">
            {value}
          </a>
        ) : isPhone && value ? (
          <a href={`tel:${value}`} className="text-sm text-brand hover:underline">
            {value}
          </a>
        ) : (
          <p className="truncate text-sm">{display}</p>
        )}
      </div>
    </div>
  );
}
