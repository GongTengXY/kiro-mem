/**
 * P0-5: the Truth Layer → projection lifecycle must be recoverable.
 *
 * Two failure modes had no recovery path before this:
 *   1. A crash or SQLITE_BUSY between "close the turn" and "enqueue summarize"
 *      left a closed turn with no job, so it never produced an Observation.
 *   2. A summarize job that reached `dead` held its dedupe key forever (the
 *      unique index was cross-state), so re-enqueueing was silently swallowed
 *      and that turn was permanently missing from memory.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { MemoryDB } from '../../src/db';
import { openInMemoryDB } from '../support/tmp-db';
import { createApp } from '../../src/server/worker';
import { ACPCompressor } from '../../src/acp/compressor';
import { FakeACPPool } from '../support/fake-acp-pool';
import { loadConfig } from '../../src/config';
import type { Hono } from 'hono';

let db: MemoryDB;
let app: Hono;

beforeEach(() => {
  db = openInMemoryDB();
  const config = loadConfig();
  ({ app } = createApp({
    db,
    compressor: new ACPCompressor({}, new FakeACPPool()),
    config,
    enableEmbeddings: false,
    enableAuth: false,
  }));
});
afterEach(() => { db.close(); });

const post = (path: string, body: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

/** A closed turn created directly, bypassing the ingest route. */
function seedClosedTurn(sessionId: string): number {
  db.upsertSessionRef({ session_id: sessionId, cwd: '/proj-p05', repo: null });
  const seq = db.allocateNextTurnSeq(sessionId);
  const turn = db.createTurn({ session_id: sessionId, seq, cwd: '/proj-p05', repo: null, prompt_text: 'work' });
  db.markTurnClosed(turn.id);
  return turn.id;
}

function seedObservation(turnId: number, sessionId: string): number {
  const turn = db.getTurn(turnId)!;
  return db.insertObservation({
    turn_id: turnId,
    session_id: sessionId,
    turn_seq: turn.seq,
    repo: null,
    cwd_scope: '/proj-p05',
    title: 'seeded',
    summary: 'seeded',
    memory_type: 'change',
    quality: 'normal',
    turn_started_at: turn.started_at,
    turn_stopped_at: new Date().toISOString(),
  })!;
}

/**
 * 测试固定的"当前向量空间"。findOrphans 要求显式声明它，因为宽松的默认值
 * 正是 stale-vector 那一类孤儿长期没被发现的原因。
 */
const VECTOR = { embeddingModel: 'test-model', embeddingDimensions: 4 };

describe('busy_timeout is configured', () => {
  test('the connection sets a non-zero busy timeout', () => {
    const value = db.raw.query('PRAGMA busy_timeout').get() as { timeout: number };
    expect(value.timeout).toBeGreaterThan(0);
  });
});

describe('stop close-out is transactional', () => {
  test('closing a turn and enqueueing its summarize job land together', async () => {
    await post('/events/prompt', { session_id: 'S1', cwd: '/proj-p05', prompt: 'task' });
    const turnId = db.getOpenTurnBySession('S1')!.id;

    await post('/events/stop', { session_id: 'S1', assistant_response: 'done' });

    expect(db.getTurn(turnId)!.state).toBe('closed');
    const jobs = db.listJobsByState('pending').filter((j) => j.dedupe_key === `turn:${turnId}`);
    expect(jobs.length).toBe(1);
    // No orphan: closed turn AND an active job for it.
    expect(db.findOrphans(VECTOR).turnsWithoutObservation).not.toContain(turnId);
  });
});

