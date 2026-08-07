/**
 * P1-4 — the semantic layer must refuse vectors it cannot compare.
 *
 * A stored blob is only meaningful relative to the model that produced it. When
 * the read path ignored `model` and `dimensions`, a model upgrade or a corrupted
 * blob did not fail — it produced a confident-looking similarity score computed
 * over an unrelated vector space, i.e. a *plausible but wrong* ranking. These
 * tests pin the two guards: version filtering and blob length validation.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { MemoryDB } from '../../src/db';
import { openInMemoryDB } from '../support/tmp-db';
import { hybridSearchObservations } from '../../src/server/observation-search';
import { DIMENSIONS, embeddingToBlob } from '../../src/embedding';
import { RAW_PROTOCOL, SEMANTIC_EN_PROTOCOL, embeddingSpaceKey } from '../../src/semantic-en';

/**
 * The name a stored vector must carry to be readable today.
 *
 * Not `EMBEDDING_MODEL`: since phase 1b the key also names the text
 * normalization protocol, because `raw-v1` and `semantic-en-v1` are both 384
 * dimensions of this same model and are NOT comparable. A row written under the
 * bare model name is therefore an old row, and the tests below treat it exactly
 * like a foreign-model row — unreadable, keyword-reachable only.
 */
const RAW_SPACE_KEY = embeddingSpaceKey(RAW_PROTOCOL);
/** 语义腿唯一会读的空间：raw-v1 降级轮次之后，raw 空间的向量再也不会被比较。 */
const EN_SPACE_KEY = embeddingSpaceKey(SEMANTIC_EN_PROTOCOL);

let db: MemoryDB;
let seq = 0;

function seedObs(title: string): number {
  const session_id = 's1';
  if (!db.getSessionRef(session_id)) {
    db.upsertSessionRef({ session_id, cwd: '/proj', repo: '/proj' });
  }
  const s = db.allocateNextTurnSeq(session_id);
  const turn = db.createTurn({ session_id, seq: s, cwd: '/proj', repo: '/proj' });
  db.markTurnClosed(turn.id);
  const stoppedAt = `2026-07-${String(10 + seq++).padStart(2, '0')}T00:00:00Z`;
  return db.insertObservation({
    turn_id: turn.id, session_id, turn_seq: s, repo: '/proj', cwd_scope: '/proj',
    title, summary: title, memory_type: 'change', quality: 'normal',
    turn_started_at: stoppedAt, turn_stopped_at: stoppedAt,
  })!;
}

function unitVector(dims: number, hot: number): Float32Array {
  const v = new Float32Array(dims);
  v[hot % dims] = 1;
  return v;
}

beforeEach(() => { db = openInMemoryDB(); seq = 0; });
afterEach(() => { db.close(); });

describe('getObservationEmbeddingsByIds — 绑定参数天花板', () => {
  /**
   * SQLite via Bun accepts 65,535 bound parameters and wraps at 65,536.
   *
   * Kept as a boundary pin even though production cannot reach it: the shipped
   * `semanticCandidatePool` is 20,000, so the id list plus two filter params stays
   * far below the ceiling. It matters because the failure mode is silent — the
   * retrieval kernel's catch turns the throw into `onDegrade` + FTS-only, so a
   * future round that raises the pool past ~65,000 would lose semantic recall
   * without an error. This test is the only place that records where the cliff is,
   * and it fails loudly if a future Bun moves it.
   *
   * The pool round measured scope-wide scoring and it did NOT ship (memory, not
   * this ceiling): `benchmark/reports/pool-policy-submission.md` §9.
   */
  test('单条 IN 列表在 65,536 个参数处回绕失败，65,535 个成功', () => {
    const raw = (db as unknown as { db: { query: (s: string) => { all: (...a: unknown[]) => unknown } } }).db;
    const ids = Array.from({ length: 65_536 }, (_, i) => i + 1);
    expect(() =>
      raw.query(`SELECT observation_id FROM observation_embeddings WHERE observation_id IN (${ids.map(() => '?').join(',')})`).all(...ids),
    ).toThrow();
    const under = ids.slice(0, 65_535);
    expect(() =>
      raw.query(`SELECT observation_id FROM observation_embeddings WHERE observation_id IN (${under.map(() => '?').join(',')})`).all(...under),
    ).not.toThrow();
  });
});

