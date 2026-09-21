import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { User } from "@supabase/supabase-js";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Customer } from "@/lib/types";
import { adsEnabledFor } from "./gate";
import type { AdCopy } from "./metaFields";
import type { Question } from "./schemas";
import type { SlotValues } from "./resolveSlots";
import type { AdProfile } from "./resolveSlots";

/**
 * Everything the ad routes share (§65): who is asking, which draft, and the
 * two writes that must not be read-modify-write.
 *
 * ⚠️ NO ROUTE MAY RE-IMPLEMENT ANY OF THIS. The gate would otherwise sit at a
 * dozen call sites, and the day a second customer is let in that is a dozen
 * edits with any miss producing a 404 on a feature just enabled.
 */

export const AD_NO_STORE = { "Cache-Control": "no-store, private" } as const;

export function adJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: AD_NO_STORE });
}

// ---------------------------------------------------------------------------
// Who is asking
// ---------------------------------------------------------------------------

export type AdSession = { user: User; customer: Customer; admin: SupabaseClient };

/**
 * ⚠️ THREE OUTCOMES, NOT TWO, and collapsing them is how an expired session
 * comes to look like a foreign draft. `customer` is null in three different
 * situations — no session at all, a session with no customer row, and a
 * view-as cookie pointing at a deleted id — and only the first should send
 * anybody to `/login`.
 *
 * The 403 and the 404 are deliberately the SAME response. A gate that answered
 * "you may not" would confirm the surface exists to anybody who guessed the
 * URL; §27.1's containment rule, applied to a demo surface.
 */
export async function adSession(): Promise<
  { ok: true; session: AdSession } | { ok: false; response: NextResponse }
> {
  const { user, customer } = await getCurrentCustomer();
  if (!user) return { ok: false, response: adJson({ error: "Unauthorized" }, 401) };
  if (!customer || !adsEnabledFor(user, customer)) {
    return { ok: false, response: adJson({ error: "Not found" }, 404) };
  }
  return { ok: true, session: { user, customer, admin: createAdminClient() } };
}

/**
 * The same gate, resolving the customer by `user_id` rather than through the
 * view-as cookie.
 *
 * ⚠️ TWO FUNCTIONS RATHER THAN A FLAG ON ONE, because a flag is a thing a
 * route can forget and a forgotten flag here is silent. A guard asserts that
 * every route exporting POST, PUT or DELETE uses this one.
 *
 * §62's middleware already answers 403 to any ads write while that cookie is
 * set, so this is defence in depth rather than the control — but the brand
 * route states the rule plainly and the reason holds: an inline lookup can
 * only ever write the caller's OWN row, whatever a cookie says.
 */
export async function adWriteSession(): Promise<
  { ok: true; session: AdSession } | { ok: false; response: NextResponse }
