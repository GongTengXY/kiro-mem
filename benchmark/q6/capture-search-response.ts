#!/usr/bin/env bun
/**
 * Q6 取证：捕获一份**真实**的 JSON-RPC `search` 响应，供 S1 预检使用。
 *
 * 判据：`benchmark/reports/agent-behavior/q6-criteria.md`（r4）§8.1 要求 S1 用
 * "同一个**已捕获**的 JSON-RPC search 响应（固定样本，冻结）"，因此不能用合成帧——
 * 合成帧证明不了投影能处理生产的真实卡片字段、真实缩进、真实外层信封。
 *
 * 实施边界：本脚本**不启动任何 ACP agent**，只直接与生产 `mcp-server.ts` 说话
 * （加上它依赖的 Worker，用于计算 query 向量）。这在冻结前允许。
 *
 * 生产代码零改动（S5）：装置用临时 dataDir + symlink 指回仓库 `src/`，测的就是当前代码。
 *
 * 输出：`benchmark/q6/fixtures/captured-search-response.json`
 */
import { spawn } from 'bun';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MemoryDB } from '../../src/db';
import { generateEmbedding, embeddingToBlob, buildObservationSearchText, DIMENSIONS } from '../../src/embedding';
import {
  RAW_PROTOCOL,
  SEMANTIC_EN_PROTOCOL,
  embeddingSpaceKey,
  semanticEnSearchTextFields,
} from '../../src/semantic-en';
import { PACKAGE_VERSION } from '../../src/version';

const PKG_ROOT = join(import.meta.dir, '..', '..');
const OUT = join(import.meta.dir, 'fixtures', 'captured-search-response.json');
const SESSION_HINT = 'q6-capture-session';
const TOKEN = 'q6-capture-token-0123456789abcdef';

/**
 * 三条记录。`TARGET` 的措辞与 query **刻意零词面重叠**，这样它只能靠语义腿进页，
 * 从而捕获到 `match_source: "semantic"` —— 那正是 Q6 要改写的那一种卡。
 *
 * 这只是**装置样本**，不是 §3 的实验 fixture：它不参与任何 H 门，只用来验证投影。
 */
const TARGET_TITLE = '压缩失败时降级为 fallback 观察';
const FIXTURES = [
  {
    title: TARGET_TITLE,
    summary: '摘要生成失败后不再抛弃该轮，改为写入只含确定性证据的记录',
    outcome: '失败轮次仍可检索',
    learned: '不要用编造结果代替失败',
    concepts: ['fallback'],
    files: ['src/jobs/artifacts.ts'],
    en: {
      title: 'degrade to a fallback observation when compression fails',
      summary: 'a failed summary no longer discards the turn; write deterministic evidence only',
      outcome: 'failed turns stay searchable',
      learned: 'never substitute a fabricated result for a failure',
      concepts: ['fallback'],
    },
    isTarget: true,
  },
  {
    title: '本地凭据文件权限收紧到 0600',
    summary: '生成高熵 token 并限制为仅属主可读',
    outcome: '凭据不再被同机进程读到',
    learned: '默认权限不可信',
    concepts: ['token'],
    files: ['src/auth-token.ts'],
    en: {
      title: 'tighten the local credential file to owner-only 0600',
      summary: 'generate a high entropy token and restrict it to the owner',
      outcome: 'other local processes can no longer read it',
      learned: 'default permissions are not trustworthy',
      concepts: ['token'],
    },
    isTarget: false,
  },
  {
    title: '注入索引的字节预算下调',
    summary: '把会话开头注入的清单压到限制以下',
    outcome: '注入不再被截断',
    learned: '预算要留余量',
    concepts: ['budget'],
    files: ['src/bootstrap-context.ts'],
    en: {
      title: 'lower the byte budget of the injected index',
      summary: 'keep the session-start menu below the hard limit',
      outcome: 'the injection is no longer truncated',
      learned: 'leave headroom in a budget',
      concepts: ['budget'],
    },
    isTarget: false,
  },
] as const;

/**
 * 与 TARGET **零 3 字窗口重叠**、但语义指向同一件事的问法。
 *
 * 第一版写的是"摘要生成出错以后那条记录还留着吗"，实测拿到 `hybrid` —— 它与 summary 的
 * "摘要生成失败后…"共享 `摘要生` / `要生成`，FTS 也命中了。改用完全不同的词面：
 * 总结 / 出问题 / 查到，避开记录里的 摘要 / 失败 / 记录 / 检索。
 */
const QUERY_ZH = '总结那一步出问题的时候还能查到吗';
const QUERY_EN = 'can it still be found after the summarizing step goes wrong';

