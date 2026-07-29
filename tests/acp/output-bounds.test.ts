/**
 * Secondary risks S2 / S7 / S8 / S9 — bounds and single-source invariants.
 *
 * None of these break anything on a good day, which is exactly why they needed
 * pinning: each one is a quiet divergence between what the code promises and
 * what it does.
 */
import { describe, test, expect } from 'bun:test';
import { ACPCompressor, validateSchema } from '../../src/acp/compressor';
import { detectRepo as detectRepoFromScope } from '../../src/db/scope';
import { detectRepo as detectRepoFromDb } from '../../src/db';
import { detectRepo as detectRepoFromMcpScope } from '../../src/server/mcp-scope';

/** Minimal pool stand-in: returns whatever text the test wants to "compress". */
function poolReturning(text: string) {
  return {
    run: async () => ({ text, truncated: false }),
    close: async () => {},
    stats: { total: 0, contaminated: 0 },
  };
}

async function summarize(raw: unknown) {
  const compressor = new ACPCompressor({}, poolReturning(JSON.stringify(raw)) as any);
  return compressor.summarizeObservation({
    user_prompt: 'p',
    assistant_response: 'r',
    artifacts: { files_touched: [], commands: [], test_signals: [], error_signals: [], facts: [] },
  });
}

describe('S2: compressor output is length-bounded before it becomes immutable', () => {
  test('an over-long prose field is capped', async () => {
    const r = await summarize({
      title: 'ok', summary: 'S'.repeat(10_000), request: '', outcome: 'O'.repeat(10_000),
      learned: '', next_steps: '', memory_type: 'change',
      files_touched: [], concepts: [], evidence: [],
      importance_score: 0.5, confidence_score: 0.5, unresolved_score: 0,
    });
    expect(r.summary.length).toBeLessThanOrEqual(2000);
    expect(r.outcome.length).toBeLessThanOrEqual(2000);
  });

  test('title is bounded much tighter, because it is rendered in the injected index', async () => {
    const r = await summarize({
      title: 'T'.repeat(5000), summary: 's', request: '', outcome: '', learned: '',
      next_steps: '', memory_type: 'change', files_touched: [], concepts: [], evidence: [],
      importance_score: 0, confidence_score: 0, unresolved_score: 0,
    });
    expect(r.title.length).toBeLessThanOrEqual(200);
  });

  test('array fields are bounded by item count and per-item length', async () => {
    const r = await summarize({
      title: 'ok', summary: 's', request: '', outcome: '', learned: '', next_steps: '',
      memory_type: 'change',
      files_touched: Array.from({ length: 200 }, (_, i) => `f${i}.ts`),
      concepts: [],
      evidence: Array.from({ length: 200 }, () => 'E'.repeat(5000)),
      importance_score: 0, confidence_score: 0, unresolved_score: 0,
    });
    expect(r.files_touched.length).toBeLessThanOrEqual(30);
    expect(r.evidence.length).toBeLessThanOrEqual(30);
    for (const item of r.evidence) expect(item.length).toBeLessThanOrEqual(400);
  });

  test('a normal-sized result passes through unchanged', async () => {
    const r = await summarize({
      title: 'Fix token refresh', summary: 'Rotation retried once.', request: 'fix it',
      outcome: 'green', learned: 'retry once', next_steps: '', memory_type: 'bugfix',
      files_touched: ['src/auth.ts'], concepts: ['token'], evidence: ['exit 0'],
      importance_score: 0.7, confidence_score: 0.9, unresolved_score: 0.1,
    });
    expect(r.title).toBe('Fix token refresh');
    expect(r.summary).toBe('Rotation retried once.');
    expect(r.files_touched).toEqual(['src/auth.ts']);
    expect(r.memory_type).toBe('bugfix');
  });
});

