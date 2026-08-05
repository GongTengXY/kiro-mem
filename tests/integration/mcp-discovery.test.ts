/**
 * 真实 MCP 路径上的独立语义召回（方案 §7.7 后半 + §8.1/§8.2 的 2C 交付）。
 *
 * ## 为什么必须走进程边界
 *
 * `src/server/mcp-server.ts` 在模块层构造 DB 单例与 Worker embedder，没有依赖注入缝。
 * 直接 import 它等于在测试进程里建一个生产单例，测的也不再是"Kiro 真的调用 MCP 时会
 * 发生什么"。所以这里 spawn 真实的 MCP server，用 stdio JSON-RPC 说话，链路是完整的：
 *
 *   tools/call → schema 校验 → scope 解析 → Worker HTTP 取 query 向量
 *              → 检索内核（含协议边界与 cap）→ compactCard 投影 → JSON-RPC 返回
 *              → metric_events 落盘
 *
 * ## 为什么要起一个真实 Worker
 *
 * MCP server 进程**不持有模型**，query 向量只能来自 `POST /embed/query`。不起 Worker
 * 就只能测到降级路径，测不到"拆门后真的能召回"。这里用 `createApp` 起真 Worker，
 * 把 `.worker.port` 与 `.token` 写进临时 dataDir，让被 spawn 的 MCP server 自己找到它。
 *
 * ## 灰度开关
 *
 * 阶段 2C 起生产默认就是独立语义召回（`DEFAULT_RETRIEVAL_POLICY`），回滚靠临时
 * dataDir 里的 `config.json`（`retrieval.semanticDiscovery: false`）——和运维文档写的
 * 是同一条路径。2B 那个 `KIRO_MEM_SEMANTIC_DISCOVERY` 环境变量缝已经删除，所以这里
 * 用配置文件驱动开关本身也是对"回滚真的可用"的验证。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawn, type Subprocess } from 'bun';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { MemoryDB, computeScopeKey } from '../../src/db';
import { createApp } from '../../src/server/worker';
import { ACPCompressor } from '../../src/acp/compressor';
import { FakeACPPool } from '../support/fake-acp-pool';
import { loadConfig } from '../../src/config';
import { DIMENSIONS, embeddingToBlob } from '../../src/embedding-space';
import { SEMANTIC_EN_PROTOCOL, embeddingSpaceKey } from '../../src/semantic-en';

const PKG_ROOT = resolve(import.meta.dir, '../..');
const EN_SPACE = embeddingSpaceKey(SEMANTIC_EN_PROTOCOL);
const TOKEN = 'b'.repeat(64);
const SESSION = 'mcp-discovery-session';
const REPO = '/mcp-discovery-repo';

let dataDir: string;
let db: MemoryDB;
let server: ReturnType<typeof Bun.serve> | null = null;
let stopRunner: (() => void) | null = null;
let proc: Subprocess | null = null;

/**
 * 确定性 embedder：向量由文本决定，所以喂错文本一定得到错分数。
 *
 * `TARGET_TEXT` 与 `EN_QUERY` 刻意映射到**同一个**基向量，于是它们 cosine = 1；
 * 其它文本落到别的维度，cosine = 0。这样 floor 的行为是可预测的，不依赖真实模型。
 */
const TARGET_TEXT = 'observation about credential rotation';
const EN_QUERY = 'how are credentials rotated';
function vectorFor(text: string): Float32Array {
  const v = new Float32Array(DIMENSIONS);
  const aligned = text === TARGET_TEXT || text === EN_QUERY;
  v[aligned ? 0 : 7] = 1;
  return v;
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'kiro-mem-mcp-discovery-'));
  writeFileSync(join(dataDir, '.token'), TOKEN, { mode: 0o600 });
  db = new MemoryDB(join(dataDir, 'kiro-mem.db'));

  const built = createApp({
    db,
    compressor: new ACPCompressor({}, new FakeACPPool()),
    config: loadConfig(),
    enableEmbeddings: true,
    embeddingGenerator: async (text: string) => vectorFor(text),
    enableAuth: true,
    authToken: TOKEN,
  });
  stopRunner = () => built.jobRunner.stop();
  server = Bun.serve({ port: 0, fetch: built.app.fetch });
  // 被 spawn 的 MCP server 靠这个文件找到 Worker（生产里由 Worker 自己写）。
  writeFileSync(join(dataDir, '.worker.port'), String(server.port));
});

