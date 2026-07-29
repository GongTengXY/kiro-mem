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
import { EMBEDDING_MODEL, DIMENSIONS, embeddingToBlob } from '../../src/embedding';

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

describe('getObservationEmbeddingsByIds — version filter', () => {
  test('returns rows written by the current model', () => {
    const id = seedObs('current model');
    db.upsertObservationEmbedding(id, EMBEDDING_MODEL, DIMENSIONS, embeddingToBlob(unitVector(DIMENSIONS, 1)));

    const rows = db.getObservationEmbeddingsByIds([id], { model: EMBEDDING_MODEL, dimensions: DIMENSIONS });
    expect(rows.length).toBe(1);
    expect(rows[0]!.observation_id).toBe(id);
  });

  test('skips a row written by a different model', () => {
    const id = seedObs('other model');
    db.upsertObservationEmbedding(id, 'some-future-model-v9', DIMENSIONS, embeddingToBlob(unitVector(DIMENSIONS, 1)));

    expect(db.getObservationEmbeddingsByIds([id], { model: EMBEDDING_MODEL, dimensions: DIMENSIONS })).toEqual([]);
    // …and is still visible without the filter, so nothing was deleted.
    expect(db.getObservationEmbeddingsByIds([id]).length).toBe(1);
  });

  test('skips a row with a different dimensionality', () => {
    const id = seedObs('other dims');
    db.upsertObservationEmbedding(id, EMBEDDING_MODEL, 768, embeddingToBlob(unitVector(768, 1)));
    expect(db.getObservationEmbeddingsByIds([id], { model: EMBEDDING_MODEL, dimensions: DIMENSIONS })).toEqual([]);
  });

  test('drops a blob whose length contradicts its declared dimensions', () => {
    const id = seedObs('corrupt blob');
    // Claims 384 dims but stores only 100 floats — a truncated write.
    db.upsertObservationEmbedding(id, EMBEDDING_MODEL, DIMENSIONS, embeddingToBlob(new Float32Array(100)));
    expect(db.getObservationEmbeddingsByIds([id], { model: EMBEDDING_MODEL, dimensions: DIMENSIONS })).toEqual([]);
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
      { scopeKey: undefined, limit: 10 },
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
    db.upsertObservationEmbedding(current, EMBEDDING_MODEL, DIMENSIONS, embeddingToBlob(unitVector(DIMENSIONS, 5)));

    const results = await hybridSearchObservations(
      db,
      'vector rotation handling',
      { scopeKey: undefined, limit: 10 },
      { generateEmbedding: async () => unitVector(DIMENSIONS, 5) },
    );

    const hit = results.find((r) => r.id === current)!;
    expect(hit.match_source).toBe('hybrid');
    expect(hit.semantic_score).toBeGreaterThan(0.9);
  });
});
