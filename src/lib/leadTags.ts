/**
 * Tags on an assignment (0150, §56): the operator's own labels on their copy
 * of a lead. Pure, so the rule is unit-testable; the DB CHECK
 * (lead_tags_valid) is the authority and enforces the same bounds.
 */
const MAX_TAGS = 20;
const MAX_TAG_CHARS = 40;

/**
 * Trim, drop empties, dedupe case-insensitively (first spelling wins), and
 * bound. Mirrors lead_tags_valid() in 0150, which is the authority.
 */
export function normaliseTags(
  raw: unknown
): { ok: true; tags: string[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, error: "tags must be a list of short labels" };
  }
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") {
      return { ok: false, error: "tags must be a list of short labels" };
    }
    const t = item.replace(/\s+/g, " ").trim();
    if (!t) continue;
    if (t.length > MAX_TAG_CHARS) {
      return { ok: false, error: `A tag can be at most ${MAX_TAG_CHARS} characters` };
    }
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(t);
  }
  if (tags.length > MAX_TAGS) {
    return { ok: false, error: `At most ${MAX_TAGS} tags on a lead` };
  }
  return { ok: true, tags };
}