/**
 * 第二个样本：**混合来源的多卡页**。
 *
 * 只有单卡页的话，S1 的"非目标卡保留自己的标签"是空跑的——而那一条正是判据禁止全局字符串
 * 替换的直接体现。所以再捕一份：中文问法带上只命中 obs#3 的词面锚点（`注入索引`），
 * 英文问法仍指向 TARGET 的语义，于是页面上同时出现 `fts` 卡与 `semantic` 目标卡。
 */
const QUERY2_ZH = '注入索引的字节预算是多少';
const QUERY2_EN = 'can it still be found after the summarizing step goes wrong';

async function borrowFreePort(): Promise<number> {
  const s = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const p = s.port;
  s.stop(true);
  return p;
}

function layoutDataDir(dataDir: string, workspace: string, workerPort: number): void {
  mkdirSync(join(dataDir, 'logs'), { recursive: true });
  writeFileSync(join(dataDir, '.token'), TOKEN, { mode: 0o600 });
  writeFileSync(
    join(dataDir, 'config.json'),
    JSON.stringify(
      {
        language: 'zh',
        worker: { port: workerPort, host: '127.0.0.1', logLevel: 'info' },
        compression: { concurrency: 1, timeoutMs: 30000, maxRetries: 2 },
        retrieval: { semanticDiscovery: true },
        runtime: { kiroHome: '' },
      },
      null,
      2,
    ),
  );
  symlinkSync(join(PKG_ROOT, 'src'), join(dataDir, 'src'));
  symlinkSync(join(PKG_ROOT, 'src', 'hooks'), join(dataDir, 'hooks'));
  copyFileSync(join(PKG_ROOT, 'src', 'agent', 'prompt.md'), join(dataDir, 'prompt.md'));

  const runtime = join(dataDir, 'kiro-runtime');
  mkdirSync(join(runtime, 'agents'), { recursive: true });
  mkdirSync(join(runtime, 'sessions'), { recursive: true });
  writeFileSync(
    join(runtime, 'agents', 'kiro-mem-compressor.json'),
    readFileSync(join(PKG_ROOT, 'src', 'agent', 'kiro-mem-compressor.json'), 'utf-8').replaceAll(
      '__KIRO_MEMORY_DIR__',
      dataDir,
    ),
  );
  copyFileSync(
    join(PKG_ROOT, 'src', 'acp', 'compressor-prompt.zh.md'),
    join(runtime, 'kiro-mem-compressor-prompt.md'),
  );
  void workspace;
}

async function seed(dataDir: string, workspace: string): Promise<number> {
  const db = new MemoryDB(join(dataDir, 'kiro-mem.db'));
  db.upsertSessionRef({ session_id: SESSION_HINT, cwd: workspace, repo: workspace });
  let targetId = 0;
  for (const f of FIXTURES) {
    const seq = db.allocateNextTurnSeq(SESSION_HINT);
    const turn = db.createTurn({
      session_id: SESSION_HINT, seq, cwd: workspace, repo: workspace, prompt_text: f.title,
    });
    db.markTurnClosed(turn.id);
    const at = new Date(Date.now() - (FIXTURES.length - seq) * 3600_000).toISOString();
    const id = db.insertObservation({
      turn_id: turn.id, session_id: SESSION_HINT, turn_seq: seq, repo: workspace, cwd_scope: workspace,
      title: f.title, summary: f.summary, outcome: f.outcome, learned: f.learned,
      memory_type: 'change', quality: 'normal',
      concepts: [...f.concepts], files_touched: [...f.files],
      turn_started_at: at, turn_stopped_at: at,
    })!;
    if (f.isTarget) targetId = id;
    db.upsertObservationSemanticText({
      observation_id: id, protocol: SEMANTIC_EN_PROTOCOL, status: 'ready',
      payload: { ...f.en, concepts: [...f.en.concepts] } as any,
      translator: 'fixture', translator_version: PACKAGE_VERSION, attempts: 1,
    });
    for (const [space, text] of [
      [embeddingSpaceKey(RAW_PROTOCOL), buildObservationSearchText({
        title: f.title, summary: f.summary, outcome: f.outcome, learned: f.learned,
        concepts: [...f.concepts], files: [...f.files],
      })],
      [embeddingSpaceKey(SEMANTIC_EN_PROTOCOL), buildObservationSearchText(
        semanticEnSearchTextFields({ ...f.en, concepts: [...f.en.concepts] } as any, [...f.files]),
      )],
    ] as const) {
      const vec = await generateEmbedding(text);
      db.upsertObservationEmbedding(id, space, DIMENSIONS, embeddingToBlob(vec));
    }
  }
  db.close();
  return targetId;
}

