/**
 * `*emphasis*` in a headline, turned into something Satori can lay out (§65).
 *
 * ⚠️ IMPORT-FREE.
 *
 * ⚠️ BOTH OBVIOUS IMPLEMENTATIONS ARE TRAPS, AND STEP 1 PROVED BOTH.
 *
 *   - Emitting the runs as bare children of a `flexWrap` div EATS THE SPACE at
 *     every run boundary: `properties, *4.9* on Google` renders `4.9on
 *     Google`. Satori trims the trailing whitespace of each text run.
 *   - Fixing that with `whiteSpace: 'pre'` restores the spaces and KILLS
 *     WRAPPING ENTIRELY — the line runs straight off the canvas, silently,
 *     because nothing measures it.
 *
 * What works is one span per WORD with the space carried as a margin, and the
 * emphasis applied to character runs INSIDE the word — so a full stop that
 * follows an emphasised word stays attached to it and does not drift to the
 * next line as ` .`.
 *
 * ⚠️ A `<span>` may hold an array of children without `display: flex`. The
 * guard in satori tests `h === "div"` only, and that exemption is the whole
 * reason this shape is available.
 */

/** A run of characters within one word, all emphasised or all not. */
export type EmphasisSegment = { text: string; emphasised: boolean };
/** One whitespace-delimited word, as one or more same-emphasis segments. */
export type EmphasisWord = EmphasisSegment[];

/**
 * Mark every character. Unmatched asterisks are literal — an operator writing
 * "5 * 3" must not silently lose the rest of the line to an open marker.
 */
function marked(source: string): Array<[string, boolean]> {
  const out: Array<[string, boolean]> = [];
  let i = 0;
  while (i < source.length) {
    if (source[i] === "*") {
      const close = source.indexOf("*", i + 1);
      // An empty `**` is not emphasis; close > i + 1 rejects it.
      if (close > i + 1) {
        for (const ch of source.slice(i + 1, close)) out.push([ch, true]);
        i = close + 1;
        continue;
      }
    }
    out.push([source[i], false]);
    i += 1;
  }
  return out;
}

/** Split into words, keeping punctuation attached across an emphasis boundary. */
export function emphasisWords(source: string): EmphasisWord[] {
  const words: Array<Array<[string, boolean]>> = [];
  let current: Array<[string, boolean]> = [];
  for (const [ch, em] of marked(source)) {
    if (/\s/.test(ch)) {
      if (current.length) words.push(current);
      current = [];
    } else {
      current.push([ch, em]);
    }
  }
  if (current.length) words.push(current);

  return words.map((word) => {
    const segments: EmphasisWord = [];
    for (const [ch, em] of word) {
      const last = segments[segments.length - 1];
      if (last && last.emphasised === em) last.text += ch;
      else segments.push({ text: ch, emphasised: em });
    }
    return segments;
  });
}

/**
 * The same text with the markers removed and the spacing intact.
 *
 * This is what goes to Meta (its fields carry no emphasis), what the figure
 * check reads, and what any length bound is measured against — a headline must
 * never be judged on characters the reader never sees.
 */
export function stripEmphasis(source: string): string {
  return marked(source)
    .map(([ch]) => ch)
    .join("");
}

/** Just the emphasised spans, for tests and for the prompt's worked examples. */
export function emphasisedSpans(source: string): string[] {
  const out: string[] = [];
  let buffer = "";
  for (const [ch, em] of marked(source)) {
    if (em) buffer += ch;
    else if (buffer) {
      out.push(buffer);
      buffer = "";
    }
  }
  if (buffer) out.push(buffer);
  return out;
}

export function hasEmphasis(source: string): boolean {
  return marked(source).some(([, em]) => em);
}
