/**
 * Integration test using the REAL production createApp() from worker.ts.
 * Tests exercise actual Hono routes with all production logic (shouldSkip,
 * stripPrivateTags, detectRepo, onError) — only the DB and compressor are
 * injected for isolation.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { MemoryDB } from '../../src/db';
import { Compressor } from '../../src/compressor';
import { createApp } from '../../src/server/worker';
import { FakeCompressorProvider } from '../support/fake-compressor';
import { openInMemoryDB } from '../support/tmp-db';
import { loadConfig } from '../../src/config';
import type { Hono } from 'hono';

let db: MemoryDB;
let app: Hono;

function post(path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  db = openInMemoryDB();
  const fakeProvider = new FakeCompressorProvider();
  const compressor = new Compressor(fakeProvider);
  const config = loadConfig();
  const result = createApp({ db, compressor, config, enableEmbeddings: false, enableAuth: false });
  app = result.app;
});
afterEach(() => { db.close(); });

describe('Integration / real createApp — full ingest cycle', () => {
  test('prompt → observation → stop → turn closed + job enqueued', async () => {
    const r1 = await post('/events/prompt', { session_id: 'S1', cwd: '/tmp', prompt: 'fix bug' });
    expect(r1.status).toBe(200);
    const j1 = await r1.json() as any;
    expect(j1.ok).toBe(true);
    const turnId = j1.turn_id;

    const r2 = await post('/events/observation', { session_id: 'S1', tool_name: 'read', tool_input: { path: '/a.ts' }, tool_response: 'code' });
    expect(r2.status).toBe(202);

    const r3 = await post('/events/stop', { session_id: 'S1' });
    expect(r3.status).toBe(200);
    expect((await r3.json() as any).turn_id).toBe(turnId);

    const turn = db.getTurn(turnId)!;
    expect(turn.state).toBe('closed');
    expect(turn.tool_event_count).toBe(1);
    expect(db.listTurnEvents(turnId).length).toBe(3);

    const jobs = db.listJobsByState('pending');
    expect(jobs.length).toBe(1);
    expect(jobs[0]!.job_type).toBe('summarize_turn');
  });

  test('missing session_id → quarantined, no DB writes', async () => {
    const r = await post('/events/observation', { tool_name: 'write', tool_input: {}, tool_response: '' });
    expect(r.status).toBe(200);
    expect((await r.json() as any).quarantined).toBe(true);

    const cnt = (db.raw.query('SELECT COUNT(*) AS c FROM turns').get() as any).c;
    expect(cnt).toBe(0);
  });

  test('shouldSkip filters configured tools', async () => {
    // 'introspect' is in default skipTools
    await post('/events/prompt', { session_id: 'S1', cwd: '/tmp', prompt: 'hi' });
    const r = await post('/events/observation', { session_id: 'S1', tool_name: 'introspect', tool_input: {}, tool_response: '' });
    expect(r.status).toBe(200);
    expect((await r.json() as any).skipped).toBe(true);

    // @kiro-mem/* pattern
    const r2 = await post('/events/observation', { session_id: 'S1', tool_name: '@kiro-mem/search', tool_input: {}, tool_response: '' });
    expect((await r2.json() as any).skipped).toBe(true);
  });

  test('stripPrivateTags redacts <private> content', async () => {
    await post('/events/prompt', { session_id: 'S1', cwd: '/tmp', prompt: '<private>secret</private> visible' });
    const turn = db.getOpenTurnBySession('S1')!;
    expect(turn.prompt_text).toBe('[REDACTED] visible');
  });

  test('two sessions same cwd → fully isolated', async () => {
    await post('/events/prompt', { session_id: 'A', cwd: '/tmp', prompt: 'task A' });
    await post('/events/prompt', { session_id: 'B', cwd: '/tmp', prompt: 'task B' });
    await post('/events/observation', { session_id: 'A', tool_name: 'read', tool_input: {}, tool_response: '' });
    await post('/events/observation', { session_id: 'B', tool_name: 'write', tool_input: {}, tool_response: '' });
    await post('/events/stop', { session_id: 'A' });
    await post('/events/stop', { session_id: 'B' });

    const turns = db.raw.query('SELECT * FROM turns ORDER BY id').all() as any[];
    expect(turns.length).toBe(2);
    expect(turns[0].session_id).toBe('A');
    expect(turns[1].session_id).toBe('B');
  });

  test('stale open turn gets job when force-closed by new prompt', async () => {
    const r1 = await post('/events/prompt', { session_id: 'S1', cwd: '/tmp', prompt: 'first' });
    const turn1Id = ((await r1.json()) as any).turn_id;

    const r2 = await post('/events/prompt', { session_id: 'S1', cwd: '/tmp', prompt: 'second' });
    const turn2Id = ((await r2.json()) as any).turn_id;

    expect(db.getTurn(turn1Id)!.state).toBe('closed');
    expect(db.getTurn(turn2Id)!.state).toBe('open');

    const jobs = db.listJobsByState('pending');
    expect(jobs.find(j => j.dedupe_key === `turn:${turn1Id}`)).not.toBeUndefined();
  });

  test('GET /health exposes V3 observability metrics (§12.4)', async () => {
    const r = await app.request('/health');
    expect(r.status).toBe(200);
    const h = (await r.json()) as any;
    expect(h.status).toBe('ok');
    // DB-derived V3 metrics are always present, even on an empty DB.
    expect(h.observations).toEqual({ total: 0, normal: 0, fallback: 0, pinned: 0 });
    expect(h.embeddings).toEqual({ ready: 0, coverage: 0 });
    expect(h.jobs_24h).toEqual({ succeeded: 0, dead: 0 });
    expect(h.search_24h).toEqual({ requests: 0, ftsOnly: 0, degradeRate: 0, latencyMsAvg: 0, latencyMsP95: 0 });
    expect(h.acp_24h).toEqual({ repairs: 0, contaminations: 0 });
    expect(h).toHaveProperty('jobs');
    // The test provider-backed Compressor exposes no runtime stats → acp: null.
    expect(h.acp).toBeNull();
  });

});
