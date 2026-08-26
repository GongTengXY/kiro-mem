/**
 * `semantic-en-v1` protocol guardrails (plan §5.3 / §5.5 gate 1).
 *
 * These are not schema tests. The failure they exist for was well-formed: in the
 * phase 1a run the translator returned the literal string `...` for query q16 —
 * valid JSON, correct shape, and that query's rank went from 1 to 18. Every case
 * below is a value a JSON/schema check would have accepted.
 */
import { describe, expect, test } from 'bun:test';
import {
  RAW_PROTOCOL,
  SEMANTIC_EN_PROTOCOL,
  checkSemanticEnQuery,
  checkSemanticEnRecord,
  coerceSemanticEnRecord,
  embeddingSpaceKey,
  isPlaceholderText,
  protectedTokens,
  type SemanticEnRecord,
  type SemanticEnRecordSource,
} from '../../src/semantic-en';
import { DIMENSIONS, EMBEDDING_MODEL } from '../../src/embedding-space';

const source: SemanticEnRecordSource = {
  title: '修复 FTS 中文两字词漏匹配',
  summary: '定位到 extractFtsSearchUnits() 的 3 字窗口，导致 "引号" 这类词在 trigram 下不可达。改为对 2 字 CJK 词补一条 LIKE 查询。',
  outcome: '已修复并通过 bun test，heldout hit@5 从 44.4% 升到 50.0%',
  learned: 'FTS_MIN_UNIT_LEN = 3 与 trigram 分词器叠加时，短词的可达性依赖左右相邻字',
  concepts: ['全文搜索', '中文分词', 'trigram'],
};

const good: SemanticEnRecord = {
  title: 'Fix missed 2-character Chinese term matching in FTS',
  summary: 'Traced it to the 3-character window in extractFtsSearchUnits(), which makes terms like "引号" unreachable under trigram. Added a LIKE query for 2-character CJK terms.',
  outcome: 'Fixed and verified with bun test; heldout hit@5 rose from 44.4% to 50.0%',
  learned: 'When FTS_MIN_UNIT_LEN = 3 combines with the trigram tokenizer, a short term is only reachable if its neighbouring characters also align',
  concepts: ['full-text search', 'Chinese word segmentation', 'trigram'],
};

describe('embeddingSpaceKey', () => {
  test('carries model, dtype, dimensions AND protocol', () => {
    expect(embeddingSpaceKey(RAW_PROTOCOL)).toBe(`${EMBEDDING_MODEL}:q8:${DIMENSIONS}:raw-v1`);
    expect(embeddingSpaceKey(SEMANTIC_EN_PROTOCOL)).toBe(
      `${EMBEDDING_MODEL}:q8:${DIMENSIONS}:semantic-en-v1`,
    );
  });

  test('the two protocols are different keys despite identical model and dims', () => {
    // This is the whole point: both are 384-d output of the same model, so a
    // model-name filter would have silently ranked them against each other. The
    // mixed-space probe measured 0.972 one direction and 0.613 the other.
    expect(embeddingSpaceKey(RAW_PROTOCOL)).not.toBe(embeddingSpaceKey(SEMANTIC_EN_PROTOCOL));
  });
});

