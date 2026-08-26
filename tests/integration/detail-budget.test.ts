/**
 * P1-3 — the PULL side needs a byte budget too.
 *
 * The injected bootstrap index is capped at 8192 bytes, but `get_observations`
 * had no limit at all: one call over 20 IDs could push far more text into the
 * agent's context than the entire injection budget, which makes "progressive
 * disclosure" a description rather than a mechanism. These tests pin three
 * bounds — per prose field, per array field, and a total response budget — and
 * require every one of them to be REPORTED when it bites, because a silently
 * shortened memory reads as a memory that simply said less.
 *
 * Also covers S10: source-turn identity must travel with timeline cards.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawn, type Subprocess } from 'bun';
import { mkdtempSync } from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { MemoryDB } from '../../src/db';

const PKG_ROOT = resolve(import.meta.dir, '../..');

const FIELD_CHARS = 1500;
const ARRAY_ITEMS = 20;
const ARRAY_ITEM_CHARS = 300;
const RESPONSE_BYTES = 32 * 1024;

let turnCounter = 0;

function seedObservation(
  db: MemoryDB,
  o: { title: string; summary?: string; outcome?: string; evidence?: string[] },
): number {
  const sessionId = 'sess-a';
  if (!db.getSessionRef(sessionId)) {
    db.upsertSessionRef({ session_id: sessionId, cwd: '/repo-a', repo: '/repo-a' });
  }
  const seq = db.allocateNextTurnSeq(sessionId);
  const turn = db.createTurn({
    session_id: sessionId, seq, cwd: '/repo-a', repo: '/repo-a', prompt_text: o.title,
  });
  db.markTurnClosed(turn.id);
  const stoppedAt = `2026-07-${String(10 + turnCounter++).padStart(2, '0')}T00:00:00Z`;
  return db.insertObservation({
    turn_id: turn.id, session_id: sessionId, turn_seq: seq, repo: '/repo-a', cwd_scope: '/repo-a',
    title: o.title,
    summary: o.summary ?? o.title,
    outcome: o.outcome,
    evidence: o.evidence,
    memory_type: 'change', quality: 'normal',
    turn_started_at: stoppedAt, turn_stopped_at: stoppedAt,
  })!;
}

async function readUntilId(
  reader: { read: () => Promise<{ value?: Uint8Array; done: boolean }> },
  decoder: TextDecoder,
  id: number,
  buf: { s: string },
  timeoutMs = 8000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let nl: number;
    while ((nl = buf.s.indexOf('\n')) >= 0) {
      const line = buf.s.slice(0, nl).trim();
      buf.s = buf.s.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id === id) return msg;
      } catch { /* non-JSON stderr noise */ }
    }
    const { value, done } = await reader.read();
    if (done) break;
    buf.s += decoder.decode(value, { stream: true });
  }
  throw new Error(`timed out waiting for response id=${id}`);
}