describe('getObservationEmbeddingsByIds — version filter', () => {
  test('returns rows written by the current model', () => {
    const id = seedObs('current model');
    db.upsertObservationEmbedding(id, RAW_SPACE_KEY, DIMENSIONS, embeddingToBlob(unitVector(DIMENSIONS, 1)));

    const rows = db.getObservationEmbeddingsByIds([id], { model: RAW_SPACE_KEY, dimensions: DIMENSIONS });
    expect(rows.length).toBe(1);
    expect(rows[0]!.observation_id).toBe(id);
  });

  test('skips a row written by a different model', () => {
    const id = seedObs('other model');
    db.upsertObservationEmbedding(id, 'some-future-model-v9', DIMENSIONS, embeddingToBlob(unitVector(DIMENSIONS, 1)));

    expect(db.getObservationEmbeddingsByIds([id], { model: RAW_SPACE_KEY, dimensions: DIMENSIONS })).toEqual([]);
    // …and is still visible without the filter, so nothing was deleted.
    expect(db.getObservationEmbeddingsByIds([id]).length).toBe(1);
  });

  test('skips a row with a different dimensionality', () => {
    const id = seedObs('other dims');
    db.upsertObservationEmbedding(id, RAW_SPACE_KEY, 768, embeddingToBlob(unitVector(768, 1)));
    expect(db.getObservationEmbeddingsByIds([id], { model: RAW_SPACE_KEY, dimensions: DIMENSIONS })).toEqual([]);
  });

  test('drops a blob whose length contradicts its declared dimensions', () => {
    const id = seedObs('corrupt blob');
    // Claims 384 dims but stores only 100 floats — a truncated write.
    db.upsertObservationEmbedding(id, RAW_SPACE_KEY, DIMENSIONS, embeddingToBlob(new Float32Array(100)));
    expect(db.getObservationEmbeddingsByIds([id], { model: RAW_SPACE_KEY, dimensions: DIMENSIONS })).toEqual([]);
    // The length check applies even with no explicit filter: a partial vector
    // must never reach cosineSimilarity.
    expect(db.getObservationEmbeddingsByIds([id])).toEqual([]);
  });

  test('an empty id list short-circuits', () => {
    expect(db.getObservationEmbeddingsByIds([])).toEqual([]);
  });
});

describe('hybrid search with an incomparable stored vector', () => {
  test('a foreign-model row is not semantically ranked, only FTS-reachable', async () => {
    const foreign = seedObs('vector rotation handling');
    db.upsertObservationEmbedding(foreign, 'some-future-model-v9', DIMENSIONS, embeddingToBlob(unitVector(DIMENSIONS, 5)));

    const results = await hybridSearchObservations(
      db,
      'vector rotation handling',
      // 语义腿只在 semantic-en-v1 空间执行（raw-v1 降级轮次），所以这里必须显式传英文形式，
      // 否则测的就不是"向量可比性"而是"降级路径不打分"。query 本身是英文，护栏允许原样归一。
      { scopeKey: undefined, limit: 10, semanticQueryEn: 'vector rotation handling' },
      { generateEmbedding: async () => unitVector(DIMENSIONS, 5) },
    );

    const hit = results.find((r) => r.id === foreign)!;
    expect(hit).toBeDefined();
    // Reachable by keyword…
    expect(hit.match_source).toBe('fts');
    // …but carries no similarity score, because none could be computed.
    expect(hit.semantic_score).toBeNull();
  });

  test('a current-model row IS semantically ranked', async () => {
    const current = seedObs('vector rotation handling');
    // 写进**英文**空间：语义腿只在 semantic-en-v1 里打分，所以"当前空间"现在指的是它。
    // 原先这里写 raw 空间，那时 raw-v1 查询还会读它；本轮之后 raw 向量永不参与比较。
    db.upsertObservationEmbedding(current, EN_SPACE_KEY, DIMENSIONS, embeddingToBlob(unitVector(DIMENSIONS, 5)));

    const results = await hybridSearchObservations(
      db,
      'vector rotation handling',
      // 语义腿只在 semantic-en-v1 空间执行（raw-v1 降级轮次），所以这里必须显式传英文形式，
      // 否则测的就不是"向量可比性"而是"降级路径不打分"。query 本身是英文，护栏允许原样归一。
      { scopeKey: undefined, limit: 10, semanticQueryEn: 'vector rotation handling' },
      { generateEmbedding: async () => unitVector(DIMENSIONS, 5) },
    );

    const hit = results.find((r) => r.id === current)!;
    expect(hit.match_source).toBe('hybrid');
    expect(hit.semantic_score).toBeGreaterThan(0.9);
  });
});