describe('checkSemanticEnRecord', () => {
  test('accepts a faithful translation', () => {
    expect(checkSemanticEnRecord(good, source)).toEqual({ ok: true });
  });

  test('rejects the exact q16 failure: a placeholder value', () => {
    for (const placeholder of ['...', '…', 'N/A', 'unknown', '--', '?']) {
      const check = checkSemanticEnRecord({ ...good, summary: placeholder }, source);
      expect(check.ok).toBe(false);
      if (!check.ok) expect(check.reason).toBe('placeholder');
    }
  });

  test('rejects an empty field whose source was not empty', () => {
    const check = checkSemanticEnRecord({ ...good, outcome: '' }, source);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe('empty');
  });

  test('rejects invented content for a field the source left empty', () => {
    const emptyLearned = { ...source, learned: '' };
    const check = checkSemanticEnRecord(good, emptyLearned);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe('invented');
  });

  test('rejects a concepts count that does not match the source', () => {
    const check = checkSemanticEnRecord({ ...good, concepts: ['full-text search'] }, source);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe('concepts_count');
  });

  test('rejects a translation that dropped an identifier or a number', () => {
    const noIdentifier = {
      ...good,
      summary: good.summary.replace('extractFtsSearchUnits()', 'the unit extractor'),
    };
    const dropped = checkSemanticEnRecord(noIdentifier, source);
    expect(dropped.ok).toBe(false);
    if (!dropped.ok) expect(dropped.reason).toBe('lost_tokens');

    const noNumber = { ...good, outcome: 'Fixed and verified with bun test; heldout hit@5 improved' };
    const droppedNumber = checkSemanticEnRecord(noNumber, source);
    expect(droppedNumber.ok).toBe(false);
    if (!droppedNumber.ok) expect(droppedNumber.reason).toBe('lost_tokens');
  });

  test('rejects untranslated Chinese passed through as the "English" value', () => {
    // The failure that silently reintroduces the degenerate region: unrelated
    // Chinese pairs score cosine 0.42…0.85 in this model.
    const check = checkSemanticEnRecord(
      {
        title: source.title,
        summary: source.summary,
        outcome: source.outcome ?? '',
        learned: source.learned ?? '',
        concepts: source.concepts,
      },
      source,
    );
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe('untranslated');
  });

  test('rejects a degenerate repetition loop', () => {
    const repeated = 'The retrieval kernel fuses FTS and semantic ranks with RRF';
    const check = checkSemanticEnRecord(
      {
        ...good,
        summary: `${repeated}. ${repeated}. ${repeated}. ${repeated}. extractFtsSearchUnits() 3 44.4 50.0 FTS_MIN_UNIT_LEN`,
      },
      source,
    );
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe('repetition');
  });

  test('rejects a missing derived value rather than treating it as empty English', () => {
    const check = checkSemanticEnRecord(null, source);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe('not_object');
  });

  test('coercion separates a broken shape from a bad translation', () => {
    expect(coerceSemanticEnRecord('nope')).toBeNull();
    expect(coerceSemanticEnRecord({ title: 'a', concepts: [1, 'b'] })).toEqual({
      title: 'a',
      summary: '',
      outcome: '',
      learned: '',
      concepts: ['b'],
    });
  });
});

describe('checkSemanticEnQuery', () => {
  test('tolerates a quoted Chinese term inside an otherwise English query', () => {
    // Not zero CJK: the search term itself may be the Chinese string the user is
    // looking for, and stripping it would change the question. The bound is a
    // ratio, so a mostly-Chinese "translation" still fails (next test).
    expect(
      checkSemanticEnQuery('why does searching for 引号 return nothing', '搜索引号为什么搜不到'),
    ).toEqual({ ok: true });
  });

  test('accepts a fully English rendering', () => {
    expect(
      checkSemanticEnQuery('why does a quoted-term search return nothing', '搜索引号为什么搜不到'),
    ).toEqual({ ok: true });
  });

  test('an English source may normalize to itself', () => {
    const q = 'how is the embedding space keyed';
    expect(checkSemanticEnQuery(q, q)).toEqual({ ok: true });
  });

  test('rejects empty, placeholder, and echoed-Chinese values', () => {
    const zh = '向量维度是多少';
    expect(checkSemanticEnQuery('', zh)).toMatchObject({ ok: false, reason: 'empty' });
    expect(checkSemanticEnQuery('...', zh)).toMatchObject({ ok: false, reason: 'placeholder' });
    expect(checkSemanticEnQuery(zh, zh)).toMatchObject({ ok: false, reason: 'untranslated' });
  });

  test('rejects a value that dropped an identifier from the query', () => {
    expect(
      checkSemanticEnQuery('where is the semantic floor set', 'SEMANTIC_FLOOR 定在哪里'),
    ).toMatchObject({ ok: false, reason: 'lost_tokens' });
  });

  test('rejects an over-long "query"', () => {
    expect(checkSemanticEnQuery('x'.repeat(600), '很短的中文问题')).toMatchObject({
      ok: false,
      reason: 'too_long',
    });
  });
});

describe('protectedTokens', () => {
  test('captures paths, dotted identifiers, constants and multi-digit numbers', () => {
    const tokens = protectedTokens(
      '改 src/db/index.ts 的 extractFtsSearchUnits()，SEMANTIC_FLOOR 从 0.2 调到 0.25，第 1 位不变',
    );
    expect(tokens).toContain('src/db/index.ts');
    expect(tokens).toContain('SEMANTIC_FLOOR');
    expect(tokens).toContain('0.2');
    expect(tokens).toContain('0.25');
    // Single digits are exempt on purpose: "第 1 位" legitimately becomes
    // "first", so requiring the character would reject a correct translation.
    expect(tokens).not.toContain('1');
  });
});

describe('isPlaceholderText', () => {
  test('treats punctuation-only and known filler strings as placeholders', () => {
    for (const s of ['', '   ', '...', '。。。', 'N/A', 'unknown', 'TBD', '- -']) {
      expect(isPlaceholderText(s)).toBe(true);
    }
    expect(isPlaceholderText('fix the trigram window')).toBe(false);
  });
});
