/**
 * Follow-up sequences (§40.13).
 *
 * Two halves on one page because they are two halves of one loop: the ladders
 * the operator has built, and the messages those ladders are about to send. A
 * queue on a separate screen would be a queue nobody visits, and the whole
 * "drafted ahead, auto-sends unless cancelled" bargain rests on it being seen.
 */
import { redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Info } from "lucide-react";
import { getCurrentCustomer, isAdminUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { holdsProduct } from "@/lib/products";
import { viewerScopedLead } from "@/lib/customerLeads";
import {
  getWhatsappConnection,
  messagingActiveFor,
} from "@/lib/messaging/service";
import { sequenceSettings } from "@/lib/messaging/sequences";
import { SequencePanel } from "@/components/dashboard/SequencePanel";
import {
  SequenceReviewQueue,
  type QueuedDraft,
} from "@/components/dashboard/SequenceReviewQueue";
import type { SequenceView } from "@/components/dashboard/SequenceBuilder";

export const dynamic = "force-dynamic";

export default async function FollowUpsPage() {
  const { user, customer } = await getCurrentCustomer();
  if (!user) redirect("/login");
  if (!customer) redirect("/dashboard");

  const admin = createAdminClient();

  // The same gate the messaging settings page uses: hidden from ordinary
  // customers until the switch is flipped, reachable by admins throughout,
  // which is what makes a production rehearsal possible (§40.3).
  if (!(await messagingActiveFor(admin, isAdminUser(user)))) {
    redirect("/dashboard");
  }

  const [connection, settings, seqRes, draftRes, runRows] = await Promise.all([
    getWhatsappConnection(admin, customer.id),
    sequenceSettings(admin),
    admin
      .from("message_sequences")
      .select(
        "id, name, lead_type, channel, trigger, is_active, created_at, " +
          "message_sequence_steps(step_number, delay_days, brief)"
      )
      .eq("customer_id", customer.id)
      .is("archived_at", null)
      .order("created_at", { ascending: false }),
    admin
      .from("message_sequence_drafts")
      .select(
        "id, run_id, step_number, body, send_after, edited_at, " +
          "message_sequence_runs!inner(id, assignment_id, sequence_id, " +
          "message_sequences(name), lead:leads(id, lead_name, address, owner_customer_id, lead_profile))"
      )
      .eq("customer_id", customer.id)
      .eq("state", "pending")
      .order("send_after", { ascending: true })
      .limit(200),
    admin
      .from("message_sequence_runs")
      .select("sequence_id, status")
      .eq("customer_id", customer.id),
  ]);

  const counts = new Map<string, { active: number; completed: number; stopped: number }>();
  for (const r of (runRows.data ?? []) as { sequence_id: string; status: string }[]) {
    const bucket = counts.get(r.sequence_id) ?? { active: 0, completed: 0, stopped: 0 };
    if (r.status === "active") bucket.active += 1;
    else if (r.status === "completed") bucket.completed += 1;
    else bucket.stopped += 1;
    counts.set(r.sequence_id, bucket);
  }

  const sequences: SequenceView[] = (
    (seqRes.data ?? []) as unknown as (SequenceView & { id: string })[]
  ).map((s) => ({
    ...s,
    message_sequence_steps: [...(s.message_sequence_steps ?? [])].sort(
      (a, b) => a.step_number - b.step_number
    ),
    runs: counts.get(s.id) ?? { active: 0, completed: 0, stopped: 0 },
  }));

  const drafts: QueuedDraft[] = (
    (draftRes.data ?? []) as unknown as {
      id: string;
      run_id: string;
      step_number: number;
      body: string;
      send_after: string;
      edited_at: string | null;
      message_sequence_runs: {
        assignment_id: string;
        message_sequences: { name: string } | null;
        lead: Record<string, unknown> | null;
      } | null;
    }[]
  ).map((r) => {
    // Scoped even here: on a resold imported lead, lead_profile is the
    // UPLOADING operator's private working notes (§32.8).
    const lead = viewerScopedLead(
      r.message_sequence_runs?.lead as never,
      customer.id
    ) as unknown as { lead_name?: string; address?: string } | null;
    return {
      id: r.id,
      run_id: r.run_id,
      assignment_id: r.message_sequence_runs?.assignment_id ?? null,
      sequence_name: r.message_sequence_runs?.message_sequences?.name ?? null,
      step_number: r.step_number,
      body: r.body,
      send_after: r.send_after,
      edited: Boolean(r.edited_at),
      lead_name: lead?.lead_name ?? null,
      address: lead?.address ?? null,
    };
  });

  const hasBothProducts =
    holdsProduct(customer, "management") && holdsProduct(customer, "guaranteed_rent");

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
      <div>
        <Link
          href="/dashboard/leads"
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="mr-1 h-4 w-4" />
          Leads
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">Follow-ups</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Chase a landlord more than once, without writing the same message forty
          times. Each one is written for that specific property.
        </p>
      </div>

      {connection?.status !== "connected" && (
        <div className="flex items-start gap-3 rounded-lg border-[0.5px] border-border bg-muted/50 px-4 py-3 text-sm">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <p>
            Follow-ups go out over WhatsApp, so you will need to{" "}
            <Link href="/dashboard/settings/messaging" className="underline">
              connect your number
            </Link>{" "}
            before anything can send. You can build a sequence now either way.
          </p>
        </div>
      )}

      {!settings.enabled && (
        <div className="flex items-start gap-3 rounded-lg border-[0.5px] border-border bg-muted/50 px-4 py-3 text-sm">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <p>
            Automatic follow-ups are not switched on yet. Sequences you build are
            saved, and leads you add to them will be picked up as soon as it is —
            nothing will be sent in the meantime.
          </p>
        </div>
      )}

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Waiting to go out</h2>
        <SequenceReviewQueue drafts={drafts} />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Your sequences</h2>
        <SequencePanel sequences={sequences} hasBothProducts={hasBothProducts} />
      </section>
    </div>
  );
}
