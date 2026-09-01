/**
 * The reminder we send a landlord who never finished answering (§41.1) — the
 * pure half.
 *
 * §41 introduces the operator once, at allocation, and the first introduction
 * carries three questions behind a link. Two ways a landlord fails to answer:
 * they never open it, or they answer card 1 and close the tab. Neither was
 * chased, and since §42 the cost is concrete — `firstAttemptChannel()` uses
 * `landlord_contact_method` to pick attempt 1 of the contact plan, and its
 * absence "leaves the default cold call in place".
 *
 * ⚠️ THIS IS NOT A SECOND INTRODUCTION. The landlord has already met this
 * operator by email; re-introducing them reads as an automated blast, which is
 * the one thing a Stayful email to a member of the public must not look like.
 * It names the operator, says what is outstanding, and asks once.
 *
 * WHY THE RENDERER LIVES HERE: the same reason landlordReferral.ts gives.
 * vitest is `environment: node` with pure units only, so a renderer that
 * reaches Resend cannot be tested — and the test that matters is that an
 * operator's own typed words cannot escape into the HTML of an email to the
 * public. `esc` is imported from @/lib/emails, the one-way direction
 * messaging/outbound.ts:10 already uses.
 */
import { esc } from "@/lib/emails";
import { buildIncomeProjection } from "@/lib/incomeProjection";
import {
  landlordFirstName,
  operatorLabel,
  type ReferralLead,
  type ReferralOperator,
} from "@/lib/landlordReferral";
import { CONTACT_METHOD_LABELS, type ContactMethod } from "@/lib/landlordQuestions";

/** The lead columns the reminder reads. Narrow on purpose, as §41's is. */
export interface NudgeLead extends ReferralLead {
  landlord_contact_method?: string | null;
  landlord_contact_time?: string | null;
  landlord_wants?: string[] | null;
  landlord_prefs_step?: number | null;
}

/**
 * Has this landlord given us anything at all?
 *
 * ⚠️ READ FROM THE SPINE COLUMNS, NEVER FROM `landlord_prefs_submitted_at`.
 * That column is stamped by ANY single answer, so it cannot tell "answered
 * everything" from "answered one card and left" — which is exactly the
 * distinction the two wordings below turn on. `get_due_landlord_nudges` tests
 * the same three columns, so the sweep and the copy cannot disagree about who
 * is being chased.
 */
export function nudgeStage(lead: NudgeLead): "silent" | "partial" {
  const given =
    Boolean(lead.landlord_contact_method) ||
    Boolean(lead.landlord_contact_time) ||
    Boolean(lead.landlord_wants?.length);
  return given ? "partial" : "silent";
}

/** What we already have, in the landlord's own terms, for the partial wording. */
export function alreadyAnswered(lead: NudgeLead): string[] {
  const out: string[] = [];
  const m = lead.landlord_contact_method as ContactMethod | null | undefined;
  if (m && CONTACT_METHOD_LABELS[m]) out.push(CONTACT_METHOD_LABELS[m]);
  if (lead.landlord_contact_time) out.push(lead.landlord_contact_time);
  return out;
}

export interface NudgeCopy {
  subject: string;
  greeting: string;
  intro: string[];
  /** Who is waiting, as the landlord met them. Never more than this. */
  operatorLine: string | null;
  headline: string | null;
  cta: { label: string; note: string };
  stage: "silent" | "partial";
  attempt: 1 | 2;
}

/**
 * The words.
 *
 * ⚠️ EVERY RULE landlordDeck.ts SETS APPLIES HERE UNCHANGED. No fee and no
 * percentage of any kind — the report's fee is Stayful's and the operator's is
 * different and unknown, so either is a price claim we cannot stand behind. No
 * `net_annual_income`, which is net of our 15% and rendered nowhere by design
 * (§26.1). The gross only, worded as an estimate, and management only.
 *
 * ⚠️ NOTHING ABOUT ANY OTHER OPERATOR — not that others hold the lead, not how
 * many. §19.7 removed previous-holder information from the pool row set
 * entirely "so no later UI change can reach for it", and the rule is sharper
 * here because the reader is the landlord.
 *
 * ⚠️ COPY BRANCHES ON lead_type (invariant 6) and the figure is management-only,
 * matching IncomeProjection and §25's writers: a guaranteed-rent operator pays
 * a fixed rent rather than managing for a fee, so a short-let gross projection
 * is the wrong number for that conversation rather than a missing one.
 */
