/**
 * `semantic-en-v1` — the two-sided English semantic normalization protocol.
 *
 * Why it exists (measured, not assumed): the bundled encoder is
 * `all-MiniLM-L6-v2`, whose 30522-token vocabulary contains 244 pure-CJK
 * tokens. Chinese input therefore lands in a degenerate region of the space —
 * unrelated Chinese sentence pairs score cosine 0.42…0.85 while annotated true
 * positives span 0.08…0.61. The same model behaves normally on English. So the
 * fix is not a bigger multilingual model; it is to put BOTH sides of the
 * comparison into English before embedding.
 *
 * Two facts from the phase 1a evaluation are load-bearing here:
 *
 *  1. **Both sides or neither.** Translating only the record side and letting a
 *     Chinese query compare against English vectors measured MRR 0.437 —
 *     *worse* than the 0.529 raw baseline. A missing/invalid English query must
 *     therefore never be silently compared against `semantic-en-v1` vectors.
 *  2. **The protocol is part of the vector-space identity.** `raw-v1` and
 *     `semantic-en-v1` are both 384-dimensional output of the same model, which
 *     makes mixing them look harmless. It is not: the mixed-space probe read
 *     0.972 one way and 0.613 the other. Hence `embeddingSpaceKey()` — the
 *     model name alone is not a version key.
 *
 * The guardrails below are also a measured requirement, not defensive habit. In
 * the phase 1a run the translator returned the literal string `...` for query
 * q16; the JSON was valid, the schema matched, and that query's rank went from
 * 1 to 18. A schema check alone does not detect a well-formed useless value.
 */

import { DIMENSIONS, EMBEDDING_MODEL, MODEL_DTYPE } from './embedding-space';

export const RAW_PROTOCOL = 'raw-v1';
export const SEMANTIC_EN_PROTOCOL = 'semantic-en-v1';

/** Text normalization applied before embedding. Part of the space identity. */
export type NormalizationProtocol = typeof RAW_PROTOCOL | typeof SEMANTIC_EN_PROTOCOL;

export const NORMALIZATION_PROTOCOLS: readonly NormalizationProtocol[] = [
  RAW_PROTOCOL,
  SEMANTIC_EN_PROTOCOL,
];

export function isNormalizationProtocol(value: unknown): value is NormalizationProtocol {
  return value === RAW_PROTOCOL || value === SEMANTIC_EN_PROTOCOL;
}

/**
 * Identity of a comparable vector space: model + quantization + dimensions +
 * text protocol.
 *
 * This string is written into `observation_embeddings.model` and used as the
 * read filter, so two protocols can coexist in the table while remaining
 * impossible to rank against each other. Comparing on model name and
 * dimensionality alone was not enough — that is precisely the mistake this key
 * makes unrepresentable.
 */
export function embeddingSpaceKey(protocol: NormalizationProtocol): string {
  return `${EMBEDDING_MODEL}:${MODEL_DTYPE}:${DIMENSIONS}:${protocol}`;
}

// ---------------------------------------------------------------------------
// Derived value shape
// ---------------------------------------------------------------------------

/** The English derived value for one Observation. Mirrors the embedded fields. */
export interface SemanticEnRecord {
  title: string;
  summary: string;
  outcome: string;
  learned: string;
  concepts: string[];
}

/** The original-language fields the derived value must faithfully mirror. */
export interface SemanticEnRecordSource {
  title: string;
  summary: string;
  outcome: string | null;
  learned: string | null;
  concepts: string[];
}

/** Why a derived value was refused. Kept coarse so it can be counted. */
export type NormalizationRejectReason =
  | 'not_object'
  | 'empty'
  | 'placeholder'
  | 'invented'
  | 'concepts_count'
  | 'lost_tokens'
  | 'untranslated'
  | 'length_ratio'
  | 'repetition'
  | 'too_long';