describe('P1-3 get_observations response budget', () => {
  let proc: Subprocess | null = null;
  let smallId = 0;
  let hugeFieldsId = 0;
  let hugeArrayId = 0;
  const bulkIds: number[] = [];
  let call: (name: string, args: unknown) => Promise<{ text: string; isError: boolean }>;

  beforeAll(async () => {
    const dataDir = mkdtempSync(`${tmpdir()}/kiro-mem-detail-budget-`);
    const db = new MemoryDB(resolve(dataDir, 'kiro-mem.db'));

    smallId = seedObservation(db, { title: 'small entry', summary: 'short', outcome: 'done' });
    hugeFieldsId = seedObservation(db, {
      title: 'huge prose entry',
      summary: 'S'.repeat(FIELD_CHARS * 4),
      outcome: 'O'.repeat(FIELD_CHARS * 4),
    });
    hugeArrayId = seedObservation(db, {
      title: 'huge evidence entry',
      evidence: Array.from({ length: ARRAY_ITEMS * 5 }, (_, i) => `ev${i} ${'E'.repeat(ARRAY_ITEM_CHARS * 2)}`),
    });
    // 20 fat-but-legal records: individually fine, collectively over budget.
    for (let i = 0; i < 20; i++) {
      bulkIds.push(seedObservation(db, {
        title: `bulk ${i}`,
        summary: 'B'.repeat(FIELD_CHARS),
        outcome: 'C'.repeat(FIELD_CHARS),
      }));
    }
    db.close();

    proc = spawn({
      cmd: ['bun', 'run', 'src/server/mcp-server.ts'],
      cwd: PKG_ROOT,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        KIRO_MEMORY_DATA_DIR: dataDir,
        KIRO_SESSION_ID: 'sess-a',
        KIRO_MEMORY_DISABLE_EMBEDDING_PREWARM: '1',
      },
    });

    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    const buf = { s: '' };
    const stdin = proc.stdin as any;
    const send = (obj: unknown) => { stdin.write(JSON.stringify(obj) + '\n'); stdin.flush?.(); };

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } } });
    await readUntilId(reader, decoder, 1, buf);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    let nextId = 10;
    call = async (name, args) => {
      const id = nextId++;
      send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
      const resp = await readUntilId(reader, decoder, id, buf);
      return { text: resp.result?.content?.[0]?.text ?? '', isError: resp.result?.isError === true };
    };
  });

  afterAll(() => { try { proc?.kill(); } catch {} proc = null; });

  test('a small Observation is returned intact, with no truncation noise', async () => {
    const r = await call('get_observations', { ids: [smallId] });
    const parsed = JSON.parse(r.text);
    expect(parsed.observations[0].summary).toBe('short');
    expect(parsed.observations[0].truncated_fields).toBeUndefined();
    expect(parsed.omitted).toBeUndefined();
  });

  test('oversized prose fields are capped and the cut is named', async () => {
    const r = await call('get_observations', { ids: [hugeFieldsId] });
    const o = JSON.parse(r.text).observations[0];
    expect(o.summary.length).toBeLessThanOrEqual(FIELD_CHARS + 1);
    expect(o.outcome.length).toBeLessThanOrEqual(FIELD_CHARS + 1);
    expect(o.truncated_fields).toContain('summary');
    expect(o.truncated_fields).toContain('outcome');
  });

  test('array fields are capped by count and by item length', async () => {
    const r = await call('get_observations', { ids: [hugeArrayId] });
    const o = JSON.parse(r.text).observations[0];
    expect(o.evidence.length).toBe(ARRAY_ITEMS);
    for (const item of o.evidence) expect(item.length).toBeLessThanOrEqual(ARRAY_ITEM_CHARS + 1);
    expect(o.truncated_fields).toContain('evidence');
  });

  test('a 20-ID call stays inside the total response budget', async () => {
    const r = await call('get_observations', { ids: bulkIds });
    expect(Buffer.byteLength(r.text, 'utf-8')).toBeLessThan(RESPONSE_BYTES * 1.2);
    const parsed = JSON.parse(r.text);
    expect(parsed.observations.length).toBeLessThan(bulkIds.length);
    // The dropped IDs are reported, not silently missing.
    expect(parsed.omitted.length).toBeGreaterThan(0);
    expect(parsed.omitted_reason).toBeTruthy();
    const seen = [...parsed.observations.map((o: { id: number }) => o.id), ...parsed.omitted];
    expect(seen.sort((a: number, b: number) => a - b)).toEqual([...bulkIds].sort((a, b) => a - b));
  });

  test('one oversized Observation is still returned rather than budgeted away', async () => {
    const r = await call('get_observations', { ids: [hugeFieldsId] });
    expect(JSON.parse(r.text).observations.length).toBe(1);
  });

  test('S10: timeline cards carry their source turn identity', async () => {
    const r = await call('timeline', { observation_id: bulkIds[5], before: 2, after: 2 });
    const parsed = JSON.parse(r.text);
    expect(parsed.anchor.turn_id).toBeGreaterThan(0);
    expect(parsed.anchor.turn_seq).toBeGreaterThan(0);
    for (const card of [...parsed.before, ...parsed.after]) {
      expect(card.turn_id).toBeGreaterThan(0);
      expect(typeof card.turn_seq).toBe('number');
    }
  });
});
