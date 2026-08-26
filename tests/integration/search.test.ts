import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { MemoryDB, computeScopeKey } from '../../src/db';
import { openInMemoryDB } from '../support/tmp-db';
import { embeddingToBlob } from '../../src/embedding';
import { hybridSearchObservations } from '../../src/server/observation-search';

/**
 * 注：本文件的搜索调用都显式传 `semanticQueryEn`。
 *
 * 这不是装饰。raw-v1 降级轮次冻结的产品语义是「`semantic_query_en` 缺失或被护栏拒绝时一律
 * 走 FTS-only，不生成 query embedding、不读取 raw 向量」，所以不传英文形式的调用**根本不会
 * 执行语义腿**，那些断言测的就不再是 RRF / 平局 / cap / 超时降级了。
 *
 * 传 query 自身是合法路径而非取巧：护栏写明"An English source legitimately normalizes to
 * itself"，只拒绝中文原文的回显，而本文件的 fixture query 全是英文。
 */

let db: MemoryDB;

beforeEach(() => { db = openInMemoryDB(); });
afterEach(() => { db.close(); });

/** Seed a closed turn + Observation, optionally with a fixed embedding vector. */
function seed(o: {
  session_id?: string;
  repo?: string | null;
  cwd?: string;
  title: string;
  stoppedAt: string;
  embedding?: number[];
  type?: 'decision' | 'bugfix' | 'feature' | 'refactor' | 'discovery' | 'change';
}): number {
  const session_id = o.session_id ?? 's1';
  const cwd = o.cwd ?? '/proj';
  const repo = o.repo === undefined ? '/proj' : o.repo;
  if (!db.getSessionRef(session_id)) db.upsertSessionRef({ session_id, cwd, repo });
  const seq = db.allocateNextTurnSeq(session_id);
  const turn = db.createTurn({ session_id, seq, cwd, repo, prompt_text: o.title });
  db.markTurnClosed(turn.id);
  const id = db.insertObservation({
    turn_id: turn.id, session_id, turn_seq: seq, repo, cwd_scope: cwd,
    title: o.title, summary: o.title, memory_type: o.type ?? 'change', quality: 'normal',
    turn_started_at: o.stoppedAt, turn_stopped_at: o.stoppedAt,
  })!;
  if (o.embedding) {
    db.upsertObservationEmbedding(id, 'test', o.embedding.length, embeddingToBlob(new Float32Array(o.embedding)));
  }
  return id;
}

// The fixtures above store 4-dimensional vectors under the model name 'test'.
// The retrieval kernel only compares vectors from the model it is querying with,
// so every injected embedder must declare the space it belongs to — otherwise
// the fixture would be claiming to be production MiniLM output.
const TEST_VECTOR_SPACE = { embeddingModel: 'test', embeddingDimensions: 4 };

// Deterministic embedder: query vector always [1,0,0,0]; cosine == dot product.
const queryVec = async () => new Float32Array([1, 0, 0, 0]);