export type NormalizationCheck =
  | { ok: true }
  | { ok: false; reason: NormalizationRejectReason; detail: string };

const fail = (reason: NormalizationRejectReason, detail: string): NormalizationCheck => ({
  ok: false,
  reason,
  detail,
});

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Same caps the compressor already applies to the original fields. */
const TITLE_MAX_CHARS = 200;
const FIELD_MAX_CHARS = 2000;
const CONCEPTS_MAX_ITEMS = 30;
const CONCEPT_MAX_CHARS = 400;
/** A search query, not a document. Anything longer is not a normalized query. */
export const QUERY_MAX_CHARS = 500;

/**
 * How much CJK may survive in an "English" value.
 *
 * Not zero: a faithful translation legitimately keeps a quoted Chinese string
 * literal or a Chinese product name that appears in the record. But a value
 * that is still mostly Chinese was not translated at all, and that is the
 * failure that silently reintroduces the degenerate region this protocol
 * exists to avoid.
 */
const MAX_CJK_RATIO = 0.15;

/** Record side: English is usually longer than Chinese, never much shorter. */
const RECORD_MIN_LENGTH_RATIO = 0.5;
const RECORD_MAX_LENGTH_RATIO = 6;
/** Query side: short strings make the ratio noisier, so the band is wider. */
const QUERY_MIN_LENGTH_RATIO = 0.4;
const QUERY_MAX_LENGTH_RATIO = 10;

// ---------------------------------------------------------------------------
// Primitive checks
// ---------------------------------------------------------------------------

/**
 * Well-formed but useless output. `...` is here because the translator actually
 * produced it (phase 1a, q16) and a JSON/schema check accepted it.
 */
const PLACEHOLDER_VALUES = new Set([
  '...', '..', '.', '…', '-', '--', '---', '—', '?', '??', '_', '*',
  'n/a', 'n.a.', 'na', 'none', 'null', 'nil', 'undefined', 'unknown',
  'unspecified', 'tbd', 'todo', 'no data', 'not available', 'not applicable',
  'empty', 'string', 'text',
  '无', '未知', '暂无', '略',
]);

export function isPlaceholderText(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!normalized) return true;
  if (PLACEHOLDER_VALUES.has(normalized)) return true;
  // Punctuation / symbols only — covers `......`, `- -`, `??` and friends.
  return /^[\p{P}\p{S}\s]+$/u.test(normalized);
}

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu;

export function cjkCharCount(text: string): number {
  return (text.match(CJK_RE) ?? []).length;
}

function visibleLength(text: string): number {
  return text.replace(/\s+/g, '').length;
}

function cjkRatio(text: string): number {
  const len = visibleLength(text);
  return len === 0 ? 0 : cjkCharCount(text) / len;
}

/**
 * Language-neutral, high-signal tokens that a faithful translation must keep:
 * paths, dotted/hyphenated identifiers, SCREAMING_SNAKE constants, and
 * multi-digit numbers.
 *
 * Single digits are deliberately exempt: "第 1 位" legitimately becomes "first",
 * so requiring the character `1` would reject a correct translation. Numbers of
 * two or more characters (`200`, `0.2`, `37778`) carry meaning that no
 * translation should restate in words.
 */
const IDENTIFIER_RE = /[A-Za-z_$][A-Za-z0-9_$]*(?:[.\-/:][A-Za-z0-9_$]+)+/g;
const CONSTANT_RE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
/**
 * Bare code identifiers, which the separator-based pattern above misses.
 * `extractFtsSearchUnits` is exactly the kind of token a translator "helpfully"
 * turns into "the unit extractor" — losing the one string a future reader could
 * grep for. Casing makes them safe to require: ordinary English prose does not
 * contain camelCase, PascalCase compounds or snake_case.
 */
