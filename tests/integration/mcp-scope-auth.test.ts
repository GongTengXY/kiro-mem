/**
 * P0-2: every ID-addressed MCP tool must enforce scope authorization.
 *
 * `get_observations`, `timeline` and `pin` address rows by GLOBAL Observation
 * ID. Before this fix, knowing an ID was enough to read another workspace's
 * memory — and `pin` could even mutate which Observations get injected into
 * another workspace's session context.
 *
 * These tests drive the real MCP server over stdio with KIRO_SESSION_ID bound
 * to repo A, and assert repo B's Observation is unreachable unless the caller
 * explicitly widens scope (and never reachable for `pin`).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawn, type Subprocess } from 'bun';
import { mkdtempSync } from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { MemoryDB } from '../../src/db';

const PKG_ROOT = resolve(import.meta.dir, '../..');

function seedObservation(
  db: MemoryDB,
  input: { sessionId: string; repo: string; title: string },
): number {
  db.upsertSessionRef({ session_id: input.sessionId, cwd: input.repo, repo: input.repo });
  const seq = db.allocateNextTurnSeq(input.sessionId);
  const turn = db.createTurn({
    session_id: input.sessionId, seq, cwd: input.repo, repo: input.repo, prompt_text: input.title,
  });
  db.markTurnClosed(turn.id);
  return db.insertObservation({
    turn_id: turn.id,
    session_id: input.sessionId,
    turn_seq: seq,
    repo: input.repo,
    cwd_scope: input.repo,
    title: input.title,
    summary: input.title,
    memory_type: 'change',
    quality: 'normal',
    turn_started_at: turn.started_at,
    turn_stopped_at: new Date().toISOString(),
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

describe('P0-2 ID-addressed MCP tools enforce scope', () => {
  let proc: Subprocess | null = null;
  let dataDir: string;
  let dbPath: string;
  let idA = 0;
  let idB = 0;
  let call: (name: string, args: unknown) => Promise<{ text: string; isError: boolean }>;

  beforeAll(async () => {
    dataDir = mkdtempSync(`${tmpdir()}/kiro-mem-scope-auth-`);
    dbPath = resolve(dataDir, 'kiro-mem.db');
    const db = new MemoryDB(dbPath);
    idA = seedObservation(db, { sessionId: 'sess-a', repo: '/repo-a', title: 'alpha work in repo A' });
    idB = seedObservation(db, { sessionId: 'sess-b', repo: '/repo-b', title: 'beta work in repo B' });
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
      return {
        text: resp.result?.content?.[0]?.text ?? '',
        isError: resp.result?.isError === true,
      };
    };
  });

  afterAll(() => { try { proc?.kill(); } catch {} proc = null; });

  test('get_observations returns in-scope IDs', async () => {
    const r = await call('get_observations', { ids: [idA] });
    expect(r.isError).toBe(false);
    const parsed = JSON.parse(r.text);
    expect(parsed.observations.map((o: { id: number }) => o.id)).toEqual([idA]);
    expect(parsed.unavailable).toBeUndefined();
  });

  test('get_observations withholds a foreign ID and reports it explicitly', async () => {
    const r = await call('get_observations', { ids: [idA, idB] });
    const parsed = JSON.parse(r.text);
    expect(parsed.observations.map((o: { id: number }) => o.id)).toEqual([idA]);
    expect(parsed.unavailable).toEqual([idB]);
    expect(JSON.stringify(parsed)).not.toContain('beta work in repo B');
  });

  test('get_observations reaches a foreign ID only with explicit all_scopes', async () => {
    const r = await call('get_observations', { ids: [idB], all_scopes: true });
    const parsed = JSON.parse(r.text);
    expect(parsed.observations.map((o: { id: number }) => o.id)).toEqual([idB]);
  });

  test('timeline refuses a foreign anchor without leaking its body', async () => {
    const r = await call('timeline', { observation_id: idB });
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain('beta work in repo B');
    expect(r.text).toContain(String(idB));
  });

  test('timeline accepts a foreign anchor with explicit all_scopes', async () => {
    const r = await call('timeline', { observation_id: idB, all_scopes: true });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text).anchor.id).toBe(idB);
  });

  test('timeline still works for an in-scope anchor', async () => {
    const r = await call('timeline', { observation_id: idA });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text).anchor.id).toBe(idA);
  });

  test('pin refuses a foreign Observation', async () => {
    const r = await call('pin', { observation_id: idB });
    expect(r.isError).toBe(true);

    const db = new MemoryDB(dbPath);
    expect(db.getObservation(idB)!.is_pinned).toBe(0);
    db.close();
  });

  test('pin rejects all_scopes outright — it is a cross-workspace mutation', async () => {
    const r = await call('pin', { observation_id: idB, all_scopes: true });
    expect(r.isError).toBe(true);

    const db = new MemoryDB(dbPath);
    expect(db.getObservation(idB)!.is_pinned).toBe(0);
    db.close();
  });

  test('pin works within the current workspace', async () => {
    const r = await call('pin', { observation_id: idA, pinned: true });
    expect(r.isError).toBe(false);

    const db = new MemoryDB(dbPath);
    expect(db.getObservation(idA)!.is_pinned).toBe(1);
    db.close();
  });

  test('invalid scope argument types are rejected, not coerced', async () => {
    const bad = await call('get_observations', { ids: [idA], repo: 123 });
    expect(bad.isError).toBe(true);
  });

  test('invalid enum values are rejected instead of silently returning nothing', async () => {
    const badType = await call('search', { query: 'alpha', type: 'not-a-type' });
    expect(badType.isError).toBe(true);
    const badMode = await call('timeline', { observation_id: idA, mode: 'nope' });
    expect(badMode.isError).toBe(true);
  });
});
