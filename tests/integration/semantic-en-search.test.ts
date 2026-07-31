/**
 * Phase 1b product-form invariants (plan §5.4 / §5.5 gates 1 & 3).
 *
 * What these pin down, in order of how badly each would fail silently:
 *
 *  1. A raw query is NEVER scored against `semantic-en-v1` vectors, and an
 *     English query is never scored against `raw-v1` ones. The measured cost of
 *     getting this wrong is MRR 0.437 vs a 0.529 baseline — worse than not
 *     translating at all, and completely invisible at read time.
 *  2. A refused English query degrades the search; it does not fail it.
 *  3. A refused derived value leaves the Observation without an English vector
 *     and says so in `observation_semantic_texts`, rather than embedding the bad
 *     translation.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { MemoryDB, computeScopeKey } from '../../src/db';
import { openInMemoryDB } from '../support/tmp-db';
import { embeddingToBlob, DIMENSIONS } from '../../src/embedding-space';
import { hybridSearchObservations } from '../../src/server/observation-search';
import {
  RAW_PROTOCOL,
  SEMANTIC_EN_PROTOCOL,
  embeddingSpaceKey,
  type NormalizationProtocol,
} from '../../src/semantic-en';

const RAW_SPACE = embeddingSpaceKey(RAW_PROTOCOL);
const EN_SPACE = embeddingSpaceKey(SEMANTIC_EN_PROTOCOL);
const SCOPE = computeScopeKey('/proj', '/proj');

let db: MemoryDB;
let seq = 0;

beforeEach(() => { db = openInMemoryDB(); seq = 0; });
afterEach(() => { db.close(); });

function unit(hot: number): Float32Array {
  const v = new Float32Array(DIMENSIONS);
  v[hot % DIMENSIONS] = 1;
  return v;
}

/** Seed an Observation, optionally with a vector in each protocol space. */
function seed(o: {
  title: string;
  rawHot?: number;
  enHot?: number;
}): number {
  const session_id = 's1';
  if (!db.getSessionRef(session_id)) {
    db.upsertSessionRef({ session_id, cwd: '/proj', repo: '/proj' });
  }
  const s = db.allocateNextTurnSeq(session_id);
  const turn = db.createTurn({ session_id, seq: s, cwd: '/proj', repo: '/proj' });
  db.markTurnClosed(turn.id);
  const stoppedAt = `2026-07-${String(10 + seq++).padStart(2, '0')}T00:00:00Z`;
  const id = db.insertObservation({
    turn_id: turn.id, session_id, turn_seq: s, repo: '/proj', cwd_scope: '/proj',
    title: o.title, summary: o.title, memory_type: 'change', quality: 'normal',
    turn_started_at: stoppedAt, turn_stopped_at: stoppedAt,
  })!;
  if (o.rawHot !== undefined) {
    db.upsertObservationEmbedding(id, RAW_SPACE, DIMENSIONS, embeddingToBlob(unit(o.rawHot)));
  }
  if (o.enHot !== undefined) {
    db.upsertObservationEmbedding(id, EN_SPACE, DIMENSIONS, embeddingToBlob(unit(o.enHot)));
  }
  return id;
}

async function search(query: string, semanticQueryEn: string | undefined, hot: number) {
  let protocol: NormalizationProtocol | null = null;
  let rejected: string | null = null;
  const embedded: string[] = [];
  const results = await hybridSearchObservations(
    db,
    query,
    { scopeKey: SCOPE, limit: 10, semanticQueryEn },
    {
      generateEmbedding: async (text) => { embedded.push(text); return unit(hot); },
      onCandidates: (info) => {
        protocol = info.protocol;
        rejected = info.semanticQueryRejected;
      },
    },
  );
  return {
    results,
    // Assigned inside a callback, which the compiler cannot follow — restate the
    // declared type rather than letting it narrow to `null`.
    protocol: protocol as NormalizationProtocol | null,
    rejected: rejected as string | null,
    embedded,
  };
}

