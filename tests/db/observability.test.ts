import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { MemoryDB } from '../../src/db';
import { openInMemoryDB } from '../support/tmp-db';
import { embeddingToBlob } from '../../src/embedding';

let db: MemoryDB;
beforeEach(() => { db = openInMemoryDB(); });
afterEach(() => { db.close(); });

function seedObs(
  quality: 'normal' | 'fallback',
  opts?: { pinned?: boolean; embedded?: boolean },
): number {
  const sid = 's';
  if (!db.getSessionRef(sid)) db.upsertSessionRef({ session_id: sid, cwd: '/x', repo: '/x' });
  const seq = db.allocateNextTurnSeq(sid);
  const turn = db.createTurn({ session_id: sid, seq, cwd: '/x', repo: '/x' });
  db.markTurnClosed(turn.id);
  const id = db.insertObservation({
    turn_id: turn.id, session_id: sid, turn_seq: seq, repo: '/x', cwd_scope: '/x',
    title: 't', summary: 's', memory_type: 'change', quality,
    turn_started_at: '2026-07-14T00:00:00Z', turn_stopped_at: '2026-07-14T00:00:00Z',
  })!;
  if (opts?.pinned) db.pinObservation(id, true);
  if (opts?.embedded) db.upsertObservationEmbedding(id, 'test', 4, embeddingToBlob(new Float32Array([1, 0, 0, 0])));
  return id;
}

describe('getObservabilityStats (§12.4)', () => {
  test('empty DB returns zeros with coverage 0', () => {
    const s = db.getObservabilityStats();
    expect(s.observations).toEqual({ total: 0, normal: 0, fallback: 0, pinned: 0 });
    expect(s.embeddings).toEqual({ ready: 0, coverage: 0 });
    expect(s.jobs).toEqual({ pending: 0, leased: 0, dead: 0 });
    expect(s.jobs24h).toEqual({ succeeded: 0, dead: 0 });
  });

  test('counts normal / fallback / pinned and embedding coverage', () => {
    seedObs('normal', { embedded: true });
    seedObs('normal', { pinned: true });
    seedObs('fallback');
    seedObs('fallback', { embedded: true });
    const s = db.getObservabilityStats();
    expect(s.observations.total).toBe(4);
    expect(s.observations.normal).toBe(2);
    expect(s.observations.fallback).toBe(2);
    expect(s.observations.pinned).toBe(1);
    expect(s.embeddings.ready).toBe(2);
    expect(s.embeddings.coverage).toBe(0.5); // 2/4
  });

  test('jobs are counted by live state', () => {
    db.enqueueJob({ job_type: 'summarize_turn', dedupe_key: 'a', payload_json: '{}' });
    db.enqueueJob({ job_type: 'summarize_turn', dedupe_key: 'b', payload_json: '{}' });
    db.raw.run("UPDATE jobs SET state = 'dead' WHERE dedupe_key = 'b'");
    const s = db.getObservabilityStats();
    expect(s.jobs.pending).toBe(1);
    expect(s.jobs.dead).toBe(1);
  });

  test('jobs24h counts only outcomes within the last 24h', () => {
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const ins = (state: string, updated: string, key: string) =>
      db.raw.run(
        `INSERT INTO jobs (job_type, dedupe_key, payload_json, state, priority, attempts, max_attempts, available_at, created_at, updated_at)
         VALUES ('summarize_turn', ?, '{}', ?, 100, 1, 5, ?, ?, ?)`,
        [key, state, now, now, updated],
      );
    ins('succeeded', now, 'r1');
    ins('succeeded', old, 'r2');
    ins('dead', now, 'r3');
    ins('dead', old, 'r4');
    const s = db.getObservabilityStats();
    expect(s.jobs24h.succeeded).toBe(1);
    expect(s.jobs24h.dead).toBe(1);
    // Live dead count is time-independent: both dead rows counted.
    expect(s.jobs.dead).toBe(2);
  });
});

describe('search / ACP metrics (§12.4, metric_events)', () => {
  test('empty window yields zero rate, latency and acp counts', () => {
    const s = db.getObservabilityStats();
    expect(s.search24h).toEqual({ requests: 0, ftsOnly: 0, degradeRate: 0, latencyMsAvg: 0, latencyMsP95: 0 });
    expect(s.acp24h).toEqual({ repairs: 0, contaminations: 0 });
  });

  test('recordSearchMetric aggregates requests, FTS-only rate and latency', () => {
    db.recordSearchMetric({ latencyMs: 10, degraded: false });
    db.recordSearchMetric({ latencyMs: 20, degraded: true });
    db.recordSearchMetric({ latencyMs: 30, degraded: false });
    db.recordSearchMetric({ latencyMs: 40, degraded: true });
    const s = db.getObservabilityStats();
    expect(s.search24h.requests).toBe(4);
    expect(s.search24h.ftsOnly).toBe(2);
    expect(s.search24h.degradeRate).toBe(0.5);
    expect(s.search24h.latencyMsAvg).toBe(25); // (10+20+30+40)/4
    expect(s.search24h.latencyMsP95).toBe(40); // p95 index → max here
  });

  test('recordAcpEvent counts repair vs contamination separately', () => {
    db.recordAcpEvent('repair');
    db.recordAcpEvent('repair');
    db.recordAcpEvent('contamination');
    const s = db.getObservabilityStats();
    expect(s.acp24h.repairs).toBe(2);
    expect(s.acp24h.contaminations).toBe(1);
  });

  test('events older than 24h are excluded from the window', () => {
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    db.raw.run(
      "INSERT INTO metric_events (kind, degraded, latency_ms, created_at) VALUES ('search', 1, 999, ?)",
      [old],
    );
    db.raw.run(
      "INSERT INTO metric_events (kind, created_at) VALUES ('acp_repair', ?)",
      [old],
    );
    db.recordSearchMetric({ latencyMs: 5, degraded: false });
    const s = db.getObservabilityStats();
    expect(s.search24h.requests).toBe(1); // only the recent search
    expect(s.acp24h.repairs).toBe(0); // the old repair is outside the window
  });
});
