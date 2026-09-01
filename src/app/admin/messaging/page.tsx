/**
 * /admin/messaging — the switches, and the reading beside them.
 *
 * ⚠️ THIS PAGE EXISTS BECAUSE THE SWITCHES DID NOT HAVE ONE. Every messaging
 * setting shipped with its feature and none of them had a control:
 * `messaging_sequences_enabled` ships `false`, so the only way to turn
 * follow-up sequences on was to run SQL against production. A kill switch
 * nobody can reach is not a kill switch.
 *
 * The live position is shown BESIDE the switches rather than on a separate
 * screen, because a switch with no reading next to it is a switch nobody dares
 * press — the argument §18.1 makes about capacity and §21 about paused
 * customers: always the number, never just the control.
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createAdminClient } from "@/lib/supabase/admin";
import { MESSAGING_SETTINGS } from "@/lib/messaging/adminSettings";
import { MessagingSettingsPanel } from "@/components/admin/MessagingSettingsPanel";
import { LandlordReferralPanel } from "@/components/admin/LandlordReferralPanel";
import { getUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border-[0.5px] border-border p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold">{value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export default async function AdminMessagingPage() {
  const admin = createAdminClient();
  // Prefills the test-send box, the way the announcement panel does.
  const user = await getUser();

  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [
    settingRows,
    connections,
    sequences,
    activeRuns,
    pendingDrafts,
    sentToday,
    inboundToday,
    failedToday,
    referralSetting,
    referralsSentToday,
    referralsQueued,
    referralsFailedToday,
    landlordsAnswered,
    nudgesSentToday,
    nudgesAwaiting,
    landlordsPartial,
  ] = await Promise.all([
    admin
      .from("system_settings")
      .select("key, value")
      .in("key", MESSAGING_SETTINGS.map((s) => s.key)),
    admin
      .from("customer_whatsapp_connections")
      .select("id", { count: "exact", head: true })
      .eq("status", "connected"),
    admin
      .from("message_sequences")
      .select("id", { count: "exact", head: true })
      .is("archived_at", null)
      .eq("is_active", true),
    admin
      .from("message_sequence_runs")
      .select("id", { count: "exact", head: true })
      .eq("status", "active"),
    admin
      .from("message_sequence_drafts")
      .select("id", { count: "exact", head: true })
      .eq("state", "pending"),
    admin
      .from("lead_messages")
      .select("id", { count: "exact", head: true })
      .eq("direction", "outbound")
      .neq("status", "failed")
      .gte("created_at", dayAgo),
    admin
      .from("lead_messages")
      .select("id", { count: "exact", head: true })
      .eq("direction", "inbound")
      .gte("created_at", dayAgo),
    admin
      .from("lead_messages")
      .select("id", { count: "exact", head: true })
      .eq("status", "failed")
      .gte("created_at", dayAgo),
    // §41. Its own key, read separately from MESSAGING_SETTINGS — it is not a
    // messaging setting and does not belong in that allow-list.
    admin
      .from("system_settings")
      .select("value")
      .eq("key", "landlord_referral_enabled")
      .maybeSingle(),
    admin
      .from("lead_assignments")
      .select("id", { count: "exact", head: true })
      .gte("landlord_referral_sent_at", dayAgo),
    // Claimed, never delivered, and waiting on the retry sweep.
    admin
      .from("lead_assignments")
      .select("id", { count: "exact", head: true })
      .not("landlord_referral_claimed_at", "is", null)
      .is("landlord_referral_sent_at", null)
      .not("landlord_referral_next_attempt_at", "is", null),
    admin
      .from("lead_assignments")
      .select("id", { count: "exact", head: true })
      .is("landlord_referral_sent_at", null)
      .not("landlord_referral_error", "is", null),
    admin
      .from("leads")
      .select("id", { count: "exact", head: true })
      .not("landlord_prefs_submitted_at", "is", null),
    // §41.1. Reminders sent in the last day.
    admin
      .from("leads")
      .select("id", { count: "exact", head: true })
      .gte("landlord_prefs_nudge_sent_at", dayAgo),
    // Introduced, still under the cap, and the spine is unfinished. A ceiling
    // on what the sweep could reach rather than what is due right now — the
    // due test spans sibling assignments and lives in get_due_landlord_nudges.
    admin
      .from("leads")
      .select("id", { count: "exact", head: true })
      .not("landlord_referral_first_sent_at", "is", null)
      .lt("landlord_prefs_nudge_count", 2)
      .is("landlord_contact_method", null),
    // ⚠️ Started and stopped. Read off the SPINE, never off
    // `landlord_prefs_submitted_at`, which any single answer stamps — so the
    // "answered" figure above and this one would otherwise double-count the
    // same person and neither would mean what its label says.
    admin
      .from("leads")
      .select("id", { count: "exact", head: true })
      .not("landlord_contact_method", "is", null)
      .is("landlord_wants", null),
  ]);

  const stored = new Map(
    (settingRows.data ?? []).map((r) => [
      (r as { key: string }).key,
      (r as { value: string }).value,
    ])
  );
  const values = Object.fromEntries(
    MESSAGING_SETTINGS.map((s) => [s.key, stored.get(s.key) ?? s.fallback])
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Messaging</h1>
        <p className="text-sm text-muted-foreground">
          WhatsApp to landlords, sent from each operator&apos;s own connected
          number. Every switch here affects every customer at once.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Connected numbers" value={String(connections.count ?? 0)} />
        <Stat label="Active sequences" value={String(sequences.count ?? 0)} />
        <Stat
          label="Leads mid-sequence"
          value={String(activeRuns.count ?? 0)}
          hint={`${pendingDrafts.count ?? 0} message${(pendingDrafts.count ?? 0) === 1 ? "" : "s"} waiting in review`}
        />
        <Stat
          label="Sent in 24h"
          value={String(sentToday.count ?? 0)}
          hint={`${inboundToday.count ?? 0} replies in · ${failedToday.count ?? 0} failed`}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Switches</CardTitle>
        </CardHeader>
        <CardContent>
          <MessagingSettingsPanel
            initial={values}
            activeRuns={activeRuns.count ?? 0}
            pendingDrafts={pendingDrafts.count ?? 0}
          />
        </CardContent>
      </Card>

      {/*
        §41, and its OWN card rather than a fourth switch in the block above.
        That page is about operators messaging landlords; this is Stayful
        emailing them, at the moment a lead is allocated. Sitting it as a peer
        of the WhatsApp switches would read as the same feature.
      */}
      <Card>
        <CardHeader>
          <CardTitle>Landlord referrals</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* A switch with no reading beside it is one nobody dares press. */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Sent in 24h" value={String(referralsSentToday.count ?? 0)} />
            <Stat
              label="Waiting on retry"
              value={String(referralsQueued.count ?? 0)}
              hint="claimed, not yet delivered"
            />
            <Stat label="Failed" value={String(referralsFailedToday.count ?? 0)} />
            <Stat
              label="Landlords answered"
              value={String(landlordsAnswered.count ?? 0)}
              hint="told us how to reach them"
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label="Reminders in 24h" value={String(nudgesSentToday.count ?? 0)} />
            <Stat
              label="Still to chase"
              value={String(nudgesAwaiting.count ?? 0)}
              hint="introduced, never answered, under the cap"
            />
            <Stat
              label="Started and stopped"
              value={String(landlordsPartial.count ?? 0)}
              hint="answered some, not all"
            />
          </div>

          <LandlordReferralPanel
            enabled={
              (referralSetting.data as { value?: string } | null)?.value === "true"
            }
            adminEmail={user?.email ?? null}
          />
        </CardContent>
      </Card>
    </div>
  );
}
