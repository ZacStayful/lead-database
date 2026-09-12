import type { Customer, LeadType } from "@/lib/types";

export const DAYS_IN_CYCLE = 30;

/**
 * Deficit at or beyond which an unfiltered customer is "critically behind" and
 * reclaims a lead slot from a matching filtered candidate (the guarantee-floor
 * override in routing). Matches the admin supply-problem alert threshold
 * (deficit >= 5) — the strongest existing behind-pace signal.
 */
export const CRITICALLY_BEHIND_DEFICIT = 5;

export type PacingStatus = "behind" | "on_track" | "ahead";

export interface Pacing {
  daysElapsed: number;
  daysRemaining: number;
  expected: number;
  deficit: number;
  status: PacingStatus;
  /**
   * The plan allocation actually owed this cycle: allocation − pool debit,
   * floored at zero. Equals `allocation` for the overwhelming majority of
   * customers, who have never claimed from the pool.
   */
  effectiveAllocation: number;
  /** Leads claimed from the pool last cycle and being settled from this one. */
  poolDebit: number;
}

/**
 * Leads a customer is owed this cycle.
 *
 * A customer on 20 a month who claimed 3 from the expired pool while at zero
 * balance is owed 17 this cycle — they have already had the other 3. Counting
 * the full 20 would show them a deficit of 3 for the whole month, name them on
 * the admin supply-problem banner, and push leads at them ahead of customers
 * who genuinely are short.
 *
 * Floored at zero, matching public.effective_allocation(): a debit larger than
 * the allocation means the customer has already drawn more than this cycle
 * owes, and a negative expectation would rank them below customers who are
 * exactly level.
 */
export function effectiveAllocation(
  allocation: number | null | undefined,
  poolDebit: number | null | undefined
): number {
  return Math.max((allocation ?? 0) - (poolDebit ?? 0), 0);
}

/**
 * Pacing maths for a single customer, mirroring the SQL used by
 * get_next_customers_for_lead:
 *
 *   days_elapsed = today - billing_cycle_anchor
 *   expected     = ROUND((days_elapsed / 30) * monthly_allocation)
 *   deficit      = expected - leads_received_this_month
 *
 * A positive deficit means the customer is behind pace. If the customer has no
 * billing_cycle_anchor yet (subscription webhook not received), we fall back to
 * their created_at so the number is still meaningful.
 */
export function computePacing(customer: Customer, now: Date = new Date()): Pacing {
  const anchorStr = customer.billing_cycle_anchor ?? customer.created_at;
  // Match the SQL (coalesce(billing_cycle_anchor, created_at::date)): count from
  // midnight of the anchor date, not the exact created_at instant, so the
  // dashboard deficit agrees with the value used for lead-ordering.
  const anchor = new Date(anchorStr);
  anchor.setHours(0, 0, 0, 0);

  const msPerDay = 1000 * 60 * 60 * 24;
  const rawElapsed = Math.floor((now.getTime() - anchor.getTime()) / msPerDay);
  const daysElapsed = Math.max(0, Math.min(rawElapsed, DAYS_IN_CYCLE));
  const daysRemaining = Math.max(0, DAYS_IN_CYCLE - daysElapsed);

  const poolDebit = customer.pool_debit ?? 0;
  const allocation = effectiveAllocation(customer.monthly_allocation ?? 20, poolDebit);
  const expected = Math.round((daysElapsed / DAYS_IN_CYCLE) * allocation);
  const deficit = expected - customer.leads_received_this_month;

  return {
    daysElapsed,
    daysRemaining,
    expected,
    deficit,
    status: statusFor(deficit),
    effectiveAllocation: allocation,
    poolDebit,
  };
}

/**
 * GR pacing — the same maths as computePacing but on the guaranteed-rent
 * columns (gr_billing_cycle_anchor, gr_monthly_allocation,
 * gr_leads_received_this_month), mirroring the GR branch of
 * get_next_customers_for_lead.
 */