/** 播种后立刻自检：scope_key 与 embedding space 到底写成了什么。 */
function inspectSeed(dataDir: string): void {
  const db = new MemoryDB(join(dataDir, 'kiro-mem.db'));
  const raw = (db as any).db as { query(sql: string): { all(): unknown[] } };
  console.log('[q6-capture] observations:', JSON.stringify(
    raw.query('SELECT id, scope_key, repo, cwd_scope FROM observations').all(),
  ));
  console.log('[q6-capture] embeddings:', JSON.stringify(
    raw.query('SELECT observation_id, model, dimensions FROM observation_embeddings').all(),
  ));
  db.close();
}

async function startWorker(dataDir: string, port: number) {
  const proc = spawn({
    cmd: ['bun', 'run', join(PKG_ROOT, 'src', 'server', 'worker.ts')],
    cwd: PKG_ROOT,
    env: { ...process.env, KIRO_MEMORY_DATA_DIR: dataDir },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (proc.exitCode != null) {
      const err = await new Response(proc.stderr as ReadableStream).text();
      throw new Error(`Worker 退出 (${proc.exitCode}): ${err.slice(0, 800)}`);
    }
    if (existsSync(join(dataDir, '.worker.port'))) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return proc;
      } catch { /* 还没起来 */ }
    }
    await Bun.sleep(250);
  }
  try { proc.kill(); } catch { /* gone */ }
  throw new Error('Worker 30s 内没有就绪');
}

/** 与生产 MCP server 做一次最小 JSON-RPC 会话，返回每个 query 的 search 响应**原始行**。 */
async function captureRawSearchLines(
  dataDir: string,
  workspace: string,
  queries: { id: number; zh: string; en: string }[],
): Promise<Map<number, string>> {
  const proc = spawn({
    cmd: ['bun', 'run', join(PKG_ROOT, 'src', 'server', 'mcp-server.ts')],
    cwd: PKG_ROOT,
    env: { ...process.env, KIRO_MEMORY_DATA_DIR: dataDir, KIRO_SESSION_ID: SESSION_HINT },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const w = proc.stdin as unknown as { write(d: Uint8Array): void; end(): void };
  const send = (o: unknown) => w.write(new TextEncoder().encode(`${JSON.stringify(o)}\n`));

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'q6-capture', version: '1' },
  } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  for (const q of queries) {
    send({ jsonrpc: '2.0', id: q.id, method: 'tools/call', params: {
      name: 'search',
      arguments: { query: q.zh, semantic_query_en: q.en, cwd: workspace, repo: workspace, limit: 10 },
    } });
  }

  const want = new Set(queries.map((q) => q.id));
  const got = new Map<number, string>();
  let buf = '';
  const deadline = Date.now() + 90_000;
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  while (Date.now() < deadline && got.size < want.size) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += new TextDecoder().decode(value);
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const id = JSON.parse(line)?.id;
        if (typeof id === 'number' && want.has(id)) got.set(id, line);
      } catch { /* 非 JSON，跳过 */ }
    }
  }
  try { reader.releaseLock(); } catch { /* ignore */ }
  try { w.end(); } catch { /* ignore */ }
  try { proc.kill(); } catch { /* ignore */ }

  if (got.size < want.size) {
    const err = await new Response(proc.stderr as ReadableStream).text();
    throw new Error(`只收到 ${got.size}/${want.size} 个 search 响应。stderr:\n${err.slice(0, 1200)}`);
  }
  return got;
}

// ---------------------------------------------------------------------------

const workerPort = await borrowFreePort();
const dataDir = mkdtempSync(join(tmpdir(), 'q6-capture-dd-'));
// macOS 的 tmpdir 是 /var/folders/... 而 /var 是 /private/var 的 symlink，
// 而 `computeScopeKey` 会 realpath。若播种与搜索两侧用了不同形式，scope key 不一致，
// 搜索会落到一个零向量的 scope（实测症状：scopeVectors=0 / emptyScopeRequests=1）。
const workspace = realpathSync.native(mkdtempSync(join(tmpdir(), 'q6-capture-ws-')));
let worker: Awaited<ReturnType<typeof startWorker>> | null = null;