> {
  const { user } = await getCurrentCustomer();
  if (!user) return { ok: false, response: adJson({ error: "Unauthorized" }, 401) };

  const admin = createAdminClient();
  const { data } = await admin
    .from("customers")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();
  const customer = (data ?? null) as Customer | null;

  if (!customer || !adsEnabledFor(user, customer)) {
    return { ok: false, response: adJson({ error: "Not found" }, 404) };
  }
  return { ok: true, session: { user, customer, admin } };
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

export type AdDraftStatus = "collecting" | "generating" | "ready" | "failed";

export type AdDraftRow = {
  id: string;
  customer_id: string;
  prompt: string;
  template_id: string | null;
  template_reason: string | null;
  status: AdDraftStatus;
  questions: Question[];
  questions_version: number;
  copy: AdCopy | null;
  slots: SlotValues | null;
  model_id: string | null;
  prompt_version: string | null;
  error: string | null;
  template_switches: number;
  regenerations: number;
  renders: number;
  created_at: string;
  updated_at: string;
};

const DRAFT_COLUMNS =
  "id, customer_id, prompt, template_id, template_reason, status, questions, " +
  "questions_version, copy, slots, model_id, prompt_version, error, " +
  "template_switches, regenerations, renders, created_at, updated_at";

/**
 * ⚠️ ALWAYS SCOPED BY CUSTOMER, AND A MISS IS ALWAYS THE SAME 404. "No such
 * draft" and "not yours" must be indistinguishable, or the id space is
 * enumerable — the rule §25's report endpoint already states for the same
 * reason.
 */
export async function loadDraft(
  admin: SupabaseClient,
  customerId: string,
  draftId: string
): Promise<AdDraftRow | null> {
  if (!isUuid(draftId)) return null;
  const { data, error } = await admin
    .from("ad_drafts")
    .select(DRAFT_COLUMNS)
    .eq("id", draftId)
    .eq("customer_id", customerId)
    .maybeSingle();
  if (error || !data) return null;
  return data as unknown as AdDraftRow;
}

export async function listDrafts(
  admin: SupabaseClient,
  customerId: string,
  limit = 20
): Promise<AdDraftRow[]> {
  const { data, error } = await admin
    .from("ad_drafts")
    .select(DRAFT_COLUMNS)
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  return data as unknown as AdDraftRow[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

// ---------------------------------------------------------------------------
// The claim
// ---------------------------------------------------------------------------

/**
 * ⚠️ HOW LONG A GENERATION MAY BE IN FLIGHT BEFORE IT IS PRESUMED DEAD.
 *
 * The copy budget is 60 + 45 seconds inside a 300-second ceiling, so anything
 * past six minutes is a lambda that was killed. Without this window a draft
 * killed mid-generation is stuck in `generating` FOREVER, and the operator's
 * only recourse is Delete — which destroys the answers they just spent five
 * minutes giving. The plan for this feature did not have it; a dead draft
 * found it.
 */
export const GENERATION_STALE_MS = 6 * 60 * 1000;

/**
 * Take the draft for generation, or find out somebody else has it.
 *
 * ⚠️ ONE CONDITIONAL UPDATE, NEVER A READ THEN A WRITE. A double-tapped Send
 * puts two requests in flight; both pass a TypeScript `if`, and neither passes
 * a WHERE clause. §50's route states the same rule, and the cost of getting it
 * wrong here is two paid generations and two different adverts racing to be
 * the one stored.
 */
export async function claimForGeneration(
  admin: SupabaseClient,
  customerId: string,
  draftId: string
): Promise<{ ok: true; draft: AdDraftRow } | { ok: false; reason: "busy" | "gone" }> {
  if (!isUuid(draftId)) return { ok: false, reason: "gone" };

  // ⚠️ AN RPC, NOT A POSTGREST FILTER. The equivalent is
  // `.or("status.neq.generating,updated_at.lt.<iso>")`, which rests on how
  // PostgREST parses the dots inside an ISO timestamp — easy to reason about
  // wrongly, and impossible to test without PostgREST running. In SQL it is
  // ordinary, and supabase/tests/ci.sh proves it.
  const { data, error } = await admin.rpc("claim_ad_draft", {
    p_draft_id: draftId,
    p_customer_id: customerId,
    p_stale_seconds: Math.round(GENERATION_STALE_MS / 1000),
  });

  const rows = Array.isArray(data) ? data : [];
  if (error || rows.length === 0) {
    if (error) console.error("ads/session: claim_ad_draft failed", error.message);
    // Zero rows is the ordinary losing case, not a fault — but "somebody else
    // has it" and "there is no such draft" want different messages, so the
    // caller asks separately rather than guessing.
    const existing = await loadDraft(admin, customerId, draftId);
    return { ok: false, reason: existing ? "busy" : "gone" };
  }
  return { ok: true, draft: rows[0] as AdDraftRow };
}

/** The finished advert. `status = 'ready'` requires copy AND slots (0156). */
export async function finishDraft(
  admin: SupabaseClient,
  draftId: string,
  patch: { copy: AdCopy; slots: SlotValues; modelId: string | null; promptVersion: string | null }
): Promise<boolean> {
  const { error } = await admin
    .from("ad_drafts")
    .update({
      status: "ready",
      copy: patch.copy,
      slots: patch.slots,
      model_id: patch.modelId,
      prompt_version: patch.promptVersion,
      error: null,
    })
    .eq("id", draftId);
  return !error;
}

/**
 * ⚠️ `error` IS A BOUNDED CODE, NEVER A PROVIDER MESSAGE AND NEVER A PROMPT.
 * 0156's comment on the column says so, and this is the only writer of it.
 */
export async function failDraft(
  admin: SupabaseClient,
  draftId: string,
  code: string
): Promise<void> {
  await admin
    .from("ad_drafts")
    .update({ status: "failed", error: code.slice(0, 200) })
    .eq("id", draftId);
}

/** Put a draft back where it was when a generation could not even start. */
export async function releaseClaim(
  admin: SupabaseClient,
  draftId: string,
  to: AdDraftStatus
): Promise<void> {
  await admin.from("ad_drafts").update({ status: to }).eq("id", draftId);
}

// ---------------------------------------------------------------------------
// The budgets
// ---------------------------------------------------------------------------

export type AdBudget = "template" | "regenerate" | "render";

/**
 * ⚠️ AN RPC BECAUSE POSTGREST CANNOT DO `set x = x + 1`. The alternative is a
 * read, an add and a write, which two tabs both pass. Null means no — either
 * the cap is spent or the draft is not theirs, and the route cannot tell,
 * which is the point.
 */
export async function spendBudget(
  admin: SupabaseClient,
  customerId: string,
  draftId: string,
  kind: AdBudget
): Promise<number | null> {
  const { data, error } = await admin.rpc("spend_ad_budget", {
    p_draft_id: draftId,
    p_customer_id: customerId,
    p_kind: kind,
  });
  if (error) {
    console.error("ads/session: spend_ad_budget failed", error.message);
    // ⚠️ FAILS CLOSED. An unreadable budget is not permission to spend one.
    return null;
  }
  return typeof data === "number" ? data : null;
}

/**
 * ⚠️ MERGED IN SQL, NEVER READ-MODIFY-WRITE. Two writers exist — the answers
 * route and the profile form — and the edit most likely to be lost in a tab
 * race is the FEE, which decides whether a price appears on a live advert.
 */
/**
 * ⚠️ RETURNS THE MERGED PROFILE, WHICH THE RPC WAS ALREADY PRODUCING AND WE
 * WERE THROWING AWAY. The caller needs the post-merge state to decide whether
 * anything is still missing, and re-reading the customer to learn what we just
 * wrote is both a wasted round trip and a second source of truth.
 *
 * `{ ok: true, profile: null }` means there was nothing to merge, so the
 * caller's own copy is already current.
 */
export async function mergeAdProfile(
  admin: SupabaseClient,
  customerId: string,
  patch: Partial<AdProfile>
): Promise<{ ok: boolean; profile: AdProfile | null }> {
  if (!patch || Object.keys(patch).length === 0) return { ok: true, profile: null };
  const { data, error } = await admin.rpc("merge_ad_profile", {
    p_customer_id: customerId,
    p_patch: patch,
  });
  if (error) {
    console.error("ads/session: merge_ad_profile failed", error.message);
    return { ok: false, profile: null };
  }
  // null comes back when no such customer, which the RPC signals by returning
  // nothing rather than raising.
  return { ok: data !== null, profile: (data ?? null) as AdProfile | null };
}

// ---------------------------------------------------------------------------
// The questions array
// ---------------------------------------------------------------------------

/**
 * Replace the question ladder, but only if nobody else has.
 *
 * ⚠️ A COMPARE-AND-SWAP ON `questions_version`. Two tabs simplifying different
 * questions would otherwise each write a whole array built from what they read
 * — so the later write silently discards the other's rewording AND its spent
 * budget, and the simplify budget is derived from the array.
 */
export async function replaceQuestions(
  admin: SupabaseClient,
  draftId: string,
  version: number,
  questions: Question[]
): Promise<boolean> {
  const { data, error } = await admin
    .from("ad_drafts")
    .update({ questions, questions_version: version + 1 })
    .eq("id", draftId)
    .eq("questions_version", version)
    .select("id")
    .maybeSingle();
  return !error && Boolean(data);
}
