/**
 * The operator's own half of the income presentation (0093).
 *
 * ⚠️ THIS MIRRORS `defaults()` IN public/income-presentation/index.html AND THE
 * TWO MUST CHANGE TOGETHER. The seed hands the tool a COMPLETE object rather
 * than a partial, because the tool's `merge(base, over)` copies the base's keys
 * first and therefore cannot SHRINK an array — a profile with three onboarding
 * steps merged over five defaults would come out as five. The same duplication
 * §20 records for capture_operator_proof against get_operator_proof, and the
 * same rule: they are one thing written twice.
 *
 * WHAT IS DELIBERATELY ABSENT: anything about a property. Gross, nightly rate,
 * occupancy, the long-let rent, the platform and cleaning percentages and the
 * seasonal curve all come from the lead's report. What lives here is what the
 * OPERATOR sells — and in particular their management fee, which the report
 * also states and which must never be taken from it: the report charges 15% of
 * gross because that is STAYFUL'S fee, and an operator quoting it to a landlord
 * would be quoting ours.
 */

export interface PresentationFee {
  pct: number;
  /** Whether the fee is charged on gross or on income net of platform fees. */
  basis: "net" | "gross";
  desc: string;
}

export interface PresentationSettings {
  fee: PresentationFee;
  cleaning: { mode: string; desc: string };
  contract: { term: string; notice: string; exit: string };
  compliance: string;
  vetting: string;
  onboarding: { title: string; when: string }[];
  managed: string[];
  landlord: string[];
  discovery: { q: string; done: boolean }[];
  nextSteps: { label: string; done: boolean }[];
}

/** Verbatim from the tool's own `defaults()`. */
export const DEFAULT_PRESENTATION_SETTINGS: PresentationSettings = {
  fee: {
    pct: 15,
    basis: "net",
    desc: "No setup, monthly or exit fee — the fee is only ever a share of income earned.",
  },
  cleaning: {
    mode: "Passed to the guest",
    desc: "The cleaning fee is paid by the guest on top of the nightly rate, so it does not reduce your income.",
  },
  contract: {
    term: "6 months, then rolling",
    notice: "3 months",
    exit: "No exit fee after the fixed term.",
  },
  compliance:
    "Short-term letting rules vary by area. Note any local licensing, planning or safety requirements that apply to the property.",
  vetting:
    "ID verification and a security deposit on every booking. Check-in details are released only once both clear.",
  onboarding: [
    { title: "Management agreement signed", when: "Day 1" },
    { title: "Kick-off call and key handover", when: "Week 1" },
    { title: "Photography and listing setup", when: "Weeks 1–2" },
    { title: "Pre-launch inspection", when: "Week 2" },
    { title: "Live across booking platforms", when: "Week 3" },
  ],
  managed: [
    "Listing setup across booking platforms",
    "Dynamic nightly pricing",
    "Guest screening and communication",
    "Cleaning coordination",
    "Maintenance handling",
    "Monthly income reporting",
  ],
  landlord: [
    "Mortgage and lender consent",
    "Suitable short-let insurance",
    "Annual safety certificates",
    "Council tax and utilities",
  ],
  discovery: [
    { q: "Is the property tenanted or vacant right now?", done: false },
    { q: "Why consider short-let over a long-let?", done: false },
    { q: "Any prior short-term letting experience?", done: false },
    { q: "Main concerns — voids, wear, effort?", done: false },
    { q: "What is the timeline to go live?", done: false },
    { q: "What would make the decision easy?", done: false },
  ],
  nextSteps: [
    { label: "Follow-up call booked", done: false },
    { label: "Send management agreement", done: false },
    { label: "Send income breakdown", done: false },
  ],
};

const MAX_TEXT = 600;
const MAX_LABEL = 160;
const MAX_ITEMS = 20;

function text(value: unknown, fallback: string, max = MAX_TEXT): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return trimmed.slice(0, max);
}

function stringList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const out = value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, MAX_ITEMS)
    .map((v) => v.slice(0, MAX_LABEL));
  // An empty list is a legitimate choice — an operator who manages nothing
  // worth listing should not be given ours back.
  return Array.isArray(value) ? out : fallback;
}

/**
 * Coerce whatever the browser sent into a valid profile.
 *
 * A WHITELIST, NOT A FILTER. Anything not named here is dropped rather than
 * corrected, so the blob can only ever hold the keys the presentation reads.
 * The tool escapes what it renders — values become React children via
 * createElement — so this is about bounds and shape rather than being the last
 * line against injection, but a column read on every dashboard load should not
 * be an unbounded jsonb sink either.
 *
 * Never throws: an unusable field falls back to the default, so a malformed
 * save degrades to the generic wording rather than 500-ing on an operator with
 * a landlord waiting.
 */
export function validatePresentationSettings(input: unknown): PresentationSettings {
  const d = DEFAULT_PRESENTATION_SETTINGS;
  const raw = (input ?? {}) as Record<string, unknown>;

  const feeRaw = (raw.fee ?? {}) as Record<string, unknown>;
  const pct = Number(feeRaw.pct);
  const cleaningRaw = (raw.cleaning ?? {}) as Record<string, unknown>;
  const contractRaw = (raw.contract ?? {}) as Record<string, unknown>;

  return {
    fee: {
      // 0 is not a fee and 100 is not a business. Out of range falls back
      // rather than clamping, because a clamped 900% silently becoming 100%
      // would be presented to a landlord as if it were meant.
      pct: Number.isFinite(pct) && pct > 0 && pct < 100 ? pct : d.fee.pct,
      basis: feeRaw.basis === "gross" ? "gross" : "net",
      desc: text(feeRaw.desc, d.fee.desc),
    },
    cleaning: {
      mode: text(cleaningRaw.mode, d.cleaning.mode, MAX_LABEL),
      desc: text(cleaningRaw.desc, d.cleaning.desc),
    },
    contract: {
      term: text(contractRaw.term, d.contract.term, MAX_LABEL),
      notice: text(contractRaw.notice, d.contract.notice, MAX_LABEL),
      exit: text(contractRaw.exit, d.contract.exit),
    },
    compliance: text(raw.compliance, d.compliance),
    vetting: text(raw.vetting, d.vetting),
    onboarding: Array.isArray(raw.onboarding)
      ? raw.onboarding
          .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === "object")
          .slice(0, MAX_ITEMS)
          .map((s) => ({
            title: text(s.title, "Step", MAX_LABEL),
            when: text(s.when, "", MAX_LABEL),
          }))
      : d.onboarding,
    managed: stringList(raw.managed, d.managed),
    landlord: stringList(raw.landlord, d.landlord),
    discovery: Array.isArray(raw.discovery)
      ? raw.discovery
          .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === "object")
          .slice(0, MAX_ITEMS)
          .map((s) => ({
            q: text(s.q, "", MAX_LABEL),
            // The ticks are per meeting, never per profile — a saved profile
            // that remembered them would open every lead half answered.
            done: false,
          }))
          .filter((s) => s.q)
      : d.discovery,
    nextSteps: Array.isArray(raw.nextSteps)
      ? raw.nextSteps
          .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === "object")
          .slice(0, MAX_ITEMS)
          .map((s) => ({ label: text(s.label, "", MAX_LABEL), done: false }))
          .filter((s) => s.label)
      : d.nextSteps,
  };
}
