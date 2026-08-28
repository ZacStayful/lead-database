/**
 * The MX-on-apex defence (§40).
 *
 * ⚠️ PUTTING AN MX RECORD ON A CUSTOMER'S APEX DOMAIN WOULD DESTROY THEIR REAL
 * EMAIL. It is the most damaging thing this feature can do and it would be
 * entirely our fault. Verified while planning: stayful.co.uk itself resolves MX
 * to smtp.google.com — a live Google Workspace that an apex mistake would take
 * down.
 *
 * There are FOUR defences and no single one is sufficient:
 *
 *   1. The customer never types a full domain. buildSendingDomain() constructs
 *      it from their registrable domain plus a prefix, so the apex is not
 *      reachable by typing.
 *   2. A DB CHECK requiring >= 3 labels (0115). A floor, not a guard —
 *      "theiragency.co.uk" has three labels and IS an apex.
 *   3. The public-suffix rule below. Label counting alone CANNOT work on UK
 *      domains, which is the whole reason this list exists.
 *   4. preflightDns(): the target must resolve NO MX, and the parent SHOULD
 *      resolve MX. This is the one that tests the real world rather than a
 *      string, and it is the one that actually saves a Google Workspace.
 *
 * The suffix list is a literal here rather than an npm dependency. It covers the
 * suffixes a UK property operator will actually hold; anything unknown falls
 * back to "last label is the suffix", which is correct for .com/.io/.dev and
 * fails SAFE for the rest (it under-counts the suffix, so a real apex is more
 * likely to be caught by rule 4 than waved through).
 */
import { promises as dns } from "node:dns";

/** Multi-label public suffixes we must not mistake for a subdomain boundary. */
const MULTI_LABEL_SUFFIXES = [
  "co.uk", "org.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "sch.uk",
  "ac.uk", "gov.uk", "nhs.uk", "police.uk", "mod.uk",
  "com.au", "net.au", "org.au", "co.nz", "co.za", "com.br",
  "co.in", "co.jp", "com.sg", "co.il", "com.mx", "co.ke",
];

export type DomainRefusal =
  | "empty"
  | "malformed"
  | "too_few_labels"
  | "public_suffix"
  | "apex"
  | "target_has_mx"
  | "dns_error";

export type DomainVerdict =
  | { ok: true; domain: string; parent: string; warning?: "parent_has_no_mx" }
  | { ok: false; code: DomainRefusal; message: string };

const LABEL = "[a-z0-9]([a-z0-9-]*[a-z0-9])?";
const DOMAIN_RE = new RegExp(`^${LABEL}(\\.${LABEL})+$`);