describe('dedupe no longer blocks recovery after a terminal state', () => {
  test('an active job still dedupes a second enqueue', () => {
    const turnId = seedClosedTurn('S2');
    const first = db.enqueueJob({
      job_type: 'summarize_turn', dedupe_key: `turn:${turnId}`,
      entity_type: 'turn', entity_id: String(turnId),
      payload_json: JSON.stringify({ turn_id: turnId }),
    });
    const second = db.enqueueJob({
      job_type: 'summarize_turn', dedupe_key: `turn:${turnId}`,
      entity_type: 'turn', entity_id: String(turnId),
      payload_json: JSON.stringify({ turn_id: turnId }),
    });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  test('a dead job no longer holds the dedupe key hostage', () => {
    const turnId = seedClosedTurn('S3');
    const job = db.enqueueJob({
      job_type: 'summarize_turn', dedupe_key: `turn:${turnId}`,
      entity_type: 'turn', entity_id: String(turnId),
      payload_json: JSON.stringify({ turn_id: turnId }),
    })!;
    db.raw.run("UPDATE jobs SET state = 'dead', last_error = 'boom' WHERE id = ?", [job.id]);

    const retry = db.enqueueJob({
      job_type: 'summarize_turn', dedupe_key: `turn:${turnId}`,
      entity_type: 'turn', entity_id: String(turnId),
      payload_json: JSON.stringify({ turn_id: turnId }),
    });
    expect(retry).not.toBeNull();

    // The dead row survives: it is the only record of WHY it failed.
    const dead = db.listJobsByState('dead');
    expect(dead.length).toBe(1);
    expect(dead[0]!.last_error).toBe('boom');
  });
});

describe('findOrphans / requeueOrphans', () => {
  test('a closed turn with no Observation and no active job is an orphan', () => {
    const turnId = seedClosedTurn('S4');
    expect(db.findOrphans(VECTOR).turnsWithoutObservation).toEqual([turnId]);
  });

  test('an open turn is not an orphan', () => {
    db.upsertSessionRef({ session_id: 'S5', cwd: '/proj-p05', repo: null });
    const seq = db.allocateNextTurnSeq('S5');
    db.createTurn({ session_id: 'S5', seq, cwd: '/proj-p05', repo: null, prompt_text: 'open' });
    expect(db.findOrphans(VECTOR).turnsWithoutObservation).toEqual([]);
  });

  test('a closed turn with a pending job is not an orphan', () => {
    const turnId = seedClosedTurn('S6');
    db.enqueueJob({
      job_type: 'summarize_turn', dedupe_key: `turn:${turnId}`,
      entity_type: 'turn', entity_id: String(turnId),
      payload_json: JSON.stringify({ turn_id: turnId }),
    });
    expect(db.findOrphans(VECTOR).turnsWithoutObservation).toEqual([]);
  });

  test('a closed turn whose job died IS an orphan and gets re-queued', () => {
    const turnId = seedClosedTurn('S7');
    const job = db.enqueueJob({
      job_type: 'summarize_turn', dedupe_key: `turn:${turnId}`,
      entity_type: 'turn', entity_id: String(turnId),
      payload_json: JSON.stringify({ turn_id: turnId }),
    })!;
    db.raw.run("UPDATE jobs SET state = 'dead' WHERE id = ?", [job.id]);

    expect(db.findOrphans(VECTOR).turnsWithoutObservation).toEqual([turnId]);
    expect(db.requeueOrphans(VECTOR)).toEqual({ summarize: 1, embed: 0 });
    expect(db.findOrphans(VECTOR).turnsWithoutObservation).toEqual([]);
  });

  test('an Observation with no embedding and no active job is an orphan', () => {
    const turnId = seedClosedTurn('S8');
    const observationId = seedObservation(turnId, 'S8');
    expect(db.findOrphans(VECTOR).observationsWithoutEmbedding).toEqual([observationId]);

    expect(db.requeueOrphans(VECTOR)).toEqual({ summarize: 0, embed: 1 });
    const queued = db.listJobsByState('pending').filter((j) => j.dedupe_key === `embed:obs:${observationId}`);
    expect(queued.length).toBe(1);
  });

  test('an Observation that already has an embedding is not an orphan', () => {
    const turnId = seedClosedTurn('S9');
    const observationId = seedObservation(turnId, 'S9');
    db.upsertObservationEmbedding(
      observationId,
      'test-model',
      4,
      Buffer.from(new Float32Array([1, 0, 0, 0]).buffer),
    );
    expect(db.findOrphans(VECTOR).observationsWithoutEmbedding).toEqual([]);
  });

  // --- stale vectors（换 embedding 模型后的恢复路径）---
  //
  // P1-4 让检索层跳过跨模型的向量，这是诚实的降级；但第一版的孤儿判定只看
  // "有没有向量行"，于是换一次模型后旧向量既不可用、又永远不会被重建——
  // `kiro-mem repair` 会报告一切正常。这三条钉住"不可用 = 需要重建"。

  test('a vector written by another model counts as needing a rebuild', () => {
    const turnId = seedClosedTurn('S12');
    const observationId = seedObservation(turnId, 'S12');
    db.upsertObservationEmbedding(
      observationId,
      'some-older-model',
      4,
      Buffer.from(new Float32Array([1, 0, 0, 0]).buffer),
    );

    expect(db.findOrphans(VECTOR).observationsWithoutEmbedding).toEqual([observationId]);
    expect(db.requeueOrphans(VECTOR)).toEqual({ summarize: 0, embed: 1 });
    // 排上队之后不再重复报告，避免 repair 反复堆积同一条 job。
    expect(db.findOrphans(VECTOR).observationsWithoutEmbedding).toEqual([]);
  });

  test('a vector with the wrong dimensionality counts as needing a rebuild', () => {
    const turnId = seedClosedTurn('S13');
    const observationId = seedObservation(turnId, 'S13');
    db.upsertObservationEmbedding(
      observationId,
      'test-model',
      8,
      Buffer.from(new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]).buffer),
    );
    expect(db.findOrphans(VECTOR).observationsWithoutEmbedding).toEqual([observationId]);
  });

  test('a truncated blob counts as needing a rebuild', () => {
    const turnId = seedClosedTurn('S14');
    const observationId = seedObservation(turnId, 'S14');
    // 声明 4 维但只存了 2 个 float：读取侧会因字节长度校验跳过它。
    db.upsertObservationEmbedding(
      observationId,
      'test-model',
      4,
      Buffer.from(new Float32Array([1, 0]).buffer),
    );
    expect(db.findOrphans(VECTOR).observationsWithoutEmbedding).toEqual([observationId]);
  });

  test('the requeued embed job actually replaces the stale vector', async () => {
    // 光识别出来不算恢复。embed job 原来的幂等判断是"有行就返回"，那会让重排的
    // job 立刻空转——识别到了、排了队、什么也没变。
    const localDb = openInMemoryDB();
    const { EMBEDDING_MODEL, DIMENSIONS } = await import('../../src/embedding');
    const fresh = new Float32Array(DIMENSIONS).fill(0);
    fresh[0] = 1;
    const local = createApp({
      db: localDb,
      compressor: new ACPCompressor({}, new FakeACPPool()),
      config: loadConfig(),
      enableEmbeddings: true,
      embeddingGenerator: async () => fresh,
      enableAuth: false,
    });

    localDb.upsertSessionRef({ session_id: 'S15', cwd: '/proj-stale', repo: null });
    const seq = localDb.allocateNextTurnSeq('S15');
    const turn = localDb.createTurn({ session_id: 'S15', seq, cwd: '/proj-stale', repo: null, prompt_text: 'stale vector' });
    localDb.markTurnClosed(turn.id);
    const observationId = localDb.insertObservation({
      turn_id: turn.id, session_id: 'S15', turn_seq: seq, repo: null, cwd_scope: '/proj-stale',
      title: 'stale vector rebuild', summary: 'stale vector rebuild',
      memory_type: 'change', quality: 'normal',
      turn_started_at: turn.started_at, turn_stopped_at: new Date().toISOString(),
    })!;
    localDb.upsertObservationEmbedding(observationId, 'some-older-model', 4, Buffer.from(new Float32Array([1, 0, 0, 0]).buffer));

    const vector = { embeddingModel: EMBEDDING_MODEL, embeddingDimensions: DIMENSIONS };
    expect(localDb.findOrphans(vector).observationsWithoutEmbedding).toEqual([observationId]);
    expect(localDb.requeueOrphans(vector).embed).toBe(1);

    local.jobRunner.start();
    try {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        if (localDb.getObservationEmbedding(observationId)?.model === EMBEDDING_MODEL) break;
        await new Promise((r) => setTimeout(r, 20));
      }
    } finally {
      local.jobRunner.stop();
    }

    const row = localDb.getObservationEmbedding(observationId)!;
    expect(row.dimensions).toBe(DIMENSIONS);
    expect(row.embedding.byteLength).toBe(DIMENSIONS * 4);
    expect(localDb.findOrphans(vector).observationsWithoutEmbedding).toEqual([]);
    localDb.close();
  });

  test('requeueOrphans is idempotent', () => {
    seedClosedTurn('S10');
    expect(db.requeueOrphans(VECTOR).summarize).toBe(1);
    expect(db.requeueOrphans(VECTOR)).toEqual({ summarize: 0, embed: 0 });
    expect(db.listJobsByState('pending').length).toBe(1);
  });

  test('a healthy database reports nothing to repair', async () => {
    await post('/events/prompt', { session_id: 'S11', cwd: '/proj-p05', prompt: 'task' });
    await post('/events/stop', { session_id: 'S11', assistant_response: 'done' });
    expect(db.findOrphans(VECTOR)).toEqual({ turnsWithoutObservation: [], observationsWithoutEmbedding: [] });
  });
});