try {
  layoutDataDir(dataDir, workspace, workerPort);
  console.log('[q6-capture] 播种中（真实编码，约需十几秒）…');
  const targetId = await seed(dataDir, workspace);
  console.log(`[q6-capture] 目标 Observation id = ${targetId}`);
  console.log(`[q6-capture] workspace = ${workspace}`);
  inspectSeed(dataDir);

  worker = await startWorker(dataDir, workerPort);
  console.log(`[q6-capture] Worker 就绪 :${workerPort}`);

  const lines = await captureRawSearchLines(dataDir, workspace, [
    { id: 2, zh: QUERY_ZH, en: QUERY_EN },
    { id: 3, zh: QUERY2_ZH, en: QUERY2_EN },
  ]);

  const samples = [
    { rpcId: 2, label: 'semantic-only', queryZh: QUERY_ZH, querySemanticEn: QUERY_EN, minCards: 1 },
    { rpcId: 3, label: 'mixed-source', queryZh: QUERY2_ZH, querySemanticEn: QUERY2_EN, minCards: 2 },
  ].map((s) => {
    const rawLine = lines.get(s.rpcId)!;
    const cards: any[] = JSON.parse(JSON.parse(rawLine).result.content[0].text).results;
    const target = cards.find((c) => c.id === targetId);
    console.log(`[q6-capture] #${s.rpcId} ${s.label}：返回 ${cards.length} 张卡 ` +
      cards.map((c) => `${c.id}:${c.match_source ?? '(none)'}`).join(' '));
    return { ...s, rawLine, cards, target };
  });

  // 断言而不是祈祷：每个样本都必须真的含一张 semantic 目标卡，否则它证明不了 Q6 要证的事。
  for (const s of samples) {
    if (!s.target) {
      console.error('[q6-capture] 原始响应：');
      console.error(s.rawLine.slice(0, 2000));
      try {
        const h = await (await fetch(`http://127.0.0.1:${workerPort}/health`)).json();
        console.error(`[q6-capture] /health search_24h：\n${JSON.stringify((h as any).search_24h ?? h, null, 2).slice(0, 2500)}`);
      } catch (e) {
        console.error(`[q6-capture] /health 读取失败：${String(e)}`);
      }
      throw new Error(`#${s.rpcId}：目标卡 ${targetId} 不在返回页上。实际：${JSON.stringify(s.cards.map((c) => c.id))}`);
    }
    if (s.target.match_source !== 'semantic') {
      throw new Error(
        `#${s.rpcId}：目标卡的 match_source 是 "${s.target.match_source}"，不是 "semantic"。` +
        `说明中文问法与目标记录仍有 3 字窗口重叠，需要改写后重跑。`,
      );
    }
    if (s.cards.length < s.minCards) {
      throw new Error(
        `#${s.rpcId}（${s.label}）只有 ${s.cards.length} 张卡，少于要求的 ${s.minCards}。` +
        (s.minCards > 1
          ? '多卡页是 S1 "非目标卡保留自己标签"那一条的前提，单卡页会让它空跑。'
          : ''),
      );
    }
  }

  const mixed = samples.find((s) => s.label === 'mixed-source')!;
  const nonTargetSources = mixed.cards.filter((c) => c.id !== targetId).map((c) => c.match_source);
  if (!nonTargetSources.some((s) => s && s !== 'semantic')) {
    throw new Error(
      `mixed-source 样本里没有非 semantic 来源的卡（实际 ${JSON.stringify(nonTargetSources)}）。` +
      '词面锚点没生效，需要改写 QUERY2_ZH。',
    );
  }

  mkdirSync(dirname(OUT), { recursive: true });
  const captured = {
    purpose: 'Q6 S1 预检的固定捕获样本（判据 §8.1）。真实 mcp-server 产出，未经任何改写。',
    capturedAt: new Date().toISOString(),
    provenance: {
      mcpServer: 'src/server/mcp-server.ts',
      packageVersion: PACKAGE_VERSION,
      seededObservations: FIXTURES.length,
      note: '本样本仅用于验证 wire 级投影；不是 §3 的实验 fixture，不参与任何 H 门。',
    },
    targetObservationId: targetId,
    samples: samples.map((s) => ({
      label: s.label,
      rpcId: s.rpcId,
      queryZh: s.queryZh,
      querySemanticEn: s.querySemanticEn,
      cardIds: s.cards.map((c) => c.id),
      cardSources: s.cards.map((c) => c.match_source ?? null),
      rawLine: s.rawLine,
      rawLineSha256: createHash('sha256').update(s.rawLine).digest('hex'),
    })),
  };
  writeFileSync(OUT, `${JSON.stringify(captured, null, 2)}\n`);
  console.log(`[q6-capture] 已写出 ${OUT}`);
  for (const s of captured.samples) {
    console.log(`[q6-capture]   ${s.label}: sha256=${s.rawLineSha256.slice(0, 16)} sources=${JSON.stringify(s.cardSources)}`);
  }
} finally {
  try { worker?.kill(); } catch { /* ignore */ }
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
}