describe('hybridSearchObservations', () => {
  test('RRF ranks a hit matched by BOTH fts and semantic above single-source hits', async () => {
    const both = seed({ title: 'alpha work', stoppedAt: '2026-07-01T00:00:00Z', embedding: [1, 0, 0, 0] });
    const ftsOnly = seed({ title: 'alpha task', stoppedAt: '2026-07-02T00:00:00Z' });
    const semOnly = seed({ title: 'beta thing', stoppedAt: '2026-07-03T00:00:00Z', embedding: [1, 0, 0, 0] });

    const results = await hybridSearchObservations(db, 'alpha', { scopeKey: computeScopeKey('/proj', '/proj'), semanticQueryEn: 'alpha' }, { ...TEST_VECTOR_SPACE, generateEmbedding: queryVec });
    const ids = results.map((r) => r.id);
    expect(ids).toContain(both);
    expect(ids).toContain(ftsOnly);
    expect(ids).toContain(semOnly);
    // The dual-matched observation ranks first with match_source 'hybrid'.
    expect(results[0]!.id).toBe(both);
    expect(results[0]!.match_source).toBe('hybrid');
    expect(results[0]!.semantic_score).toBeCloseTo(1.0, 3);
  });

  test('cross-scope recall is 0 — a scoped search never returns another workspace', async () => {
    seed({ session_id: 'a', repo: '/repoA', cwd: '/repoA', title: 'shared alpha', stoppedAt: '2026-07-01T00:00:00Z', embedding: [1, 0, 0, 0] });
    const inB = seed({ session_id: 'b', repo: '/repoB', cwd: '/repoB', title: 'shared alpha', stoppedAt: '2026-07-02T00:00:00Z', embedding: [1, 0, 0, 0] });

    const results = await hybridSearchObservations(db, 'alpha', { scopeKey: computeScopeKey('/repoA', '/repoA'), semanticQueryEn: 'alpha' }, { ...TEST_VECTOR_SPACE, generateEmbedding: queryVec });
    expect(results.length).toBe(1);
    expect(results[0]!.repo).toBe('/repoA');
    expect(results.map((r) => r.id)).not.toContain(inB);
  });

  test('degrades to FTS-only when the embedder throws', async () => {
    const hit = seed({ title: 'gamma work', stoppedAt: '2026-07-01T00:00:00Z', embedding: [1, 0, 0, 0] });
    const throwing = async () => { throw new Error('model unavailable'); };

    const results = await hybridSearchObservations(db, 'gamma', { scopeKey: computeScopeKey('/proj', '/proj'), semanticQueryEn: 'gamma' }, { ...TEST_VECTOR_SPACE, generateEmbedding: throwing });
    expect(results.length).toBe(1);
    expect(results[0]!.id).toBe(hit);
    expect(results[0]!.match_source).toBe('fts'); // no semantic contribution
    expect(results[0]!.semantic_score).toBeNull();
  });

  test('tie-break: equal RRF score prefers the more recent turn_stopped_at', async () => {
    // obsX: fts-only rank 1. obsY: semantic-only rank 1. Both RRF = 1/(60+1) → tie.
    const older = seed({ title: 'gamma only fts', stoppedAt: '2026-07-01T00:00:00Z' });
    const newer = seed({ title: 'delta only semantic', stoppedAt: '2026-07-05T00:00:00Z', embedding: [1, 0, 0, 0] });

    const results = await hybridSearchObservations(db, 'gamma', { scopeKey: computeScopeKey('/proj', '/proj'), semanticQueryEn: 'gamma' }, { ...TEST_VECTOR_SPACE, generateEmbedding: queryVec });
    expect(results.length).toBe(2);
    // Tie broken toward the newer observation.
    expect(results[0]!.id).toBe(newer);
    expect(results[1]!.id).toBe(older);
  });

  test('empty candidate set returns []', async () => {
    seed({ title: 'nothing relevant', stoppedAt: '2026-07-01T00:00:00Z' });
    const results = await hybridSearchObservations(db, 'zzzznomatch', { scopeKey: computeScopeKey('/proj', '/proj'), semanticQueryEn: 'zzzznomatch' }, { ...TEST_VECTOR_SPACE, generateEmbedding: async () => new Float32Array([0, 0, 0, 1]) });
    expect(results.length).toBe(0);
  });

  test('a hanging embedder times out and degrades to FTS-only exactly once', async () => {
    const hit = seed({ title: 'timeout fallback marker', stoppedAt: '2026-07-01T00:00:00Z', embedding: [1, 0, 0, 0] });
    let degraded = 0;
    const never = () => new Promise<Float32Array>(() => {});
    const started = performance.now();
    const results = await hybridSearchObservations(
      db,
      'timeout fallback',
      { scopeKey: computeScopeKey('/proj', '/proj'), semanticQueryEn: 'timeout fallback' },
      { ...TEST_VECTOR_SPACE, generateEmbedding: never, embeddingTimeoutMs: 20, onDegrade: () => { degraded++; } },
    );

    expect(performance.now() - started).toBeLessThan(250);
    expect(results.map((r) => r.id)).toEqual([hit]);
    expect(results[0]!.match_source).toBe('fts');
    expect(degraded).toBe(1);
  });

  test('no lexical anchor in scope => empty result, embedder never consulted', async () => {
    // S4. The semantic candidate pool is "the 200 most recent Observations in
    // scope", every one gets a cosine score, and RRF has no absolute cutoff —
    // so a query about work that never happened here used to come back with a
    // full page of high-similarity noise. Measured on the benchmark dataset:
    // expected-empty queries returned a mean of 8.4 records (worst 10 = the
    // limit) while FTS alone correctly returned 0 for every one of them.
    for (let i = 0; i < 10; i++) {
      seed({ title: `unrelated note ${i}`, stoppedAt: `2026-07-0${i + 1}T00:00:00Z`, embedding: [1, 0, 0, 0] });
    }
    let embedderCalls = 0;
    const results = await hybridSearchObservations(
      db,
      'zzzznomatch',
      { scopeKey: computeScopeKey('/proj', '/proj') },
      { ...TEST_VECTOR_SPACE, generateEmbedding: async () => { embedderCalls++; return new Float32Array([1, 0, 0, 0]); } },
    );

    // Every stored vector is a perfect cosine match for the query vector, so
    // without the anchor rule all 10 would rank and be returned.
    expect(results).toEqual([]);
    // Short-circuits before the embedding call: no lexical anchor means there is
    // nothing to rerank and nothing we are willing to guess.
    expect(embedderCalls).toBe(0);
  });

  test('an FTS anchor still admits semantic-only records (reranking is not disabled)', async () => {
    const anchor = seed({ title: 'epsilon anchor', stoppedAt: '2026-07-01T00:00:00Z' });
    const semOnly = seed({ title: 'no shared words here', stoppedAt: '2026-07-02T00:00:00Z', embedding: [1, 0, 0, 0] });

    const results = await hybridSearchObservations(db, 'epsilon', { scopeKey: computeScopeKey('/proj', '/proj'), semanticQueryEn: 'epsilon' }, { ...TEST_VECTOR_SPACE, generateEmbedding: queryVec });
    const ids = results.map((r) => r.id);
    expect(ids).toContain(anchor);
    expect(ids).toContain(semOnly);
    expect(results.find((r) => r.id === semOnly)!.match_source).toBe('semantic');
  });

  test('a hanging embedder with no FTS hit returns empty without waiting for the timeout', async () => {
    seed({ title: 'unrelated content', stoppedAt: '2026-07-01T00:00:00Z', embedding: [1, 0, 0, 0] });
    const started = performance.now();
    const results = await hybridSearchObservations(
      db,
      'missing marker',
      { scopeKey: computeScopeKey('/proj', '/proj') },
      { ...TEST_VECTOR_SPACE, generateEmbedding: () => new Promise<Float32Array>(() => {}), embeddingTimeoutMs: 5000 },
    );
    expect(results).toEqual([]);
    // The anchor rule returns before the embedder is awaited, so a 5s deadline
    // is never paid.
    expect(performance.now() - started).toBeLessThan(500);
  });

  test('type filter also applies to pure semantic candidates', async () => {
    const wanted = seed({ title: 'typed alpha bug', type: 'bugfix', stoppedAt: '2026-07-01T00:00:00Z', embedding: [1, 0, 0, 0] });
    seed({ title: 'unrelated feature', type: 'feature', stoppedAt: '2026-07-02T00:00:00Z', embedding: [1, 0, 0, 0] });

    const results = await hybridSearchObservations(
      db,
      'typed alpha',
      { scopeKey: computeScopeKey('/proj', '/proj'), type: 'bugfix' },
      { ...TEST_VECTOR_SPACE, generateEmbedding: queryVec },
    );
    expect(results.map((r) => r.id)).toEqual([wanted]);
    expect(results.every((r) => r.memory_type === 'bugfix')).toBe(true);
  });
});
