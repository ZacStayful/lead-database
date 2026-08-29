/**
 * A customer's follow-up sequences (§40.13). List and create.
 *
 * SESSION-ONLY, like everything under /api/customer/messaging: these rows decide
 * what gets sent from the operator's own WhatsApp number, and an API key that
 * could reach them would schedule messages in their name.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentCustomer, isAdminUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { messagingActiveFor } from "@/lib/messaging/service";
import { validateSequenceInput } from "@/lib/messaging/sequenceInput";
import { sequenceSettings } from "@/lib/messaging/sequences";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const { user, customer } = await getCurrentCustomer();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const admin = createAdminClient();
  const [{ data }, settings] = await Promise.all([
    admin
      .from("message_sequences")
      .select(
        "id, name, lead_type, channel, trigger, is_active, created_at, " +
          "message_sequence_steps(step_number, delay_days, brief)"
      )
      .eq("customer_id", customer.id)
      .is("archived_at", null)
      .order("created_at", { ascending: false }),
    sequenceSettings(admin),
  ]);

  const sequences = (data ?? []) as unknown as {
    id: string;
    message_sequence_steps: { step_number: number }[];
  }[];

  // Live counts, in one query rather than one per sequence.
  const { data: runRows } = await admin
    .from("message_sequence_runs")
    .select("sequence_id, status")
    .eq("customer_id", customer.id);

  const counts = new Map<string, { active: number; completed: number; stopped: number }>();
  for (const r of (runRows ?? []) as { sequence_id: string; status: string }[]) {
    const bucket = counts.get(r.sequence_id) ?? { active: 0, completed: 0, stopped: 0 };
    if (r.status === "active") bucket.active += 1;
    else if (r.status === "completed") bucket.completed += 1;
    else bucket.stopped += 1;
    counts.set(r.sequence_id, bucket);
  }

  return NextResponse.json({
    // Reported rather than hidden. A sequence built while the platform switch is
    // off is saved and simply does not run — telling the operator that is the
    // difference between "not launched yet" and "broken".
    sequences_enabled: settings.enabled,
    sequences: sequences.map((s) => ({
      ...s,
      message_sequence_steps: [...(s.message_sequence_steps ?? [])].sort(
        (a, b) => a.step_number - b.step_number
      ),
      runs: counts.get(s.id) ?? { active: 0, completed: 0, stopped: 0 },
    })),
  });
}

export async function POST(request: NextRequest) {
  const { user, customer } = await getCurrentCustomer();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const admin = createAdminClient();
  if (!(await messagingActiveFor(admin, isAdminUser(user)))) {
    return NextResponse.json(
      { error: "Messaging is currently switched off.", code: "disabled" },
      { status: 503 }
    );
  }

  let body: {
    name?: unknown;
    steps?: unknown;
    lead_type?: unknown;
    trigger?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const verdict = validateSequenceInput(body);
  if (!verdict.ok) return NextResponse.json({ error: verdict.error }, { status: 400 });

  const leadType =
    body.lead_type === "guaranteed_rent" ? "guaranteed_rent" : "management";
  const trigger = body.trigger === "on_assignment" ? "on_assignment" : "manual";

  const { data: created, error } = await admin
    .from("message_sequences")
    .insert({
      customer_id: customer.id,
      name: verdict.name,
      lead_type: leadType,
      channel: "whatsapp",
      trigger,
      is_active: true,
    })
    .select("id")
    .maybeSingle();

  if (error || !created) {
    // 23505 is the partial unique index: at most one ACTIVE standing rule per
    // product, or a new lead is enrolled twice and messaged twice on day one.
    if ((error as { code?: string } | null)?.code === "23505") {
      return NextResponse.json(
        {
          error:
            "You already have an automatic sequence for new leads of this type. Archive that one first, or edit it instead.",
          code: "standing_rule_exists",
        },
        { status: 409 }
      );
    }
    console.error("[sequences] create failed", error);
    return NextResponse.json({ error: "Could not save the sequence." }, { status: 500 });
  }

  const sequenceId = (created as { id: string }).id;
  const { error: stepErr } = await admin.from("message_sequence_steps").insert(
    verdict.steps.map((s, i) => ({
      sequence_id: sequenceId,
      step_number: i + 1,
      delay_days: s.delay_days,
      brief: s.brief,
    }))
  );

  if (stepErr) {
    // A sequence with no steps enrols nothing and sends nothing, so the tidy-up
    // is worth doing rather than leaving a shell that looks usable.
    console.error("[sequences] step insert failed", stepErr);
    await admin.from("message_sequences").delete().eq("id", sequenceId);
    return NextResponse.json({ error: "Could not save the sequence." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, id: sequenceId });
}
