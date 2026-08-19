"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn, formatDate } from "@/lib/utils";
import type { PoolLead } from "@/lib/types";
import { IncomeProjection } from "@/components/dashboard/IncomeProjection";
import { Mail, Phone, MapPin, BedDouble, Clock } from "lucide-react";

type ClaimOutcome =
  | { kind: "claimed"; spentCredit: boolean; poolDebit: number }
  | { kind: "lost" }
  | { kind: "gone" }
  | { kind: "error"; message: string };

/**
 * The expired leads pool, one product at a time.
 *
 * `credits` is the customer's remaining balance for THIS product. It drives the
 * cost wording and nothing else — a claim at zero succeeds either way, so this
 * is honesty about the price, not a gate.
 */
export function ExpiredLeadsPool({
  leads,
  credits,
  productLabel,
}: {
  leads: PoolLead[];
  credits: number;
  productLabel: string;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, ClaimOutcome>>({});
  // Counted down locally so a customer claiming several in one sitting sees the
  // wording switch to the next-cycle version at the right moment, rather than
  // after a page refresh they have no reason to trigger.
  const [remaining, setRemaining] = useState(credits);

  async function claim(leadId: string) {
    setBusy(leadId);
    try {
      const res = await fetch(`/api/leads/pool/${leadId}/claim`, {
        method: "POST",
      });
      const body = await res.json();

      if (!res.ok) {
        setOutcomes((o) => ({
          ...o,
          [leadId]: { kind: "error", message: body?.error ?? "Something went wrong" },
        }));
        return;
      }

      if (body.ok) {
        setOutcomes((o) => ({
          ...o,
          [leadId]: {
            kind: "claimed",
            spentCredit: body.spent_credit,
            poolDebit: body.pool_debit,
          },
        }));
        if (body.spent_credit) setRemaining((r) => Math.max(r - 1, 0));
        // Pull the lead out of every other list on the next navigation.
        router.refresh();
        return;
      }

      setOutcomes((o) => ({
        ...o,
        [leadId]: body.status === "already_claimed" ? { kind: "lost" } : { kind: "gone" },
      }));
    } catch {
      setOutcomes((o) => ({
        ...o,
        [leadId]: { kind: "error", message: "Could not reach the server" },
      }));
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  }

  if (leads.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center">
        <p className="font-medium">No expired {productLabel.toLowerCase()} leads</p>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
          Every lead we have sent out is being worked. That is the outcome we
          want — an empty pool means nothing is going to waste. Check back when
          you have capacity for more.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {leads.map((lead) => {
        const outcome = outcomes[lead.lead_id];
        const isConfirming = confirming === lead.lead_id;
        const isBusy = busy === lead.lead_id;

        if (outcome?.kind === "claimed") {
          return (
            <div
              key={lead.lead_id}
              className="rounded-lg border border-brand/40 bg-brand/5 p-4"
            >
              <p className="font-medium">{lead.lead_name} is yours</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {outcome.spentCredit
                  ? "One lead has come off this cycle's allocation. You will find it in your leads tab with everything else."
                  : `You had no credits left, so next cycle's allocation is reduced by ${
                      outcome.poolDebit === 1 ? "one lead" : `${outcome.poolDebit} leads`
                    }. The lead is in your leads tab now.`}
              </p>
            </div>
          );
        }

        if (outcome?.kind === "lost" || outcome?.kind === "gone") {
          return (
            <div key={lead.lead_id} className="rounded-lg border bg-muted/30 p-4">
              <p className="text-sm text-muted-foreground">
                {outcome.kind === "lost"
                  ? `Another subscriber claimed ${lead.lead_name} first.`
                  : `${lead.lead_name} is no longer available.`}
              </p>
            </div>
          );
        }

        return (
          <div key={lead.lead_id} className="rounded-lg border bg-card p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-semibold">{lead.lead_name}</p>
                {lead.address && (
                  <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
                    <MapPin className="h-3.5 w-3.5 shrink-0" />
                    {lead.address}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                {lead.bedrooms && (
                  <Badge variant="secondary">
                    <BedDouble className="mr-1 h-3 w-3" />
                    {lead.bedrooms}
                  </Badge>
                )}
                <Badge variant="secondary">
                  <Clock className="mr-1 h-3 w-3" />
                  {lead.days_in_pool === 0
                    ? "In the pool today"
                    : `In the pool ${lead.days_in_pool} ${
                        lead.days_in_pool === 1 ? "day" : "days"
                      }`}
                </Badge>
              </div>
            </div>

            {/* Contact details in the clear, before claiming. That is the
                point: ring them, find out whether the landlord is still
                looking, and only then decide whether to keep the lead. */}
            <div className="mt-3 flex flex-wrap gap-4 text-sm">
              {lead.phone && (
                <a
                  href={`tel:${lead.phone}`}
                  className="flex items-center gap-1.5 font-medium text-brand hover:underline"
                >
                  <Phone className="h-3.5 w-3.5" />
                  {lead.phone}
                </a>
              )}
              {lead.email && (
                <a
                  href={`mailto:${lead.email}`}
                  className="flex items-center gap-1.5 text-muted-foreground hover:underline"
                >
                  <Mail className="h-3.5 w-3.5" />
                  {lead.email}
                </a>
              )}
            </div>

            {(lead.lead_profile || lead.desired_rent) && (
              <div className="mt-3 space-y-1 text-sm text-muted-foreground">
                {lead.lead_profile && <p>{lead.lead_profile}</p>}
                {lead.desired_rent && <p>Desired rent: {lead.desired_rent}</p>}
              </div>
            )}

            {/*
              The one figure that answers "is this call worth making", on the
              card where that is the only question. Compact, because the claim
              decision is already carrying the contact details and the scarcity
              line.
            */}
            <IncomeProjection lead={lead} variant="compact" className="mt-3" />

            <p className="mt-3 text-xs text-muted-foreground">
              {lead.enquiry_date_known
                ? `Enquired ${formatDate(lead.enquiry_date)} — ${lead.lead_age_days} days ago`
                : `Received by us ${lead.lead_age_days} days ago (no enquiry date recorded)`}
            </p>

            <div className="mt-4 border-t pt-3">
              {isConfirming ? (
                <div className="space-y-3">
                  <p className="text-sm">
                    {remaining > 0 ? (
                      <>
                        Claiming {lead.lead_name} uses one lead from this
                        cycle&apos;s allocation. You have {remaining}{" "}
                        {remaining === 1 ? "credit" : "credits"} left.
                      </>
                    ) : (
                      <>
                        You have no credits remaining this cycle. Claiming this
                        lead will reduce next cycle&apos;s allocation by one.
                      </>
                    )}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      disabled={isBusy}
                      onClick={() => void claim(lead.lead_id)}
                    >
                      {isBusy ? "Claiming…" : "Confirm claim"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={isBusy}
                      onClick={() => setConfirming(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-xs text-muted-foreground">
                    Ringing this landlord costs you nothing. Claim only if they
                    are worth keeping.
                  </p>
                  <Button size="sm" onClick={() => setConfirming(lead.lead_id)}>
                    Claim this lead
                  </Button>
                </div>
              )}
              {outcome?.kind === "error" && (
                <p className="mt-2 text-sm text-amber-600">{outcome.message}</p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The explanation above the list.
 *
 * This is part of the mechanism, not decoration. Because contact details are
 * visible before claiming, nothing technically stops an operator working a pool
 * lead all the way to signature without ever claiming it. The only thing that
 * makes claiming rational is that somebody else can take it first — so the
 * scarcity line is load-bearing and is given its own block rather than being
 * folded into a paragraph.
 */
export function PoolExplainer({ className }: { className?: string }) {
  return (
    <div className={cn("space-y-4 rounded-lg border bg-muted/30 p-5", className)}>
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>
          These are landlords who enquired 25 or more days ago and were passed to
          operators who never followed them up. Rather than let them go to waste,
          they are open to any subscriber to call.
        </p>
        <p>
          Everything here is on top of your monthly allocation, and it costs you
          nothing to work through. Ring as many as you like, find out who is
          still looking, and claim only the ones worth keeping.
        </p>
      </div>
      <p className="border-l-2 border-brand pl-3 text-sm font-medium">
        First claim wins. This lead is removed from every other subscriber&apos;s
        pool the moment someone claims it.
      </p>
      <p className="text-sm text-muted-foreground">
        Claiming costs one lead from your allocation. If you have no credits left
        this cycle, you can still claim — next cycle&apos;s allocation is reduced
        by one instead.
      </p>
    </div>
  );
}
