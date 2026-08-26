/**
 * Fact-recall matching for the quality benchmark.
 *
 * Extracted from `run.ts` so it can be unit-tested on its own: this is the one
 * piece of the harness that decides whether a compressor "kept the facts", and
 * the previous implementation got that decision wrong in both directions.
 *
 * It used to be `squash(body).includes(squash(fact))` — a raw substring test
 * over whitespace-stripped text. Two consequences, both of which corrupt the
 * headline number rather than merely adding noise:
 *
 *   - **False negatives punish correct output.** A compressor that wrote
 *     "coverage 是 1.0" was scored as having lost the fact `coverage 1.0`, and
 *     one that answered in Chinese lost `3 errors` even though the tool stderr
 *     said `Found 3 errors.` The metric was measuring phrasing, not recall.
 *   - **False positives inflate it.** 17 annotated facts are ≤3 characters
 *     (`en`, `q8`, `401`, `RRF`, `0.2`). Whitespace-stripped substring matching
 *     finds `en` inside `content` and `0.2` inside `10.25`, so those facts were
 *     satisfied by accident.
 *
 * The replacement has two parts:
 *   1. **Token-boundary matching.** A fact is decomposed into meaningful tokens
 *      and every token must appear in the body AS A TOKEN. Word order and
 *      intervening words are free, so "coverage 是 1.0" matches `coverage 1.0`.
 *   2. **Explicit variants, declared in the dataset.** A fact may be written as
 *      `{ any: ["3 errors", "3 个错误"] }`. Cross-language and synonym tolerance
 *      lives in reviewable annotation data, NOT in a hidden synonym table
 *      inside the scorer — otherwise the harness silently decides what counts
 *      as the same fact.
 */

/** A dataset fact: a literal string, or a set of accepted phrasings. */
export type KeyFact = string | { any: string[] };

/** Human-readable form of a fact, for the report's "missing facts" column. */
export function factLabel(fact: KeyFact): string {
  return typeof fact === 'string' ? fact : fact.any.join(' | ');
}

/**
 * Split text into comparable tokens.
 *
 * Three token shapes, because the corpus mixes all three:
 *   - identifiers / paths / words: `files_touched`, `src/db/index.ts`, `errors`
 *   - numbers, including decimals and percentages: `1.0`, `401`, `58`
 *   - CJK runs, which have no internal word boundaries
 *
 * Punctuation is a separator, so `Found 3 errors.` and `3 errors` tokenize the
 * same way.
 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const matches = lower.match(
    /[a-z_][a-z0-9_]*(?:[./-][a-z0-9_]+)*|\d+(?:\.\d+)*%?|[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g,
  );
  return matches ?? [];
}

/** True when `token` appears in the body as a token, not as a random substring. */
function bodyHasToken(bodyTokens: Set<string>, bodyCjk: string, token: string): boolean {
  if (bodyTokens.has(token)) return true;

  // CJK has no word boundaries, so substring IS the correct test there — but
  // only against the CJK-only projection of the body, never against latin text.
  if (/^[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+$/.test(token)) {
    return bodyCjk.includes(token);
  }

  // A path fact may be annotated as a suffix of what the model wrote (or the
  // reverse): `src/db/index.ts` vs `index.ts`. Only allow this for tokens that
  // actually look like paths, so short words cannot suffix-match their way in.
  if (token.includes('/')) {
    for (const bt of bodyTokens) {
      if (bt.includes('/') && (bt.endsWith(token) || token.endsWith(bt))) return true;
    }
  }
  return false;
}

/** Precomputed body index, so a turn's body is tokenized once per turn. */
export interface BodyIndex {
  tokens: Set<string>;
  cjk: string;
}

export function indexBody(body: string): BodyIndex {
  return {
    tokens: new Set(tokenize(body)),
    cjk: (body.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g) ?? []).join(''),
  };
}

/** True when every token of one phrasing is present in the body. */
function phraseMatches(index: BodyIndex, phrase: string): boolean {
  const tokens = tokenize(phrase);
  // A fact with no extractable token (pure punctuation) cannot be verified;
  // treat it as unmatched rather than vacuously satisfied.
  if (tokens.length === 0) return false;
  return tokens.every((t) => bodyHasToken(index.tokens, index.cjk, t));
}

/** True when the body preserves the fact under any of its accepted phrasings. */
export function factMatches(index: BodyIndex, fact: KeyFact): boolean {
  if (typeof fact === 'string') return phraseMatches(index, fact);
  return fact.any.some((phrase) => phraseMatches(index, phrase));
}