afterEach(() => {
  try { proc?.kill(); } catch { /* already gone */ }
  proc = null;
  stopRunner?.();
  server?.stop(true);
  server = null;
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** 播种一条 Observation，可选带 `semantic-en-v1` 向量。 */
function seed(o: { title: string; embedding?: Float32Array }): number {
  if (!db.getSessionRef(SESSION)) {
    db.upsertSessionRef({ session_id: SESSION, cwd: REPO, repo: REPO });
  }
  const seq = db.allocateNextTurnSeq(SESSION);
  const turn = db.createTurn({
    session_id: SESSION, seq, cwd: REPO, repo: REPO, prompt_text: o.title,
  });
  db.markTurnClosed(turn.id);
  const now = new Date().toISOString();
  const id = db.insertObservation({
    turn_id: turn.id, session_id: SESSION, turn_seq: seq, repo: REPO, cwd_scope: REPO,
    title: o.title, summary: o.title, memory_type: 'change', quality: 'normal',
    turn_started_at: now, turn_stopped_at: now,
  })!;
  if (o.embedding) {
    db.upsertObservationEmbedding(id, EN_SPACE, DIMENSIONS, embeddingToBlob(o.embedding));
  }
  return id;
}

interface SearchPayload {
  results: Record<string, unknown>[];
  total: number;
}

/** spawn 一次真实 MCP server，完成握手，调一次 `search`，返回解析后的载荷。 */
async function mcpSearch(
  args: Record<string, unknown>,
  opts?: { rollback?: boolean },
): Promise<{ payload: SearchPayload | null; isError: boolean; text: string }> {
  // 灰度开关走临时 dataDir 里的 config.json——被 spawn 的 MCP server 用
  // `KIRO_MEMORY_DATA_DIR` 找到它，和线上回滚是同一条路径。不写文件即默认（discovery on）。
  if (opts?.rollback) {
    writeFileSync(
      join(dataDir, 'config.json'),
      JSON.stringify({ language: 'zh', retrieval: { semanticDiscovery: false } }, null, 2),
    );
  }
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
    },
  });

  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const buf = { s: '' };
  const stdin = proc.stdin as { write: (s: string) => void; flush?: () => void };
  const send = (obj: unknown) => { stdin.write(JSON.stringify(obj) + '\n'); stdin.flush?.(); };

  const readUntilId = async (id: number, timeoutMs = 15000): Promise<any> => {
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
        } catch { /* 非 JSON 行忽略 */ }
      }
      const { value, done } = await reader.read();
      if (done) break;
      buf.s += decoder.decode(value, { stream: true });
    }
    throw new Error(`timed out waiting for id=${id}`);
  };

  send({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } },
  });
  await readUntilId(1);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search', arguments: args } });
  const resp = await readUntilId(2);

  const text = String(resp.result?.content?.[0]?.text ?? '');
  const isError = Boolean(resp.result?.isError);
  let payload: SearchPayload | null = null;
  if (!isError) {
    try { payload = JSON.parse(text) as SearchPayload; } catch { payload = null; }
  }
  return { payload, isError, text };
}

