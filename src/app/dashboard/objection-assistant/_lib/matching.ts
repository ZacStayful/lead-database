// Pure search/matching logic for the Objection Assistant.
// Ported from the reference App.jsx — no backend, no API calls during use.

import { FAQS, SMART_WORDS, type Faq } from "./faqData";

const STOPWORDS = new Set(
  ("the a an of to is are do you i my what how much will it in on for and or your "
    + "me this that with at be can if there they we so just about would could does "
    + "have has was were like want need them then our us not no yes ok okay").split(" ")
);

export function normalise(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Smart words → which FAQ ids each concept term should surface.
const SMART_BY_ID: Record<number, string[]> = {};
for (const [term, ids] of Object.entries(SMART_WORDS)) {
  for (const id of ids) (SMART_BY_ID[id] ||= []).push(normalise(term));
}

interface IndexEntry {
  faq: Faq;
  phrases: string[];
  smart: string[];
  qwords: string[];
  prefixWords: string[];
}

// Pre-build a lightweight match index from each FAQ.
const INDEX: IndexEntry[] = FAQS.map((faq) => {
  const phrases = [...faq.keywords, faq.category].map(normalise).filter(Boolean);
  const smart = SMART_BY_ID[faq.id] || [];
  const qwords = normalise(faq.question)
    .split(" ")
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  // Single-word tokens used for fast prefix (typeahead) matching.
  const prefixWords = Array.from(
    new Set(
      [
        ...qwords,
        ...smart,
        ...phrases.flatMap((p) => p.split(" ")),
      ].filter((w) => w.length > 2 && !STOPWORDS.has(w))
    )
  );
  return { faq, phrases, smart, qwords, prefixWords };
});

export const FAQ_BY_ID: Record<number, Faq> = Object.fromEntries(
  FAQS.map((f) => [f.id, f])
);

export interface Match {
  faq: Faq;
  score: number;
}

// Score every FAQ against the query text. Returns ranked matches.
// Matching is layered so even a near-miss surfaces the closest answer:
//   - exact multi-word phrase / keyword (strong)
//   - single-word keyword, category or smart-word/synonym match
//   - prefix match on the word being typed (typeahead — "comp" → compliance)
// When a lead profile is active, its relevant cards get a small boost.
export function rankMatches(text: string, profile: string): Match[] {
  const t = normalise(text);
  if (!t) return [];
  const tokens = t.split(" ");
  const words = new Set(tokens);
  const lastToken = tokens[tokens.length - 1];
  const results: Match[] = [];
  for (const item of INDEX) {
    let score = 0;
    for (const phrase of item.phrases) {
      if (phrase.includes(" ")) {
        if (t.includes(phrase)) score += 3 + phrase.split(" ").length;
      } else if (words.has(phrase)) {
        score += 1.5;
      }
    }
    // Smart-word / synonym hits (e.g. "compliance" → legal/tax/insurance cards)
    for (const s of item.smart) {
      if (s.includes(" ") ? t.includes(s) : words.has(s)) score += 1.4;
    }
    for (const w of item.qwords) if (words.has(w)) score += 0.5;
    // Prefix match on whatever word is currently being typed.
    if (lastToken && lastToken.length >= 2) {
      for (const w of item.prefixWords) {
        if (w !== lastToken && w.startsWith(lastToken)) {
          score += 0.6;
          break;
        }
      }
    }
    if (score > 0) {
      if (item.faq.tier === 1) score += 0.3;
      if (profile && item.faq.profiles?.includes(profile)) score += 0.4;
      results.push({ faq: item.faq, score });
    }
  }
  return results.sort((a, b) => b.score - a.score);
}

// Score below which we treat the top result as an approximate / related match
// (no exact answer existed, but this is the closest).
export const CLOSEST_MATCH_THRESHOLD = 3;
