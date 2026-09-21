import type { NextRequest } from "next/server";
import { adContext } from "@/lib/ads/context";
import { fallbackQuestionnaire, fallbackTemplate } from "@/lib/ads/fallback";
import { generateQuestions } from "@/lib/ads/generate";
import { draftCapReached, draftsStartedToday, recordGenerations } from "@/lib/ads/ledger";
import { AD_COPY, AD_STARTER_PROMPT } from "@/lib/ads/copy";
import { adJson, adSession, adWriteSession, listDrafts } from "@/lib/ads/session";
import { DEFAULT_TEMPLATE_ID, templateById } from "@/lib/ads/templates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The ad builder's front door (§65).
 *
 * GET lists what they have made. POST is the Send button: it picks a template,
 * asks for what is missing, and stores a draft in `collecting`.
 */
export async function GET() {
  const gate = await adSession();
  if (!gate.ok) return gate.response;
  const { admin, customer } = gate.session;
  return adJson({ drafts: await listDrafts(admin, customer.id) });
}

export async function POST(request: NextRequest) {
  const gate = await adWriteSession();
  if (!gate.ok) return gate.response;
  const { admin, customer } = gate.session;

  let body: { prompt?: unknown };
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  // ⚠️ STORED AS WHAT THEY SENT. An operator who rewrites the starter prompt
  // is answered on their own terms, and we can see later what people ask for.
  const prompt =
    typeof body.prompt === "string" && body.prompt.trim()
      ? body.prompt.trim().slice(0, 2000)
      : AD_STARTER_PROMPT;

  // ⚠️ COUNTED FROM THE APPEND-ONLY LEDGER, NEVER FROM ad_drafts. A customer
  // may delete a draft, so a cap counted on a deletable table resets itself.
  const started = await draftsStartedToday(admin, customer.id);
  // ⚠️ AND IT FAILS CLOSED. An unreadable ledger is not permission.
  if (!started.ok) return adJson({ error: AD_COPY.errors.generic }, 503);
  if (draftCapReached(started.count)) {
    return adJson({ error: AD_COPY.errors.budget, code: "draft_cap" }, 429);
  }

  // The fallback needs a template to ask about, and the model has not picked
  // one yet — so the questionnaire underneath is built against the default.
  const provisional = templateById(DEFAULT_TEMPLATE_ID)!;
  const set = await generateQuestions({
    prompt,
    account: adContext(customer, provisional).brief,
    fallback: () => fallbackQuestionnaire(provisional, adContext(customer, provisional).resolution),
  });

  if (!set) {
    // Nothing missing AND no model: there is no questionnaire to render, and
    // an empty form with a Send button is worse than saying so.
    return adJson({ error: AD_COPY.errors.generic }, 502);
  }

  // ⚠️ THE QUESTIONS WERE BUILT AGAINST THE PROVISIONAL TEMPLATE, so once the
  // model has chosen a different one the fallback list has to be rebuilt —
  // otherwise a degraded T8 draft asks T7's questions and the operator is
  // never asked for the numbers T8 puts on the image.
  const questions =
    set.degraded && set.template.id !== provisional.id
      ? fallbackQuestionnaire(set.template, adContext(customer, set.template).resolution)
      : set.questions;

  // ⚠️ THE DEGRADATION IS STORED, NOT RETURNED. `set.degraded` was handed back
  // in the JSON and read by nobody — and it could not have been, because the
  // chat navigates to the draft page and re-renders from the row. Folding it
  // into `template_reason`, which is already stored and already rendered, is
  // what makes it survive; see AD_COPY.chat.standardQuestions.
  const reason = [set.reason || fallbackTemplate().reason]
    .concat(set.degraded ? [AD_COPY.chat.standardQuestions] : [])
    .join(" ");

  const { data, error } = await admin
    .from("ad_drafts")
    .insert({
      customer_id: customer.id,
      prompt,
      template_id: set.template.id,
      template_reason: reason,
      status: "collecting",
      questions,
    })
    .select("id")
    .maybeSingle();

  if (error || !data) {
    console.error("ads: could not create draft", error?.message);
    return adJson({ error: AD_COPY.errors.generic }, 500);
  }

  const draftId = (data as { id: string }).id;
  await recordGenerations(admin, {
    customerId: customer.id,
    draftId,
    entries: set.entries,
  });

  return adJson(
    {
      id: draftId,
      template_id: set.template.id,
      template_reason: reason,
      questions,
    },
    201
  );
}