describe('真实 MCP 路径：独立语义召回', () => {
  test('默认策略 + 合法 semantic_query_en + zero-FTS 能召回目标', async () => {
    const target = seed({ title: TARGET_TEXT, embedding: vectorFor(TARGET_TEXT) });
    seed({ title: 'unrelated build pipeline note', embedding: vectorFor('noise') });

    // query 与语料**没有任何词面重叠**：'rotated' 不在 'observation about credential
    // rotation' 里出现（trigram 子串意义上 'rotat' 会命中，所以刻意用完全不同的词）。
    // 不传任何开关——这就是 2C 之后用户默认拿到的行为。
    const { payload } = await mcpSearch({
      query: 'zzqqxx nothing lexical here',
      semantic_query_en: EN_QUERY,
      repo: REPO,
      cwd: REPO,
    });

    expect(payload).not.toBeNull();
    expect(payload!.total).toBe(1);
    const card = payload!.results[0]!;
    expect(card.id).toBe(target);
    // 这条记录**只有**语义证据，卡片必须如实标出来。
    expect(card.match_source).toBe('semantic');
  });

  test('返回卡片保留 match_source 与 semantic_score', async () => {
    seed({ title: TARGET_TEXT, embedding: vectorFor(TARGET_TEXT) });
    const { payload } = await mcpSearch({
      query: 'zzqqxx nothing lexical here',
      semantic_query_en: EN_QUERY,
      repo: REPO,
      cwd: REPO,
    });

    const card = payload!.results[0]!;
    expect(Object.keys(card)).toContain('match_source');
    expect(Object.keys(card)).toContain('semantic_score');
    expect(card.match_source).toBe('semantic');
    // cosine = 1（两侧对齐同一基向量），所以这里能断言具体值而不只是"非空"。
    expect(typeof card.semantic_score).toBe('number');
    expect(card.semantic_score as number).toBeCloseTo(1, 5);
  });

  test('缺失英文形式：明确降级，zero-FTS 不做独立召回', async () => {
    seed({ title: TARGET_TEXT, embedding: vectorFor(TARGET_TEXT) });
    // 不传 semantic_query_en → 协议落回 raw-v1 → 协议边界拒绝独立召回。
    const { payload } = await mcpSearch({
      query: 'zzqqxx nothing lexical here',
      repo: REPO,
      cwd: REPO,
    });

    expect(payload!.total).toBe(0);
    expect(payload!.results).toEqual([]);
  });

  test('非法英文形式（占位符）：被护栏拒绝，同样不做独立召回', async () => {
    seed({ title: TARGET_TEXT, embedding: vectorFor(TARGET_TEXT) });
    const { payload } = await mcpSearch({
      query: 'zzqqxx nothing lexical here',
      // 这正是 validation 集 v20 踩到的那个值。
      semantic_query_en: '...',
      repo: REPO,
      cwd: REPO,
    });

    expect(payload!.total).toBe(0);
  });

  test('无关 query 受 cap 限制：返回条数 ≤ cap，不再断言结构上必为空', async () => {
    // 6 条记录全部与 query 语义对齐（cosine=1），词面零重叠。cap=2 必须把它压到 2 条。
    for (let i = 0; i < 6; i++) seed({ title: TARGET_TEXT, embedding: vectorFor(TARGET_TEXT) });

    const { payload } = await mcpSearch({
      query: 'zzqqxx nothing lexical here',
      semantic_query_en: EN_QUERY,
      repo: REPO,
      cwd: REPO,
    });

    // 冻结的 cap 是 2。断言的是"受 cap 限制"这个不变量，不是"必为空"。
    expect(payload!.total).toBeLessThanOrEqual(2);
    expect(payload!.total).toBeGreaterThan(0);
    for (const card of payload!.results) expect(card.match_source).toBe('semantic');
  });

  test('回滚开关（config.json）：同一 query 回到关键词门，返回空', async () => {
    seed({ title: TARGET_TEXT, embedding: vectorFor(TARGET_TEXT) });
    const { payload } = await mcpSearch({
      query: 'zzqqxx nothing lexical here',
      semantic_query_en: EN_QUERY,
      repo: REPO,
      cwd: REPO,
    }, { rollback: true });
    // 这不是"默认行为"，而是运维显式选择的回滚 profile。它必须真的可用，否则文档
    // 里那条回滚指令是空头承诺。
    expect(payload!.total).toBe(0);
  });

  test('FTS 有命中时：卡片仍带 match_source，且默认与回滚结果一致', async () => {
    seed({ title: 'credential rotation runbook', embedding: vectorFor('noise') });
    const on = await mcpSearch({ query: 'credential rotation', repo: REPO, cwd: REPO });
    const off = await mcpSearch(
      { query: 'credential rotation', repo: REPO, cwd: REPO },
      { rollback: true },
    );
    expect(on.payload!.total).toBeGreaterThan(0);
    expect(off.payload!.results.map((r) => r.id)).toEqual(on.payload!.results.map((r) => r.id));
    for (const card of on.payload!.results) {
      expect(['fts', 'hybrid', 'semantic']).toContain(String(card.match_source));
    }
  });
});

/**
 * 运行观测（方案 §8.2）在**真实 MCP 进程**里落盘。
 *
 * 内核单测能证明 `onCandidates` 报了什么，证明不了 MCP server 真的把它写进了
 * `metric_events`——而 2C 的灰度判据全部读这张表。指标写入是 best-effort（异常被吞），
 * 所以"少写了一列"在生产里表现为计数器永远为 0，而不是报错。
 */