export function computeGrPacing(customer: Customer, now: Date = new Date()): Pacing {
  const anchorStr = customer.gr_billing_cycle_anchor ?? customer.created_at;
  // Normalised to midnight for the same reason computePacing is: the SQL counts
  // from coalesce(gr_billing_cycle_anchor, created_at::date), and created_at is
  // a full timestamp. Without this the fallback path kept its time-of-day and
  // could report a day less elapsed than the value used for lead-ordering.
  const anchor = new Date(anchorStr);
  anchor.setHours(0, 0, 0, 0);

  const msPerDay = 1000 * 60 * 60 * 24;
  const rawElapsed = Math.floor((now.getTime() - anchor.getTime()) / msPerDay);
  const daysElapsed = Math.max(0, Math.min(rawElapsed, DAYS_IN_CYCLE));
  const daysRemaining = Math.max(0, DAYS_IN_CYCLE - daysElapsed);

  const poolDebit = customer.gr_pool_debit ?? 0;
  const allocation = effectiveAllocation(customer.gr_monthly_allocation, poolDebit);
  const expected = Math.round((daysElapsed / DAYS_IN_CYCLE) * allocation);
  const deficit = expected - customer.gr_leads_received_this_month;

  return {
    daysElapsed,
    daysRemaining,
    expected,
    deficit,
    status: statusFor(deficit),
    effectiveAllocation: allocation,
    poolDebit,
  };
}

export function statusFor(deficit: number): PacingStatus {
  if (deficit >= 3) return "behind";
  if (deficit <= -3) return "ahead";
  return "on_track";
}

/**
 * Contextual sentence shown to the customer on their dashboard. Pass the
 * customer's monthly allocation so the "on track" copy reflects their plan
 * (10 or 20 leads) rather than a hardcoded number.
 *
 * Pass the EFFECTIVE allocation where a debit is in play. Promising "your 20
 * leads this month" to a customer who is owed 18 sets up a complaint we would
 * deserve; poolDebitExplanation() below says why the number moved.
 */
export function pacingMessage(deficit: number, monthlyAllocation = 20): string {
  const status = statusFor(deficit);
  if (status === "behind") {
    return "You are behind pace this month — your leads are being prioritised.";
  }
  if (status === "ahead") {
    return "You are ahead of pace this month.";
  }
  return `You are on track to receive your ${monthlyAllocation} leads this month.`;
}

/**
 * Why this cycle's allocation is smaller than the plan, or null when it is not.
 *
 * A reduced number with no explanation reads as a mistake, and the customer's
 * first move is to email support about leads they have already had. Naming the
 * cause turns it into a receipt for a choice they made.
 *
 * Plain, no exclamation, no apology: the customer got the leads, this is the
 * bill. Singular/plural handled because "1 leads" undercuts the tone the rest
 * of the pool copy is written in.
 */
export function poolDebitExplanation(
  effectiveAllocationThisCycle: number,
  poolDebit: number
): string | null {
  if (poolDebit <= 0) return null;
  const leads = poolDebit === 1 ? "1 lead" : `${poolDebit} leads`;
  return (
    `${effectiveAllocationThisCycle} leads this cycle. ` +
    `Your allocation is reduced by ${leads} you claimed from expired leads last cycle.`
  );
}

// ---------------------------------------------------------------------------
// Staged release — one lead a working day (0148, §54)
//
// ⚠️ DISPLAY ONLY. The gate is public.customer_release_allows() in SQL, called
// from both ordinary-routing candidate functions. This is its mirror, used for
// every customer-facing sentence ("your next lead is due tomorrow"), the
// dashboard Today panel, the daily digest, the admin allocation page and the
// public API's `next_lead_due`. The two must change in ONE commit, the same
// rule effectiveAllocation() ↔ effective_allocation() already lives under.
//
// Dates are LONDON dates. Vercel runs in UTC and Britain is an hour ahead for
// half the year (§40.12): a schedule keyed on the UTC date would say "tomorrow"
// at 23:30 on a Friday when London already thinks it is Saturday.
// ---------------------------------------------------------------------------