export function normaliseDomain(input: string): string {
  return (input ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
}

/** The suffix under which names are registered — "co.uk", "com", … */
export function publicSuffixOf(domain: string): string {
  const labels = domain.split(".");
  for (const suffix of MULTI_LABEL_SUFFIXES) {
    const parts = suffix.split(".");
    if (
      labels.length > parts.length &&
      labels.slice(-parts.length).join(".") === suffix
    ) {
      return suffix;
    }
  }
  return labels[labels.length - 1] ?? "";
}

/** The registrable domain — what the customer actually bought. */
export function registrableDomain(domain: string): string {
  const suffix = publicSuffixOf(domain);
  const suffixLabels = suffix.split(".").length;
  return domain.split(".").slice(-(suffixLabels + 1)).join(".");
}

/**
 * True only when `domain` sits strictly BELOW its registrable domain.
 * "leads.agency.co.uk" -> true. "agency.co.uk" -> false. "co.uk" -> false.
 */
export function isDedicatedSubdomain(domain: string): boolean {
  const registrable = registrableDomain(domain);
  return domain !== registrable && domain.endsWith(`.${registrable}`);
}

/** Defence #1: build the subdomain so the customer cannot supply an apex. */
export function buildSendingDomain(
  websiteDomain: string,
  prefix = "leads"
): DomainVerdict {
  const site = normaliseDomain(websiteDomain);
  const label = normaliseDomain(prefix);

  if (!site) return refuse("empty", "Enter your website domain.");
  if (!DOMAIN_RE.test(site)) {
    return refuse("malformed", `"${site}" does not look like a domain name.`);
  }
  if (!new RegExp(`^${LABEL}$`).test(label)) {
    return refuse(
      "malformed",
      "The prefix can contain only letters, numbers and hyphens."
    );
  }

  // If they pasted a subdomain into the website field, respect their registrable
  // domain rather than stacking another label onto it.
  const registrable = registrableDomain(site);
  if (registrable === site && site.split(".").length < 2) {
    return refuse("public_suffix", `"${site}" is not a registrable domain.`);
  }

  return validateSendingDomain(`${label}.${registrable}`);
}

/** Defences #2 and #3, synchronous and pure. */
export function validateSendingDomain(input: string): DomainVerdict {
  const domain = normaliseDomain(input);

  if (!domain) return refuse("empty", "Enter a domain.");
  if (!DOMAIN_RE.test(domain)) {
    return refuse("malformed", `"${domain}" does not look like a domain name.`);
  }

  // A bare public suffix ("co.uk", "uk") is nobody's domain at all. Checked
  // before the apex branch so it does not get the "use leads.co.uk" advice.
  if (
    domain.split(".").length < 2 ||
    MULTI_LABEL_SUFFIXES.includes(domain) ||
    !domain.includes(".")
  ) {
    return refuse(
      "public_suffix",
      `"${domain}" is not a registrable domain name.`
    );
  }

  // THE APEX BRANCH, and it must come before any label-count reasoning:
  // "theiragency.co.uk" has three labels and is still an apex, which is exactly
  // why counting labels cannot be the test. Every apex gets the same message,
  // and the message names the fix rather than only the fault.
  const registrable = registrableDomain(domain);
  if (domain === registrable || !isDedicatedSubdomain(domain)) {
    return refuse(
      "apex",
      `"${domain}" is your main domain. Adding mail records to it would stop your existing email arriving. Use a dedicated subdomain such as "leads.${domain}".`
    );
  }

  // Belt and braces against the DB CHECK in 0115, which requires >= 3 labels.
  // Anything reaching here should already satisfy it; refuse rather than hand
  // the database a row it will reject with a constraint error.
  if (domain.split(".").length < 3) {
    return refuse("too_few_labels", `"${domain}" is not a dedicated subdomain.`);
  }

  return { ok: true, domain, parent: registrable };
}

/**
 * Defence #4 — the real world, not a string.
 *
 * Two questions:
 *   - Does the TARGET already have MX? If so somebody is already receiving mail
 *     there and we must not take it over. Hard refusal.
 *   - Does the PARENT have MX? If it does, that is positive proof the customer
 *     named a subdomain of a live mail domain. If it does not, warn rather than
 *     block: a domain bought fresh for this is legitimate.
 *
 * ⚠️ resolveMx can RESOLVE WITH AN EMPTY ARRAY rather than throwing — verified
 * against leads.stayful.co.uk. Test the length; do not rely on a catch.
 */
export async function preflightDns(input: string): Promise<DomainVerdict> {
  const base = validateSendingDomain(input);
  if (!base.ok) return base;
  const { domain, parent } = base;

  let targetMx: unknown[] = [];
  try {
    targetMx = await dns.resolveMx(domain);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code ?? "";
    // NXDOMAIN / ENODATA are the GOOD answers here: nothing is there yet.
    if (code !== "ENOTFOUND" && code !== "ENODATA") {
      return refuse(
        "dns_error",
        `We could not check DNS for ${domain}. Try again in a moment.`
      );
    }
  }

  if (targetMx.length > 0) {
    return refuse(
      "target_has_mx",
      `${domain} already receives email. Pick a subdomain that is not in use, such as "stayful.${parent}".`
    );
  }

  let parentMx: unknown[] = [];
  try {
    parentMx = await dns.resolveMx(parent);
  } catch {
    parentMx = [];
  }

  return parentMx.length > 0
    ? { ok: true, domain, parent }
    : { ok: true, domain, parent, warning: "parent_has_no_mx" };
}

function refuse(code: DomainRefusal, message: string): DomainVerdict {
  return { ok: false, code, message };
}