export function buildNudgeCopy(params: {
  lead: NudgeLead;
  operator: ReferralOperator;
  attempt: 1 | 2;
}): NudgeCopy {
  const { lead, operator, attempt } = params;
  const stage = nudgeStage(lead);
  const isGr = lead.lead_type === "guaranteed_rent";
  const who = operatorLabel(operator);
  const first = landlordFirstName(lead.lead_name);
  const property = lead.address?.trim();

  // The figure earns the click on the first reminder only. A second one is a
  // short last word, and repeating the pitch there is what makes a sequence
  // read as a sequence.
  const projection =
    attempt === 1 && !isGr
      ? buildIncomeProjection({
          gross_annual_income: lead.gross_annual_income ?? null,
        } as Parameters<typeof buildIncomeProjection>[0])
      : null;

  const have = alreadyAnswered(lead);

  const intro: string[] = [];
  if (stage === "partial") {
    intro.push(
      have.length
        ? `You started telling us how ${who} should get in touch — we have ${have.join(
            ", "
          )} noted — but there are a couple of questions left.`
        : `You started telling us how ${who} should get in touch, but there are a couple of questions left.`
    );
  } else {
    intro.push(
      property
        ? `A little while ago we introduced you to ${who} about ${property}.`
        : `A little while ago we introduced you to ${who} about your enquiry.`
    );
    intro.push(
      `We asked how you would like them to get in touch, and we have not heard back — so they do not yet know whether to call, email or message you, or when suits.`
    );
  }

  if (attempt === 2) {
    // The last word, and it says so. A reminder that does not signal it is the
    // final one invites the reader to assume there will be more.
    intro.push(
      `This is the last we will send about it. If you would rather we left it, just ignore this and we will.`
    );
  } else {
    intro.push(
      isGr
        ? `It takes about a minute, and it means ${who} reaches you the way you prefer.`
        : `It takes about a minute, and it means ${who} reaches you at a time that suits.`
    );
  }

  return {
    stage,
    attempt,
    subject:
      stage === "partial"
        ? `One more minute — ${who} is waiting to hear from you`
        : `${who} still needs to know how to reach you`,
    greeting: first ? `Hi ${first},` : `Hello,`,
    intro,
    operatorLine: operator.contact_name?.trim()
      ? `${operator.contact_name.trim()}${
          operator.business_name?.trim() ? ` at ${operator.business_name.trim()}` : ""
        }`
      : operator.business_name?.trim() || null,
    headline: projection
      ? `Your property still models at £${projection.grossAnnualLow.toLocaleString(
          "en-GB"
        )}–£${projection.grossAnnualHigh.toLocaleString(
          "en-GB"
        )} a year gross as a short let. It's an estimate, not a promise.`
      : null,
    cta:
      stage === "partial"
        ? {
            label: "Finish the last questions",
            note: "It picks up where you left off — nothing you have already answered is asked again.",
          }
        : projection
        ? {
            label: "See how that figure is built",
            note: "Three quick questions on the way through, so they contact you the way you prefer.",
          }
        : {
            label: "Tell them how to reach you",
            note: "Three quick questions, and nothing else is asked of you.",
          },
  };
}

/**
 * The HTML body. Everything an operator typed goes through esc().
 *
 * ⚠️ The `operator_intro` is deliberately NOT repeated here. The landlord read
 * it in the introduction; a reminder is short by design, and the longer this
 * gets the more it reads as marketing rather than a question.
 */
export function renderNudgeBody(copy: NudgeCopy): string {
  const paras = copy.intro
    .map((p) => `<p style="margin:0 0 12px;font-size:14px;line-height:1.6">${esc(p)}</p>`)
    .join("");

  const headlineBlock = copy.headline
    ? `<div style="margin:0 0 16px;padding:14px;background:#eef4ec;border-radius:8px">
         <p style="margin:0;font-size:14px;line-height:1.6">${esc(copy.headline)}</p>
       </div>`
    : "";

  const whoBlock = copy.operatorLine
    ? `<p style="margin:0 0 12px;color:#6b706a;font-size:13px">Waiting to hear from you: ${esc(
        copy.operatorLine
      )}</p>`
    : "";

  return `
    <h1 style="margin:0 0 12px;font-size:18px">${esc(copy.greeting)}</h1>
    ${paras}
    ${headlineBlock}
    ${whoBlock}
  `;
}