describe('protocol isolation in hybrid search', () => {
  test('an English query only scores semantic-en-v1 vectors', async () => {
    // Both records carry the SAME vector, one in each space. If the space key
    // were ignored, both would rank; the whole point is that only one can.
    const enOnly = seed({ title: 'alpha english leg', enHot: 3 });
    const rawOnly = seed({ title: 'alpha raw leg', rawHot: 3 });

    const { results, protocol } = await search('alpha 检索', 'alpha retrieval', 3);
    expect(protocol).toBe(SEMANTIC_EN_PROTOCOL);
    const scored = results.filter((r) => r.semantic_score != null).map((r) => r.id);
    expect(scored).toEqual([enOnly]);
    // The raw-only record is still keyword-reachable — degraded, not deleted.
    expect(results.map((r) => r.id)).toContain(rawOnly);
    expect(results.find((r) => r.id === rawOnly)!.semantic_score).toBeNull();
  });

  test('a query with no English form only scores raw-v1 vectors', async () => {
    const enOnly = seed({ title: 'beta english leg', enHot: 4 });
    const rawOnly = seed({ title: 'beta raw leg', rawHot: 4 });

    const { results, protocol } = await search('beta 检索', undefined, 4);
    expect(protocol).toBe(RAW_PROTOCOL);
    const scored = results.filter((r) => r.semantic_score != null).map((r) => r.id);
    expect(scored).toEqual([rawOnly]);
    expect(results.find((r) => r.id === enOnly)!.semantic_score).toBeNull();
  });

  test('the embedded text is the English one exactly when the English space is used', async () => {
    seed({ title: 'gamma record', enHot: 5, rawHot: 5 });

    const withEn = await search('gamma 中文问题', 'gamma english question', 5);
    expect(withEn.embedded).toEqual(['gamma english question']);

    const withoutEn = await search('gamma 中文问题', undefined, 5);
    expect(withoutEn.embedded).toEqual(['gamma 中文问题']);
  });

  test('a refused English query falls back to raw-v1 instead of failing', async () => {
    const rawOnly = seed({ title: 'delta raw leg', rawHot: 6 });
    seed({ title: 'delta english leg', enHot: 6 });

    // `...` is the exact phase 1a q16 failure.
    const { results, protocol, rejected } = await search('delta 问题', '...', 6);
    expect(protocol).toBe(RAW_PROTOCOL);
    expect(rejected).toBe('placeholder');
    expect(results.filter((r) => r.semantic_score != null).map((r) => r.id)).toEqual([rawOnly]);
  });

  test('echoing the Chinese query as its own English form is refused, not embedded', async () => {
    seed({ title: 'epsilon record', enHot: 7 });
    const zh = 'epsilon 为什么搜不到';
    const { protocol, rejected } = await search(zh, zh, 7);
    expect(protocol).toBe(RAW_PROTOCOL);
    expect(rejected).toBe('untranslated');
  });

  test('the two spaces coexist for one Observation without overwriting each other', () => {
    const id = seed({ title: 'zeta both legs', rawHot: 1, enHot: 2 });
    expect(db.getObservationEmbedding(id, RAW_SPACE)).not.toBeNull();
    expect(db.getObservationEmbedding(id, EN_SPACE)).not.toBeNull();
    const stats = db.getObservabilityStats();
    expect(stats.embeddings.byProtocol).toEqual([
      { protocol: 'raw-v1', spaceKey: RAW_SPACE, ready: 1, coverage: 1 },
      { protocol: 'semantic-en-v1', spaceKey: EN_SPACE, ready: 1, coverage: 1 },
    ]);
    // One Observation, two vectors: coverage must not read 2.0.
    expect(stats.embeddings.ready).toBe(1);
    expect(stats.embeddings.coverage).toBe(1);
  });
});

describe('derived-value lifecycle', () => {
  test('a ready row is not downgraded by a later failure', () => {
    const id = seed({ title: 'eta record' });
    db.upsertObservationSemanticText({
      observation_id: id,
      protocol: SEMANTIC_EN_PROTOCOL,
      status: 'ready',
      payload: { title: 'Eta record', summary: 'Eta record', outcome: '', learned: '', concepts: [] },
      translator: 'test',
      attempts: 1,
    });
    db.upsertObservationSemanticText({
      observation_id: id,
      protocol: SEMANTIC_EN_PROTOCOL,
      status: 'failed',
      translator: 'test',
      attempts: 2,
      failure_reason: 'placeholder',
    });
    const row = db.getObservationSemanticText(id, SEMANTIC_EN_PROTOCOL)!;
    expect(row.status).toBe('ready');
    expect(row.payload_json).toContain('Eta record');
  });

  test('pending and failed are counted separately (queue backlog vs protocol violation)', () => {
    const a = seed({ title: 'theta a' });
    const b = seed({ title: 'theta b' });
    db.upsertObservationSemanticText({
      observation_id: a, protocol: SEMANTIC_EN_PROTOCOL, status: 'pending',
      translator: 'test', attempts: 1, failure_reason: 'translator_unavailable:not_object',
    });
    db.upsertObservationSemanticText({
      observation_id: b, protocol: SEMANTIC_EN_PROTOCOL, status: 'failed',
      translator: 'test', attempts: 2, failure_reason: 'placeholder|placeholder:summary',
    });
    expect(db.getObservabilityStats().embeddings.semanticEn).toEqual({
      ready: 0, pending: 1, failed: 1,
    });
  });

  test('a payload is only stored for a ready row', () => {
    const id = seed({ title: 'iota record' });
    db.upsertObservationSemanticText({
      observation_id: id, protocol: SEMANTIC_EN_PROTOCOL, status: 'pending',
      payload: { title: 'x', summary: 'y', outcome: '', learned: '', concepts: [] },
      translator: 'test',
    });
    expect(db.getObservationSemanticText(id, SEMANTIC_EN_PROTOCOL)!.payload_json).toBeNull();
  });
});
