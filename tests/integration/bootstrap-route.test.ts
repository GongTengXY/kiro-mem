import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MemoryDB } from '../../src/db';
import { Compressor } from '../../src/compressor';
import { createApp } from '../../src/server/worker';
import { FakeCompressorProvider } from '../support/fake-compressor';
import { openInMemoryDB } from '../support/tmp-db';
import { loadConfig } from '../../src/config';
import type { Hono } from 'hono';

let db: MemoryDB;
let app: Hono;
let dir: string;

beforeEach(() => {
  db = openInMemoryDB();
  const result = createApp({
    db,
    compressor: new Compressor(new FakeCompressorProvider()),
    config: loadConfig(),
    enableEmbeddings: false,
    enableAuth: false,
  });
  app = result.app;
  dir = mkdtempSync(join(tmpdir(), 'kiro-boot-route-'));
});
afterEach(() => { db.close(); try { rmSync(dir, { recursive: true, force: true }); } catch {} });

function seedObs(cwd: string, title: string, stoppedAt: string) {
  const session_id = 's1';
  if (!db.getSessionRef(session_id)) db.upsertSessionRef({ session_id, cwd, repo: null });
  const seq = db.allocateNextTurnSeq(session_id);
  const turn = db.createTurn({ session_id, seq, cwd, repo: null, prompt_text: title });
  db.markTurnClosed(turn.id);
  db.insertObservation({
    turn_id: turn.id, session_id, turn_seq: seq, repo: null, cwd_scope: cwd,
    title, summary: `s ${title}`, memory_type: 'change', quality: 'normal',
    turn_started_at: stoppedAt, turn_stopped_at: stoppedAt,
  });
}

describe('Integration / GET /context/bootstrap', () => {
  test('returns the scoped bootstrap index for the current cwd', async () => {
    seedObs(dir, 'Bootstrap route obs', '2026-07-10T00:00:00Z');

    const res = await app.request(`/context/bootstrap?cwd=${encodeURIComponent(dir)}`);
    expect(res.status).toBe(200);
    const text = await res.text();

    expect(text.startsWith('<kiro-mem-context>')).toBe(true);
    expect(text.endsWith('</kiro-mem-context>')).toBe(true);
    expect(text).toContain('@kiro-mem/search'); // usage note
    expect(text).toContain('Bootstrap route obs'); // scoped observation surfaces
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(9500);
  });

  test('V2 /context route is removed; /context/bootstrap is the sole context route', async () => {
    const r2 = await app.request(`/context?cwd=${encodeURIComponent(dir)}`);
    const rb = await app.request(`/context/bootstrap?cwd=${encodeURIComponent(dir)}`);
    expect(r2.status).toBe(404); // V2 topic-first injection removed in Phase 4
    expect(rb.status).toBe(200);
  });

  test('another workspace never leaks into the bootstrap index', async () => {
    const other = mkdtempSync(join(tmpdir(), 'kiro-boot-route-other-'));
    try {
      seedObs(dir, 'HERE obs', '2026-07-10T00:00:00Z');
      seedObs(other, 'ELSEWHERE obs', '2026-07-11T00:00:00Z');
      const text = await (await app.request(`/context/bootstrap?cwd=${encodeURIComponent(dir)}`)).text();
      expect(text).toContain('HERE obs');
      expect(text).not.toContain('ELSEWHERE obs');
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});