describe('S9: the direct-construction default matches the documented one', () => {
  /** Counts pool invocations: 1 initial attempt + maxRetries repair attempts. */
  function countingPool(text: string) {
    const calls = { n: 0 };
    const pool = {
      run: async () => { calls.n++; return { text, truncated: false }; },
      close: async () => {},
      stats: { total: 0, contaminated: 0 },
    };
    return { pool, calls };
  }

  const summarizeWith = (compressor: ACPCompressor) =>
    compressor.summarizeObservation({
      user_prompt: 'p', assistant_response: 'r',
      artifacts: { files_touched: [], commands: [], test_signals: [], error_signals: [], facts: [] },
    });

  test('maxRetries defaults to 2, as config.json and the README both state', async () => {
    const { pool, calls } = countingPool('not json');
    await summarizeWith(new ACPCompressor({}, pool as any));
    // 1 attempt + 2 repairs. It used to be 1 + 1, silently contradicting the
    // documented default of 2.
    expect(calls.n).toBe(3);
  });

  test('an explicit value still wins', async () => {
    const { pool, calls } = countingPool('not json');
    await summarizeWith(new ACPCompressor({ maxRetries: 5 }, pool as any));
    expect(calls.n).toBe(6);
  });

  test('valid output on the first try makes no repair calls', async () => {
    const { pool, calls } = countingPool(JSON.stringify({
      title: 'ok', summary: 's', request: '', outcome: '', learned: '', next_steps: '',
      memory_type: 'change', files_touched: [], concepts: [], evidence: [],
      importance_score: 0, confidence_score: 0, unresolved_score: 0,
    }));
    await summarizeWith(new ACPCompressor({}, pool as any));
    expect(calls.n).toBe(1);
  });
});

describe('S8: unvalidated model output never passes through', () => {
  test('an unrecognized context returns the fallback, not the raw parse', () => {
    const fallback = { marker: 'fallback' };
    const out = validateSchema({ marker: 'raw model output' }, fallback, 'someNewContext');
    // Previously `return parsed as T` — the ONE path that skipped validation was
    // also the silent one, so a new call site would have shipped unvalidated.
    expect(out).toBe(fallback);
  });

  test('the known context is still validated and coerced', () => {
    const out = validateSchema<Record<string, unknown>>(
      { title: 'ok', memory_type: 'bugfix' },
      { marker: 'fallback' },
      'summarizeObservation',
    );
    expect(out.title).toBe('ok');
    expect(out.memory_type).toBe('bugfix');
    expect(out.marker).toBeUndefined();
  });

  test('a non-object response degrades to the fallback', async () => {
    const r = await summarize('just a string');
    // Fallback carries deterministic emptiness, not fabricated content.
    expect(r.title).toBe('');
    expect(r.memory_type).toBe('change');
  });

  test('unknown fields are dropped rather than copied into storage', async () => {
    const r = await summarize({
      title: 'ok', summary: 's', request: '', outcome: '', learned: '', next_steps: '',
      memory_type: 'change', files_touched: [], concepts: [], evidence: [],
      importance_score: 0, confidence_score: 0, unresolved_score: 0,
      injected_extra: 'should not survive',
    });
    expect((r as unknown as Record<string, unknown>).injected_extra).toBeUndefined();
  });

  test('an out-of-enum memory_type falls back instead of reaching the DB', async () => {
    const r = await summarize({
      title: 'ok', summary: 's', request: '', outcome: '', learned: '', next_steps: '',
      memory_type: 'not-a-real-type', files_touched: [], concepts: [], evidence: [],
      importance_score: 99, confidence_score: -5, unresolved_score: 0,
    });
    expect(r.memory_type).toBe('change');
    expect(r.importance_score).toBe(1);
    expect(r.confidence_score).toBe(0);
  });
});

describe('S7: git root detection has exactly one implementation', () => {
  test('all three former call sites now resolve to the same function', () => {
    expect(detectRepoFromDb).toBe(detectRepoFromScope);
    expect(detectRepoFromMcpScope).toBe(detectRepoFromScope);
  });

  test('it detects this repository from its own directory', () => {
    const root = detectRepoFromScope(import.meta.dir);
    expect(root).toBeTruthy();
    expect(root!.endsWith('kiro-memory')).toBe(true);
  });

  test('a non-repo path yields null rather than throwing', () => {
    expect(detectRepoFromScope('/')).toBeNull();
  });

  test('an empty cwd short-circuits', () => {
    expect(detectRepoFromScope('')).toBeNull();
  });
});
