import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type Subprocess } from 'bun';
import { mkdtempSync } from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { MemoryDB } from '../../src/db';

const PKG_ROOT = resolve(import.meta.dir, '../..');
let DATA_DIR: string;

beforeAll(() => {
  DATA_DIR = mkdtempSync(`${tmpdir()}/kiro-mem-mcp-v3-`);
});

/** Read stdout lines until a JSON-RPC message with the given id arrives. */
async function readUntilId(
  reader: { read: () => Promise<{ value?: Uint8Array; done: boolean }> },
  decoder: TextDecoder,
  id: number,
  buf: { s: string },
  timeoutMs = 8000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Drain any complete lines already buffered.
    let nl: number;
    while ((nl = buf.s.indexOf('\n')) >= 0) {
      const line = buf.s.slice(0, nl).trim();
      buf.s = buf.s.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id === id) return msg;
      } catch { /* ignore non-JSON */ }
    }
    const { value, done } = await reader.read();
    if (done) break;
    buf.s += decoder.decode(value, { stream: true });
  }
  throw new Error(`timed out waiting for response id=${id}`);
}

function seedObservation(
  db: MemoryDB,
  input: { sessionId: string; repo: string; title: string },
): number {
  db.upsertSessionRef({
    session_id: input.sessionId,
    cwd: input.repo,
    repo: input.repo,
  });
  const seq = db.allocateNextTurnSeq(input.sessionId);
  const turn = db.createTurn({
    session_id: input.sessionId,
    seq,
    cwd: input.repo,
    repo: input.repo,
    prompt_text: input.title,
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

describe('MCP server tool surface', () => {
  let proc: Subprocess | null = null;
  afterEach(() => { try { proc?.kill(); } catch {} proc = null; });

  test('tools/list exposes exactly search/timeline/get_observations/pin (no V2 tools)', async () => {
    proc = spawn({
      cmd: ['bun', 'run', 'src/server/mcp-server.ts'],
      cwd: PKG_ROOT,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, KIRO_MEMORY_DATA_DIR: DATA_DIR },
    });

    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    const buf = { s: '' };
    const stdin = proc.stdin as any;
    const send = (obj: unknown) => { stdin.write(JSON.stringify(obj) + '\n'); stdin.flush?.(); };

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } } });
    const initResp = await readUntilId(reader, decoder, 1, buf);
    expect(initResp.result?.serverInfo?.name).toBe('kiro-mem');

    // Complete the MCP handshake, then list tools.
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const listResp = await readUntilId(reader, decoder, 2, buf);

    const names = (listResp.result?.tools ?? []).map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(['get_observations', 'pin', 'search', 'timeline']);
    // Removed V2 tools must be absent (§8.3).
    expect(names).not.toContain('topics');
    expect(names).not.toContain('trace_memory');
    expect(names).not.toContain('get_memories');

    // No session mapping and no explicit repo/cwd must fail closed. It must not
    // silently become an all-workspace search or guess from the server cwd.
    send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'search', arguments: { query: 'auth' } },
    });
    const searchResp = await readUntilId(reader, decoder, 3, buf);
    expect(searchResp.result?.isError).toBe(true);
    expect(searchResp.result?.content?.[0]?.text).toContain('cwd');
  });

  test('bare search resolves KIRO_SESSION_ID through session_refs and stays in scope', async () => {
    const db = new MemoryDB(resolve(DATA_DIR, 'kiro-mem.db'));
    seedObservation(db, {
      sessionId: 'session-repo-a',
      repo: '/repo-a',
      title: 'shared marker from repo A',
    });
    seedObservation(db, {
      sessionId: 'session-repo-b',
      repo: '/repo-b',
      title: 'shared marker from repo B',
    });
    db.close();

    proc = spawn({
      cmd: ['bun', 'run', 'src/server/mcp-server.ts'],
      cwd: PKG_ROOT,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        KIRO_MEMORY_DATA_DIR: DATA_DIR,
        KIRO_SESSION_ID: 'session-repo-a',
      },
    });

    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    const buf = { s: '' };
    const stdin = proc.stdin as any;
    const send = (obj: unknown) => {
      stdin.write(JSON.stringify(obj) + '\n');
      stdin.flush?.();
    };

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } } });
    await readUntilId(reader, decoder, 1, buf);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'search', arguments: { query: 'shared marker' } },
    });

    const searchResp = await readUntilId(reader, decoder, 2, buf);
    expect(searchResp.result?.isError).not.toBe(true);
    const payload = JSON.parse(searchResp.result?.content?.[0]?.text ?? '{}');
    expect(payload.results.map((result: { title: string }) => result.title)).toEqual([
      'shared marker from repo A',
    ]);
  });
});


describe('MCP release-readiness behavior', () => {
  let proc: Subprocess | null = null;
  afterEach(() => { try { proc?.kill(); } catch {} proc = null; });

  test('reports V3 version, accepts literal queries, and rejects unsafe bounds', async () => {
    const repo = '/repo-special';
    const db = new MemoryDB(resolve(DATA_DIR, 'kiro-mem.db'));
    seedObservation(db, {
      sessionId: 'session-special',
      repo,
      title: 'foo:bar a-b "unterminated AND C++ src/auth/token.ts 中文查询',
    });
    db.close();

    proc = spawn({
      cmd: ['bun', 'run', 'src/server/mcp-server.ts'],
      cwd: PKG_ROOT,
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
      env: {
        ...process.env,
        KIRO_MEMORY_DATA_DIR: DATA_DIR,
        KIRO_MEMORY_DISABLE_EMBEDDING_PREWARM: '1',
      },
    });
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    const buf = { s: '' };
    const stdin = proc.stdin as any;
    const send = (obj: unknown) => { stdin.write(JSON.stringify(obj) + '\n'); stdin.flush?.(); };

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } } });
    const initialized = await readUntilId(reader, decoder, 1, buf);
    expect(initialized.result?.serverInfo?.version).toBe('3.0.0');
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    let id = 2;
    for (const query of ['foo:bar', 'a-b', '"unterminated', 'AND', 'C++', 'src/auth/token.ts', '中文查询']) {
      send({
        jsonrpc: '2.0', id, method: 'tools/call',
        params: { name: 'search', arguments: { query, repo } },
      });
      const response = await readUntilId(reader, decoder, id, buf);
      expect(response.error).toBeUndefined();
      expect(response.result?.isError).not.toBe(true);
      const payload = JSON.parse(response.result?.content?.[0]?.text ?? '{}');
      expect(payload.results.length).toBeGreaterThan(0);
      id++;
    }

    const invalidCalls = [
      { name: 'search', arguments: { query: 'x', repo, limit: -1 } },
      { name: 'search', arguments: { query: 'x', repo, days: 3651 } },
      { name: 'timeline', arguments: { observation_id: 1, before: 21 } },
      { name: 'get_observations', arguments: { ids: [] } },
      { name: 'pin', arguments: { observation_id: 999999 } },
    ];
    for (const call of invalidCalls) {
      send({ jsonrpc: '2.0', id, method: 'tools/call', params: call });
      const response = await readUntilId(reader, decoder, id, buf);
      expect(response.error != null || response.result?.isError === true).toBe(true);
      id++;
    }
  }, 20_000);
});
