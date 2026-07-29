/**
 * B6 — the fact-recall scorer must not punish correct output nor reward
 * accidental substrings.
 *
 * These cases are taken straight from the audit: real annotations from
 * `benchmark/dataset/turns.json` that the old `squash(body).includes(fact)`
 * matcher scored wrongly in both directions.
 */
import { describe, test, expect } from 'bun:test';
import { indexBody, factMatches, tokenize, factLabel } from '../../benchmark/scoring';

const match = (body: string, fact: Parameters<typeof factMatches>[1]) =>
  factMatches(indexBody(body), fact);

describe('tokenize', () => {
  test('splits identifiers, paths, numbers and CJK runs', () => {
    expect(tokenize('Found 3 errors in src/db/index.ts')).toEqual([
      'found', '3', 'errors', 'in', 'src/db/index.ts',
    ]);
  });

  test('treats punctuation as a separator', () => {
    expect(tokenize('errors.')).toEqual(['errors']);
    expect(tokenize('coverage: 1.0,')).toEqual(['coverage', '1.0']);
  });

  test('keeps decimals and percentages intact', () => {
    expect(tokenize('58fps at 94.4%')).toEqual(['58', 'fps', 'at', '94.4%']);
  });
});

describe('no longer punishes correct-but-differently-phrased output', () => {
  test('word order and filler words do not break a match', () => {
    // Real case: annotation `coverage 1.0`, model wrote "coverage 是 1.0".
    expect(match('embedding coverage 是 1.0，全部完成', 'coverage 1.0')).toBe(true);
  });

  test('a fact split across punctuation still matches', () => {
    // Real case: annotation `3 errors`, tool stderr said "Found 3 errors."
    expect(match('typecheck output: Found 3 errors.', '3 errors')).toBe(true);
  });

  test('case differences do not matter', () => {
    expect(match('the RRF fusion step', 'rrf')).toBe(true);
    expect(match('applies rrf fusion', 'RRF')).toBe(true);
  });

  test('a path annotated as a suffix matches the fuller path', () => {
    expect(match('touched src/db/index.ts', 'db/index.ts')).toBe(true);
  });

  test('a declared cross-language variant is accepted', () => {
    expect(match('typecheck 报告 3 个错误', { any: ['3 errors', '3 个错误'] })).toBe(true);
  });

  test('variants are OR, so the English form still works', () => {
    expect(match('Found 3 errors', { any: ['3 errors', '3 个错误'] })).toBe(true);
  });
});

describe('no longer rewards accidental substrings', () => {
  test('a short latin fact does not match inside a longer word', () => {
    // The old matcher found `en` inside `content`.
    expect(match('the content of the file', 'en')).toBe(false);
    expect(match('language en selected', 'en')).toBe(true);
  });

  test('a numeric fact does not match inside a longer number', () => {
    // The old whitespace-stripped matcher found `0.2` inside `10.25`.
    expect(match('latency was 10.25ms', '0.2')).toBe(false);
    expect(match('floor is 0.2', '0.2')).toBe(true);
  });

  test('a token-level near-miss is not a match', () => {
    expect(match('the q80 quantization', 'q8')).toBe(false);
    expect(match('dtype q8 selected', 'q8')).toBe(true);
  });

  test('a multi-token fact needs ALL of its tokens', () => {
    expect(match('we saw 3 warnings', '3 errors')).toBe(false);
    expect(match('errors appeared', '3 errors')).toBe(false);
  });

  test('a short word does not suffix-match a path', () => {
    expect(match('touched src/db/index.ts', 'ts')).toBe(false);
  });

  test('a fact with no usable token is unmatched, not vacuously true', () => {
    expect(match('anything at all', '---')).toBe(false);
  });

  test('an empty variant list cannot be satisfied', () => {
    expect(match('anything', { any: [] })).toBe(false);
  });
});

describe('CJK matching', () => {
  test('a CJK fact matches inside an unsegmented run', () => {
    expect(match('修复了会话隔离的权限问题', '会话隔离')).toBe(true);
  });

  test('a CJK fact absent from the body does not match', () => {
    expect(match('修复了权限问题', '向量重排')).toBe(false);
  });
});

describe('factLabel', () => {
  test('renders a plain fact as itself', () => {
    expect(factLabel('3 errors')).toBe('3 errors');
  });

  test('renders variants so the report shows what was accepted', () => {
    expect(factLabel({ any: ['3 errors', '3 个错误'] })).toBe('3 errors | 3 个错误');
  });
});