const CAMEL_RE = /\b[a-z][a-z0-9]*(?:[A-Z][A-Za-z0-9]*)+\b/g;
const PASCAL_RE = /\b[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+\b/g;
const SNAKE_RE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;
const NUMBER_RE = /\d+(?:\.\d+)?/g;

export function protectedTokens(text: string): string[] {
  const tokens = new Set<string>();
  for (const re of [IDENTIFIER_RE, CONSTANT_RE, CAMEL_RE, PASCAL_RE, SNAKE_RE]) {
    for (const m of text.matchAll(re)) tokens.add(m[0]);
  }
  for (const m of text.matchAll(NUMBER_RE)) if (m[0].length >= 2) tokens.add(m[0]);
  return [...tokens];
}

function missingTokens(source: string, candidate: string): string[] {
  return protectedTokens(source).filter((token) => !candidate.includes(token));
}

/**
 * A degenerate model loop: the same sentence emitted over and over. Cheap to
 * detect, and the alternative is a vector built from one idea repeated ten
 * times.
 */
function hasRepetition(text: string): boolean {
  const sentences = text
    .split(/[.!?;\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 15);
  if (sentences.length < 3) return false;
  const counts = new Map<string, number>();
  for (const s of sentences) counts.set(s, (counts.get(s) ?? 0) + 1);
  return [...counts.values()].some((c) => c >= 3);
}

// ---------------------------------------------------------------------------
// Record side
// ---------------------------------------------------------------------------

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Coerce an untrusted object into a `SemanticEnRecord` shape without judging
 * its content. Validation is `checkSemanticEnRecord`; keeping the two apart
 * means a malformed shape and a bad translation produce different reasons.
 */
export function coerceSemanticEnRecord(value: unknown): SemanticEnRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const concepts = Array.isArray(v.concepts)
    ? v.concepts.filter((x): x is string => typeof x === 'string')
    : [];
  return {
    title: asString(v.title).trim(),
    summary: asString(v.summary).trim(),
    outcome: asString(v.outcome).trim(),
    learned: asString(v.learned).trim(),
    concepts: concepts.map((c) => c.trim()),
  };
}

/**
 * Decide whether an English derived value may enter the `semantic-en-v1` space.
 *
 * The contract is *faithful mirror*, not summary: same fields, same concept
 * count, same identifiers, no invention. A value that fails here is not
 * downgraded or patched — the Observation keeps its original text, gets no
 * `semantic-en-v1` vector, and is recorded as pending/failed. Writing a vector
 * from a wrong translation would be worse than having none, because it looks
 * exactly like a good one at read time.
 */
export function checkSemanticEnRecord(
  candidate: SemanticEnRecord | null,
  source: SemanticEnRecordSource,
): NormalizationCheck {
  if (!candidate) return fail('not_object', 'derived value missing or not an object');

  if (!candidate.title || isPlaceholderText(candidate.title)) {
    return fail(candidate.title ? 'placeholder' : 'empty', 'title');
  }
  if (!candidate.summary || isPlaceholderText(candidate.summary)) {
    return fail(candidate.summary ? 'placeholder' : 'empty', 'summary');
  }

  for (const field of ['outcome', 'learned'] as const) {
    const sourceValue = (source[field] ?? '').trim();
    const value = candidate[field];
    if (sourceValue && !value) return fail('empty', field);
    if (sourceValue && isPlaceholderText(value)) return fail('placeholder', field);
    // The reverse direction is invention, which is the other way a "faithful"
    // translator silently changes what the record says.
    if (!sourceValue && value) return fail('invented', field);
  }

  if (candidate.concepts.length !== source.concepts.length) {
    return fail(
      'concepts_count',
      `${candidate.concepts.length} vs source ${source.concepts.length}`,
    );
  }
  for (const [i, concept] of candidate.concepts.entries()) {
    if (!concept || isPlaceholderText(concept)) return fail('placeholder', `concepts[${i}]`);
    if (concept.length > CONCEPT_MAX_CHARS) return fail('too_long', `concepts[${i}]`);
  }
  if (candidate.concepts.length > CONCEPTS_MAX_ITEMS) {
    return fail('too_long', `concepts ${candidate.concepts.length} items`);
  }
  if (candidate.title.length > TITLE_MAX_CHARS) return fail('too_long', 'title');
  for (const field of ['summary', 'outcome', 'learned'] as const) {
    if (candidate[field].length > FIELD_MAX_CHARS) return fail('too_long', field);
  }

  const sourceText = joinRecord({
    title: source.title,
    summary: source.summary,
    outcome: source.outcome ?? '',
    learned: source.learned ?? '',
    concepts: source.concepts,
  });
  const candidateText = joinRecord(candidate);

  if (cjkRatio(candidateText) > MAX_CJK_RATIO) {
    return fail('untranslated', `cjk ratio ${cjkRatio(candidateText).toFixed(2)}`);
  }
  if (cjkCharCount(source.title) > 0 && candidate.title === source.title.trim()) {
    return fail('untranslated', 'title identical to source');
  }

  const lost = missingTokens(sourceText, candidateText);
  if (lost.length) return fail('lost_tokens', lost.slice(0, 5).join(', '));

  const ratio = visibleLength(candidateText) / Math.max(1, visibleLength(sourceText));
  if (ratio < RECORD_MIN_LENGTH_RATIO || ratio > RECORD_MAX_LENGTH_RATIO) {
    return fail('length_ratio', ratio.toFixed(2));
  }

  if (hasRepetition(candidateText)) return fail('repetition', 'duplicate sentences');

  return { ok: true };
}

function joinRecord(record: SemanticEnRecord): string {
  return [record.title, record.summary, record.outcome, record.learned, record.concepts.join(', ')]
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Query side
// ---------------------------------------------------------------------------

/**
 * Decide whether a caller-supplied `semantic_query_en` may be embedded into the
 * `semantic-en-v1` space.
 *
 * The query side has no retry: it is on the interactive path and phase 1b
 * forbids spending a second LLM round trip there. So a value that fails here
 * degrades the search (raw leg or FTS-only), it never gets repaired.
 */
export function checkSemanticEnQuery(candidate: string, source: string): NormalizationCheck {
  const value = candidate.trim();
  if (!value) return fail('empty', 'semantic_query_en');
  if (value.length > QUERY_MAX_CHARS) return fail('too_long', `${value.length} chars`);
  if (isPlaceholderText(value)) return fail('placeholder', value.slice(0, 24));

  if (cjkRatio(value) > MAX_CJK_RATIO) {
    return fail('untranslated', `cjk ratio ${cjkRatio(value).toFixed(2)}`);
  }
  // An English source legitimately normalizes to itself; a Chinese one cannot.
  if (cjkCharCount(source) > 0 && value === source.trim()) {
    return fail('untranslated', 'identical to source');
  }

  const lost = missingTokens(source, value);
  if (lost.length) return fail('lost_tokens', lost.slice(0, 5).join(', '));

  const ratio = visibleLength(value) / Math.max(1, visibleLength(source));
  if (ratio < QUERY_MIN_LENGTH_RATIO || ratio > QUERY_MAX_LENGTH_RATIO) {
    return fail('length_ratio', ratio.toFixed(2));
  }

  return { ok: true };
}

/** The text that is actually embedded for a record under `protocol`. */
export function semanticEnSearchTextFields(
  record: SemanticEnRecord,
  files: string[],
): {
  title: string;
  summary: string;
  outcome: string | null;
  learned: string | null;
  concepts: string[];
  files: string[];
} {
  return {
    title: record.title,
    summary: record.summary,
    outcome: record.outcome || null,
    learned: record.learned || null,
    concepts: record.concepts,
    // Paths are language-neutral and high-signal: translating them would change
    // the retrieval task itself, so both protocols embed the same file list.
    files,
  };
}
