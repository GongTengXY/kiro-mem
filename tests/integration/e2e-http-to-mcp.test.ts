/**
 * §5.2 端到端贯穿：HTTP 摄入 → job 合成 → Observation 入库 → MCP 取回。
 *
 * 此前每一层都有测试，但没有一条测试**贯穿**它们：摄入测试到 job 入队为止，
 * 合成测试直接给 job 喂 turn_id，MCP 测试直接往库里塞 Observation，基准脚本
 * 干脆手写了三个 HTTP 路由的编排。结果是层与层之间的契约无人验证——P0-2 那个
 * 跨 scope 越权就是这么漏到发布前的。
 *
 * 这条测试用**文件型** SQLite（不是内存库），因为 MCP server 是独立进程，必须
 * 真的通过磁盘看到 Worker 写下的数据。经过的真实组件：
 *   HTTP 路由 → 脱敏 → turn_events → artifacts 提取 → summarize_turn job →
 *   生产 ACPCompressor（仅替换 ACP 传输层）→ observations + FTS →
 *   MCP stdio server → session scope 授权 → hybrid 检索 → get_observations 预算层
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawn, type Subprocess } from 'bun';
import { mkdtempSync, rmSync } from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';
import type { Hono } from 'hono';
import { MemoryDB } from '../../src/db';
import { createApp } from '../../src/server/worker';
import { ACPCompressor } from '../../src/acp/compressor';
import { FakeACPPool } from '../support/fake-acp-pool';
import { loadConfig } from '../../src/config';

const PKG_ROOT = resolve(import.meta.dir, '../..');
const SESSION = 'e2e-session';
const WORKSPACE = '/e2e-workspace';

/** 压缩结果里放一个高区分度的词，用来验证它真的走到了 FTS 索引。 */
const MARKER = 'quantumsluice';

const COMPRESSED = JSON.stringify({
  title: `修复 ${MARKER} 缓存击穿`,
  summary: `${MARKER} 模块的缓存击穿已修复，改为单飞加载。`,
  request: '修复缓存击穿',
  outcome: 'bun test 通过，12 pass 0 fail。',
  learned: '并发穿透要用单飞而不是加锁重试。',
  next_steps: '',
  memory_type: 'bugfix',
  files_touched: ['src/cache/singleflight.ts'],
  concepts: [MARKER, '缓存击穿', 'singleflight'],
  evidence: ['bun test (exit 0)'],
  importance_score: 0.8,
  confidence_score: 0.9,
  unresolved_score: 0,
});

