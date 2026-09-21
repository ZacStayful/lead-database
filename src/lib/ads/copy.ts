/**
 * Every word the ad builder puts on screen (§65). ⚠️ IMPORT-FREE — the chat,
 * the picker and the result page are all client components.
 */

/**
 * Already in the box when the page opens. The customer presses Send.
 *
 * ⚠️ EDITABLE, AND IT IS STORED AS WHAT THEY SENT. `ad_drafts.prompt` is their
 * words, not this constant, so a customer who rewrites it is answered on their
 * own terms and we can see later what people actually ask for.
 */
export const AD_STARTER_PROMPT =
  "Build me a Facebook ad that gets landlords near me to enquire about short let management.";

/**
 * ⚠️ MUST EQUAL `MAX_DEPTH` in src/lib/feedback/schemas.ts, and a unit test
 * asserts it. §50's ladder already restates that constant in
 * `ClarifyStep.tsx:34` with nothing pinning it, which is one silent copy
 * already; a third would be careless.
 */
export const AD_MAX_DEPTH = 2;

export const AD_COPY = {
  starterPrompt: AD_STARTER_PROMPT,

  chat: {
    thinking: "Reading your account and picking an angle…",
    pickedPrefix: "I’d use",
    switchCta: "Use a different angle",
    // Switching nulls the answers, so say so BEFORE rather than after.
    switchWarning:
      "A different angle asks different questions, so your answers so far are cleared.",
    questionsIntro:
      "A few questions, then I’ll write it. Everything here goes on the ad, so it is worth being exact.",
    /**
     * ⚠️ APPENDED TO THE STORED `template_reason`, NOT RETURNED IN A ROUTE'S
     * BODY, AND THAT IS THE WHOLE POINT.
     *
     * `QuestionSet.degraded` was returned by two routes and read by nobody —
     * the same fault as the copy path's, one step earlier. It could not survive
     * the navigation to the draft page, where the chat re-renders from the row.
     * `template_reason` is already stored and already rendered, so the honesty
     * arrives with no column and no migration.
     *
     * It matters most in exactly the case that produced the bad ad: with no API
     * key this is the FIRST thing the operator sees, rather than finding out at
     * the end from an ad that read as badly written.
     */
    standardQuestions:
      "I couldn’t reach the writer just now, so these are our standard questions for this angle rather than ones picked for you.",
    simplify: "Not sure what this means?",
    simplifying: "Rewording…",
    send: "Write the ad",
    sending: "Writing…",
    // ⚠️ No skip control, which is only fair because the ladder terminates in
    // a plain text box (§50).
    incomplete: (answered: number, total: number) =>
      `${answered} of ${total} answered. If a question doesn’t make sense, tap “Not sure what this means?” underneath it.`,
  },

  result: {
    title: "Your ad",
    copyHeading: "The words",
    creativeHeading: "The images",
    download: "Download",
    regenerate: "Rewrite the words",
    deleteCta: "Delete this ad",
    retryRender: "Try the images again",
    // ⚠️ SAID PLAINLY, AND IT CARRIES NO META SEMANTICS. Meta's
    // `self_ai_disclosure` declares AI-generated MEDIA; our media is a card we
    // drew, and only the words are model-written. Setting OPT_IN would put
    // "Media in this ad created or edited with AI" on an ad where it is untrue.
    aiNotice:
      "The words were drafted by AI from what you told us. Read them before you publish — they are your ad, in your name.",
    truncationNote:
      "Facebook shortens longer text with a “See more”. The marks show roughly where.",

    /**
     * ⚠️ THE ANGLE'S OWN NAME, NEVER "Variant 2". The name from the spec —
     * "the cleaner who cancels on a Friday" — is the reason to prefer one text
     * over another, and it is the only thing that makes a list of five worth
     * reading rather than five things to read.
     */
    anglesHeading: "Other angles",
    recommended: "Start with this one",
    /**
     * ⚠️ "N of M", AND ONLY WHEN THEY DIFFER. Four written out of five offered
     * is an honest ad with four texts in it; saying so where it happened beats
     * both silence and an apology. Five of five says nothing worth reading, so
     * it is not shown.
     */
    someAngles: (written: number, offered: number) =>
      `${written} of ${offered} angles came back usable — the rest broke one of the ad rules and were dropped.`,
    /**
     * ⚠️ SHOWN WHEN THE CARD IS THE TEMPLATE'S OWN LINE RATHER THAN THE
     * MODEL'S. The two on-image lines are the one place `aiNotice` could be
     * false about a specific thing on the screen, so where they are ours, the
     * page says they are ours.
     */
    imageFromTemplate:
      "The line on the image is our standard one for this angle — what the model wrote for it wouldn’t fit the card.",
  },

  gate: {
    // §62: an admin viewing a customer gets a read-only surface. Without this
    // every button looks live and fails with what reads like a product error.
    readOnly:
      "You’re viewing another customer’s account, so this is read-only. Exit the view to make changes.",
  },

  errors: {
    generic: "Something went wrong writing that. Try again in a moment.",
    noKey: "Ad writing is not configured on this environment yet.",
    /**
     * ⚠️ THREE SENTENCES FOR THREE FAILURES, AND NONE OF THEM IS AN AD.
     *
     * All three used to end at the template's own default text, stored and
     * rendered under `aiNotice` — so "we could not reach the model" and "the
     * model wrote something we had to refuse" both presented as a finished ad
     * the AI had written. That is what made the feature read as bad at writing
     * rather than as unconfigured.
     *
     * Nothing is stored on any of them; the answers are kept, so Retry costs
     * the operator nothing but the wait.
     */
    notWritten: {
      not_configured:
        "Ad writing isn’t switched on for this environment, so nothing was written. Nothing has been lost — your answers are still here.",
      call_failed:
        "I couldn’t reach the writer just then. Your answers are still here — try again in a moment.",
      rejected:
        "What came back broke the ad rules twice over, so I haven’t kept it. Your answers are still here — try again, or change an answer first.",
    } as Record<string, string>,
    budget: "You’ve made a lot of ads today. Try again tomorrow.",
    switches: "You’ve changed angle a few times already — pick one and we’ll write it.",
    regenerations: "That’s as many rewrites as this ad gets. Change an answer and I’ll try again.",
    renders: "That’s as many image renders as this ad gets.",
    // A draft in `generating` is one somebody else (or another tab) has.
    busy: "This ad is already being written.",
    /**
     * ⚠️ ONE SENTENCE, THREE ROUTES. The answers route named what was missing,
     * Regenerate wrote its own wording inline, and the render route showed only
     * `generic` for the identical condition — so which explanation a customer
     * met depended on where they were standing, and one of the three said
     * nothing at all.
     */
    unresolved: (labels: string[]) =>
      `Before I can write this I still need ${labels.join(", ")}.`,
  },
} as const;
