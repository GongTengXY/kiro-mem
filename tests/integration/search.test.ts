import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { MemoryDB, computeScopeKey } from '../../src/db';
import { openInMemoryDB } from '../support/tmp-db';
import { embeddingToBlob } from '../../src/embedding';
import { hybridSearchObservations } from '../../src/server/observation-search';

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

// Deterministic embedder: query vector always [1,0,0,0]; cosine == dot product.
const queryVec = async () => new Float32Array([1, 0, 0, 0]);

describe('hybridSearchObservations', () => {
  test('RRF ranks a hit matched by BOTH fts and semantic above single-source hits', async () => {
    const both = seed({ title: 'alpha work', stoppedAt: '2026-07-01T00:00:00Z', embedding: [1, 0, 0, 0] });
    const ftsOnly = seed({ title: 'alpha task', stoppedAt: '2026-07-02T00:00:00Z' });
    const semOnly = seed({ title: 'beta thing', stoppedAt: '2026-07-03T00:00:00Z', embedding: [1, 0, 0, 0] });

    const results = await hybridSearchObservations(db, 'alpha', { scopeKey: computeScopeKey('/proj', '/proj') }, { generateEmbedding: queryVec });
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

    const results = await hybridSearchObservations(db, 'alpha', { scopeKey: computeScopeKey('/repoA', '/repoA') }, { generateEmbedding: queryVec });
    expect(results.length).toBe(1);
    expect(results[0]!.repo).toBe('/repoA');
    expect(results.map((r) => r.id)).not.toContain(inB);
  });

  test('degrades to FTS-only when the embedder throws', async () => {
    const hit = seed({ title: 'gamma work', stoppedAt: '2026-07-01T00:00:00Z', embedding: [1, 0, 0, 0] });
    const throwing = async () => { throw new Error('model unavailable'); };

    const results = await hybridSearchObservations(db, 'gamma', { scopeKey: computeScopeKey('/proj', '/proj') }, { generateEmbedding: throwing });
    expect(results.length).toBe(1);
    expect(results[0]!.id).toBe(hit);
    expect(results[0]!.match_source).toBe('fts'); // no semantic contribution
    expect(results[0]!.semantic_score).toBeNull();
  });

  test('tie-break: equal RRF score prefers the more recent turn_stopped_at', async () => {
    // obsX: fts-only rank 1. obsY: semantic-only rank 1. Both RRF = 1/(60+1) → tie.
    const older = seed({ title: 'gamma only fts', stoppedAt: '2026-07-01T00:00:00Z' });
    const newer = seed({ title: 'delta only semantic', stoppedAt: '2026-07-05T00:00:00Z', embedding: [1, 0, 0, 0] });

    const results = await hybridSearchObservations(db, 'gamma', { scopeKey: computeScopeKey('/proj', '/proj') }, { generateEmbedding: queryVec });
    expect(results.length).toBe(2);
    // Tie broken toward the newer observation.
    expect(results[0]!.id).toBe(newer);
    expect(results[1]!.id).toBe(older);
  });

  test('empty candidate set returns []', async () => {
    seed({ title: 'nothing relevant', stoppedAt: '2026-07-01T00:00:00Z' });
    const results = await hybridSearchObservations(db, 'zzzznomatch', { scopeKey: computeScopeKey('/proj', '/proj') }, { generateEmbedding: async () => new Float32Array([0, 0, 0, 1]) });
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
      { scopeKey: computeScopeKey('/proj', '/proj') },
      { generateEmbedding: never, embeddingTimeoutMs: 20, onDegrade: () => { degraded++; } },
    );

    expect(performance.now() - started).toBeLessThan(250);
    expect(results.map((r) => r.id)).toEqual([hit]);
    expect(results[0]!.match_source).toBe('fts');
    expect(degraded).toBe(1);
  });

  test('a hanging embedder with no FTS hit returns an empty result after timeout', async () => {
    seed({ title: 'unrelated content', stoppedAt: '2026-07-01T00:00:00Z', embedding: [1, 0, 0, 0] });
    const results = await hybridSearchObservations(
      db,
      'missing marker',
      { scopeKey: computeScopeKey('/proj', '/proj') },
      { generateEmbedding: () => new Promise<Float32Array>(() => {}), embeddingTimeoutMs: 20 },
    );
    expect(results).toEqual([]);
  });

  test('type filter also applies to pure semantic candidates', async () => {
    const wanted = seed({ title: 'typed alpha bug', type: 'bugfix', stoppedAt: '2026-07-01T00:00:00Z', embedding: [1, 0, 0, 0] });
    seed({ title: 'unrelated feature', type: 'feature', stoppedAt: '2026-07-02T00:00:00Z', embedding: [1, 0, 0, 0] });

    const results = await hybridSearchObservations(
      db,
      'typed alpha',
      { scopeKey: computeScopeKey('/proj', '/proj'), type: 'bugfix' },
      { generateEmbedding: queryVec },
    );
    expect(results.map((r) => r.id)).toEqual([wanted]);
    expect(results.every((r) => r.memory_type === 'bugfix')).toBe(true);
  });
});