function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const started = Date.now();
  return new Promise((res, rej) => {
    const tick = () => {
      if (predicate()) return res();
      if (Date.now() - started > timeoutMs) return rej(new Error('timed out'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

async function readUntilId(
  reader: { read: () => Promise<{ value?: Uint8Array; done: boolean }> },
  decoder: TextDecoder,
  id: number,
  buf: { s: string },
  timeoutMs = 15000,
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
      } catch { /* stderr noise */ }
    }
    const { value, done } = await reader.read();
    if (done) break;
    buf.s += decoder.decode(value, { stream: true });
  }
  throw new Error(`timed out waiting for response id=${id}`);
}

describe('E2E: HTTP ingest → job → Observation → MCP', () => {
  let dataDir: string;
  let db: MemoryDB;
  let app: Hono;
  let jobRunner: { start: () => void; stop: () => void };
  let proc: Subprocess | null = null;
  let observationId = 0;
  let turnId = 0;
  let call: (name: string, args: unknown) => Promise<{ text: string; isError: boolean }>;
  let pool: FakeACPPool;

  beforeAll(async () => {
    dataDir = mkdtempSync(`${tmpdir()}/kiro-mem-e2e-`);
    db = new MemoryDB(resolve(dataDir, 'kiro-mem.db'));
    pool = new FakeACPPool({ fallback: COMPRESSED });
    const result = createApp({
      db,
      compressor: new ACPCompressor({}, pool),
      config: loadConfig(),
      enableEmbeddings: false,
      enableAuth: false,
    });
    app = result.app;
    jobRunner = result.jobRunner;

    const post = (path: string, body: unknown) =>
      app.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    // 1) 真实 HTTP 摄入三连，含一段 <private> 用来确认脱敏在贯穿路径上也成立。
    const r1 = await post('/events/prompt', {
      session_id: SESSION,
      cwd: WORKSPACE,
      repo: WORKSPACE,
      prompt: `修一下缓存击穿 <private>DB_PASSWORD=hunter2</private>`,
    });
    expect(r1.status).toBe(200);
    turnId = ((await r1.json()) as any).turn_id;

    const r2 = await post('/events/observation', {
      session_id: SESSION,
      tool_name: 'shell',
      tool_input: { command: 'bun test' },
      tool_response: { exit_status: 0, stdout: '12 pass, 0 fail' },
    });
    expect(r2.status).toBe(202);

    const r3 = await post('/events/stop', {
      session_id: SESSION,
      assistant_response: '改成单飞加载，测试通过。',
    });
    expect(r3.status).toBe(200);

    // 2) 真实 job runner 合成 Observation。
    jobRunner.start();
    await waitFor(() => !!db.getObservationByTurnId(turnId));
    jobRunner.stop();
    observationId = db.getObservationByTurnId(turnId)!.id;
    db.close();

    // 3) 真实 MCP server 子进程，只给它 dataDir 与 session id。
    proc = spawn({
      cmd: ['bun', 'run', 'src/server/mcp-server.ts'],
      cwd: PKG_ROOT,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        KIRO_MEMORY_DATA_DIR: dataDir,
        KIRO_SESSION_ID: SESSION,
        KIRO_MEMORY_DISABLE_EMBEDDING_PREWARM: '1',
      },
    });

    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    const buf = { s: '' };
    const stdin = proc.stdin as any;
    const send = (obj: unknown) => { stdin.write(JSON.stringify(obj) + '\n'); stdin.flush?.(); };

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'e2e', version: '1.0.0' } } });
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

  afterAll(() => {
    try { jobRunner?.stop(); } catch {}
    try { proc?.kill(); } catch {}
    proc = null;
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('search finds the Observation the HTTP path produced, without any scope argument', async () => {
    // scope 完全来自 KIRO_SESSION_ID → session_refs，也就是 prompt hook 写下的
    // 那个 cwd。这条链路此前只被单测覆盖过，没有一条测试从摄入侧走到这里。
    const r = await call('search', { query: MARKER });
    expect(r.isError).toBe(false);
    const parsed = JSON.parse(r.text);
    expect(parsed.results.map((o: { id: number }) => o.id)).toContain(observationId);
    const card = parsed.results.find((o: { id: number }) => o.id === observationId);
    expect(card.type).toBe('bugfix');
    // S10：卡片必须能回溯到来源 turn。
    expect(card.turn_id).toBe(turnId);
  });

  test('get_observations returns the full record with source-turn metadata', async () => {
    const r = await call('get_observations', { ids: [observationId] });
    expect(r.isError).toBe(false);
    const parsed = JSON.parse(r.text);
    expect(parsed.observations.length).toBe(1);
    const obs = parsed.observations[0];
    expect(obs.outcome).toContain('12 pass');
    expect(obs.files).toEqual(['src/cache/singleflight.ts']);
    expect(obs.source_turn.turn_id).toBe(turnId);
    expect(obs.source_turn.prompt).toContain('缓存击穿');
  });

  test('the <private> payload never reaches the retrievable record', async () => {
    const r = await call('search', { query: 'hunter2' });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text).results.length).toBe(0);

    const detail = await call('get_observations', { ids: [observationId] });
    expect(detail.text).not.toContain('hunter2');
    expect(detail.text).not.toContain('DB_PASSWORD');
  });

  test('the compression prompt carried the deterministic artifacts, not the raw secret', async () => {
    // 摄入层与压缩层之间的契约：命令、测试信号与助手最终回复必须到达 prompt，
    // 而 <private> 段必须在更上游就消失。之前只有分层单测，没有一条测试确认
    // HTTP 端写入的东西真的是压缩器读到的东西。
    expect(pool.calls.length).toBeGreaterThan(0);
    const prompt = pool.calls[0]!.prompt;
    expect(prompt).toContain('bun test');
    expect(prompt).toContain('改成单飞加载');
    expect(prompt).toContain('缓存击穿');
    expect(prompt).not.toContain('hunter2');
    expect(prompt).not.toContain('DB_PASSWORD');
  });

  test('an unrelated query returns nothing rather than a page of noise', async () => {
    // 词汇锚点规则（S4）在真实 MCP 路径上同样生效。
    const r = await call('search', { query: 'Kubernetes Ingress 灰度发布' });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text).results.length).toBe(0);
  });
});