describe('真实 MCP 路径：检索观测落盘', () => {
  /** 读该 dataDir 里最新一行 search 指标。 */
  function latestSearchMetric(): Record<string, unknown> | null {
    const probe = new MemoryDB(join(dataDir, 'kiro-mem.db'));
    const row = probe.raw
      .query("SELECT * FROM metric_events WHERE kind = 'search' ORDER BY id DESC LIMIT 1")
      .get() as Record<string, unknown> | null;
    probe.close();
    return row;
  }

  test('zero-FTS 语义召回：协议、零锚点、semantic-only 与可比向量数都被记录', async () => {
    seed({ title: TARGET_TEXT, embedding: vectorFor(TARGET_TEXT) });
    seed({ title: 'unrelated build pipeline note', embedding: vectorFor('noise') });
    await mcpSearch({
      query: 'zzqqxx nothing lexical here',
      semantic_query_en: EN_QUERY,
      repo: REPO,
      cwd: REPO,
    });

    const row = latestSearchMetric();
    expect(row).not.toBeNull();
    expect(row!.protocol).toBe('semantic-en-v1');
    expect(row!.reject_reason).toBeNull();
    expect(row!.discovery).toBe(1);
    expect(row!.fts_count).toBe(0);
    expect(row!.semantic_count).toBe(1);
    expect(row!.semantic_only).toBe(1);
    // 两条记录都有 semantic-en 向量，所以语义腿确实有东西可比——这正是"返回空"与
    // "根本没向量"之间的那个区分。
    expect(row!.comparable_vectors).toBe(2);
    // scope 内向量数（方案 §8.2）：候选池计数会被 200 条夹住，这个不会。
    expect(row!.scope_vectors).toBe(2);
    expect(typeof row!.latency_ms).toBe('number');
    expect(row!.degraded).toBe(0);
  });

  test('回滚 profile 下语义步骤没跑：scope_vectors 记 NULL 而不是 0', async () => {
    seed({ title: TARGET_TEXT, embedding: vectorFor(TARGET_TEXT) });
    await mcpSearch({
      query: 'zzqqxx nothing lexical here',
      semantic_query_en: EN_QUERY,
      repo: REPO,
      cwd: REPO,
    }, { rollback: true });

    const row = latestSearchMetric()!;
    // 这个 scope 明明有 1 条向量。如果这里记 0，就等于告诉运维"这个 workspace 没建过
    // 向量"——把一次策略选择说成一次重建缺失。
    expect(row.scope_vectors).toBeNull();
    expect(row.fts_count).toBe(0);
    expect(row.discovery).toBe(0);
  });

  test('缺失英文形式记为 missing，且与护栏拒绝分开', async () => {
    seed({ title: TARGET_TEXT, embedding: vectorFor(TARGET_TEXT) });

    await mcpSearch({ query: 'zzqqxx nothing lexical here', repo: REPO, cwd: REPO });
    const missing = latestSearchMetric();
    expect(missing!.protocol).toBe('raw-v1');
    expect(missing!.reject_reason).toBe('missing');
    expect(missing!.discovery).toBe(0);

    await mcpSearch({
      query: 'zzqqxx nothing lexical here',
      semantic_query_en: '...',
      repo: REPO,
      cwd: REPO,
    });
    const rejected = latestSearchMetric();
    expect(rejected!.protocol).toBe('raw-v1');
    // 传了但被拒 ≠ 没传。混成一个数字，灰度就无法判断该修 prompt 还是修护栏。
    expect(rejected!.reject_reason).toBe('placeholder');
    expect(rejected!.discovery).toBe(0);
  });

  test('聚合读数：semanticEnRate / zeroFtsRecalled / semanticOnlyMax 与冻结 cap 一致', async () => {
    for (let i = 0; i < 6; i++) seed({ title: TARGET_TEXT, embedding: vectorFor(TARGET_TEXT) });
    await mcpSearch({
      query: 'zzqqxx nothing lexical here',
      semantic_query_en: EN_QUERY,
      repo: REPO,
      cwd: REPO,
    });

    const stats = db.getObservabilityStats().search24h;
    expect(stats.requests).toBe(1);
    expect(stats.semanticEnRate).toBe(1);
    expect(stats.zeroFts).toBe(1);
    expect(stats.zeroFtsRecalled).toBe(1);
    // 6 条候选全部 cosine=1，cap 必须在运行侧也看得见地把它压到 2。
    expect(stats.semanticOnlyMax).toBe(2);
    expect(stats.semanticQueryIssues).toEqual({});
  });

  test('指标不记录 query 正文', async () => {
    seed({ title: TARGET_TEXT, embedding: vectorFor(TARGET_TEXT) });
    const secret = 'zzqqxx nothing lexical here';
    await mcpSearch({ query: secret, semantic_query_en: EN_QUERY, repo: REPO, cwd: REPO });

    const row = latestSearchMetric()!;
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(EN_QUERY);
    expect(serialized).not.toContain(TARGET_TEXT);
    // scope 也不落盘：workspace 路径同样是用户数据。
    expect(serialized).not.toContain(REPO);
  });
});