export interface ReleaseSettings {
  /** `release_enabled` — the kill switch. Off means today's behaviour. */
  enabled: boolean;
  /** `release_max_per_day` — hard ceiling per customer per product per London day. */
  maxPerDay: number;
  /** `release_cycle_days` — the window the working days are counted in. */
  cycleDays: number;
}

export const DEFAULT_RELEASE_SETTINGS: ReleaseSettings = {
  enabled: false,
  maxPerDay: 2,
  cycleDays: DAYS_IN_CYCLE,
};

/** YYYY-MM-DD in Europe/London for the given instant. */
export function londonDate(at: Date): string {
  // en-CA renders as YYYY-MM-DD, which is the only reason for the locale.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** A YYYY-MM-DD string as a UTC-midnight Date, for day arithmetic only. */
function ymdToUtc(ymd: string): Date {
  const [y, m, d] = ymd.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function utcToYmd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** YYYY-MM-DD plus n calendar days. */
export function addDays(ymd: string, n: number): string {
  const d = ymdToUtc(ymd);
  d.setUTCDate(d.getUTCDate() + n);
  return utcToYmd(d);
}

/** Monday–Friday. Bank holidays count as working days here, as in the SQL. */
export function isWorkingDay(ymd: string): boolean {
  const dow = ymdToUtc(ymd).getUTCDay(); // 0 = Sunday
  return dow >= 1 && dow <= 5;
}

/**
 * Working days in [from, to], inclusive of both ends; 0 when reversed or
 * either is missing. Mirrors public.working_days_between().
 */
export function workingDaysBetween(from: string | null, to: string | null): number {
  if (!from || !to) return 0;
  const a = ymdToUtc(from);
  const b = ymdToUtc(to);
  if (b < a) return 0;
  let n = 0;
  for (let d = new Date(a); d <= b; d.setUTCDate(d.getUTCDate() + 1)) {
    const dow = d.getUTCDay();
    if (dow >= 1 && dow <= 5) n += 1;
  }
  return n;
}

export interface ReleaseSchedule {
  /** False = the switch is off and nothing below describes a rule. */
  enabled: boolean;
  mode: "daily" | "immediate";
  /** Working days in [anchor, today] — the customer's working day number. */
  workingDaysElapsed: number;
  /** Working days in the cycle window — what the entitlement is spread over. */
  workingDaysInCycle: number;
  /** received + balance: what this cycle actually owes, top-ups included. */
  entitlement: number;
  /** ceil(k × E / W), capped at E. */
  allowance: number;
  received: number;
  receivedToday: number;
  /** Ordinary routing may hand them one more lead today. */
  dueToday: boolean;
  /** Everything this cycle owes has been delivered; the next batch is renewal. */
  exhausted: boolean;
  /** The hold that is refusing today, or null. */
  onHoldUntil: string | null;
  /**
   * The next London date on which the rule owes them a lead (today when
   * dueToday). Null when exhausted or when the switch is off.
   */
  nextReleaseDate: string | null;
}

function anchorFor(customer: Customer, leadType: LeadType): string {
  const raw =
    leadType === "guaranteed_rent"
      ? (customer.gr_billing_cycle_anchor ?? customer.created_at)
      : (customer.billing_cycle_anchor ?? customer.created_at);
  // Match the SQL: coalesce(anchor, created_at::date). created_at is a
  // timestamp; its date part is what the column cast yields.
  return raw.slice(0, 10);
}

/**
 * Where a customer sits on the one-a-working-day schedule right now.
 *
 * `receivedToday` is the count of this product's assignments dated today in
 * London — the caller reads it, because the customer row does not carry it.
 * The SQL counts EVERY assignment (pool claims and admin assigns included)
 * against the day's cap, so pass the same.
 */
export function releaseSchedule(
  customer: Customer,
  leadType: LeadType,
  receivedToday: number,
  settings: ReleaseSettings = DEFAULT_RELEASE_SETTINGS,
  now: Date = new Date()
): ReleaseSchedule {
  const gr = leadType === "guaranteed_rent";
  const received = gr
    ? (customer.gr_leads_received_this_month ?? 0)
    : (customer.leads_received_this_month ?? 0);
  const balance = gr ? (customer.gr_lead_balance ?? 0) : (customer.lead_balance ?? 0);
  const hold = gr ? customer.gr_release_hold_until : customer.release_hold_until;
  const mode: "daily" | "immediate" =
    customer.release_mode === "immediate" ? "immediate" : "daily";

  const today = londonDate(now);
  const anchor = anchorFor(customer, leadType);
  const cycleDays = Math.max(1, settings.cycleDays);
  const maxPerDay = Math.max(1, settings.maxPerDay);
  const entitlement = received + balance;
  const workingDaysInCycle = Math.max(
    1,
    workingDaysBetween(anchor, addDays(anchor, cycleDays - 1))
  );
  const workingDaysElapsed = workingDaysBetween(anchor, today);
  const exhausted = entitlement <= 0 || received >= entitlement;

  const base = {
    mode,
    workingDaysElapsed,
    workingDaysInCycle,
    entitlement,
    received,
    receivedToday,
    exhausted,
  };

  if (!settings.enabled || mode === "immediate") {
    const dueToday = balance > 0;
    return {
      ...base,
      enabled: settings.enabled,
      allowance: entitlement,
      dueToday,
      onHoldUntil: null,
      nextReleaseDate: settings.enabled && dueToday ? today : null,
    };
  }

  const allowanceOn = (k: number) =>
    Math.min(entitlement, Math.ceil((k * entitlement) / workingDaysInCycle));
  const allowance = allowanceOn(workingDaysElapsed);
  const onHoldUntil = hold && today < hold.slice(0, 10) ? hold.slice(0, 10) : null;

  const dueToday =
    !onHoldUntil &&
    !exhausted &&
    received < allowance &&
    receivedToday < maxPerDay;

  let nextReleaseDate: string | null = null;
  if (dueToday) {
    nextReleaseDate = today;
  } else if (!exhausted) {
    // Walk forward until the curve owes one more than they have, past any
    // hold. Bounded: the curve reaches E within the cycle window, and a hold
    // is capped at the route, so a few months is plenty.
    for (let i = 1; i <= cycleDays * 4; i += 1) {
      const d = addDays(today, i);
      if (onHoldUntil && d < onHoldUntil) continue;
      if (!isWorkingDay(d)) continue;
      if (allowanceOn(workingDaysBetween(anchor, d)) > received) {
        nextReleaseDate = d;
        break;
      }
    }
  }

  return { ...base, enabled: true, allowance, dueToday, onHoldUntil, nextReleaseDate };
}

/**
 * Read the three release settings from a `system_settings` map, falling back
 * to the migration defaults. `enabled` fails CLOSED-to-today: a missing or
 * unreadable row means the rule is off, exactly as the SQL reads it.
 */
export function releaseSettingsFrom(
  rows: { key: string; value: string }[] | null | undefined
): ReleaseSettings {
  const map = new Map((rows ?? []).map((r) => [r.key, r.value]));
  const int = (key: string, fallback: number) => {
    const n = Number(map.get(key)?.trim());
    return Number.isFinite(n) && Number.isInteger(n) && n > 0 ? n : fallback;
  };
  return {
    enabled: map.get("release_enabled")?.trim() === "true",
    maxPerDay: int("release_max_per_day", DEFAULT_RELEASE_SETTINGS.maxPerDay),
    cycleDays: int("release_cycle_days", DEFAULT_RELEASE_SETTINGS.cycleDays),
  };
}

/** The system_settings keys releaseSettingsFrom() reads, for callers' selects. */
export const RELEASE_SETTING_KEYS = [
  "release_enabled",
  "release_max_per_day",
  "release_cycle_days",
] as const;
