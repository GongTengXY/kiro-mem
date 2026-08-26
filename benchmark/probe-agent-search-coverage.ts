/**
 * 灰度实测：真实 Agent 路径上的 `semantic_query_en` 覆盖率（方案 §8.3）。
 *
 * ## 为什么离线基准不够
 *
 * 阶段 2B 的每一条 query 都由固定输入提供英文形式，所以 145/145 走 `semantic-en-v1`。
 * 生产里那个值由**模型在调用 `search` 时**顺手给出——schema 里写着"必须传"不等于真的
 * 会传。独立语义召回只在英文空间成立，因此"覆盖率"决定了这个功能在生产里是否可达，
 * 而它无法从离线报告推断。方案 §8.3 明确不预设一个没有生产基线支撑的硬数字：这个脚本
 * 的产出是**实测分布**，判不判通过由 Codex 决定。
 *
 * ## 测什么、怎么测
 *
 * 起一个与生产同构的隔离环境（临时 dataDir + 临时 KIRO_HOME + 真实 Worker），用真实
 * `kiro-cli acp --agent kiro-mem` 跑真实会话，让模型自己决定要不要搜、怎么搜，然后只读
 * `metric_events`：协议分布、缺失/被拒原因、降级率、zero-FTS 与 semantic-only 返回量。
 * 这些计数器就是 2C 交付的观测面，所以这一次运行同时验证了"指标真的会落盘"。
 *
 * ## 隔离（Gate C P1 整改）
 *
 * 这个脚本**不导入** `src/server/worker.ts`。那个模块在顶层就构造生产单例
 * （`loadConfig()` + `new MemoryDB()`），ESM 会在本文件第一行代码执行之前跑完它，于是
 * 真实的 `~/.kiro-mem/kiro-mem.db` 被打开并迁移——"只用临时目录"这句 provenance 就不
 * 成立了。`bun test` 靠 `tests/support/preload.ts` 提前改掉 dataDir 才没踩到，benchmark
 * 脚本没有那层保护。
 *
 * 所以 Worker 按生产方式**以子进程启动**（`bun run src/server/worker.ts` + 隔离的
 * `KIRO_MEMORY_DATA_DIR`），这既让隔离在结构上成立，也顺带去掉了本进程里的
 * `Bun.serve`——Bun 1.2.20 下"先跑多次 embedding 再 Bun.serve({port:0})"会崩，而
 * `worker.ts` 顶层注册的 `uncaughtException` 处理器只记日志，于是崩了还退出码 0。
 * 本脚本自己管退出码：任何一步失败都 `exit(1)`，没采到 search 指标也算失败。
 *
 * 不碰真实用户库（方案 §14.9）：dataDir 与 KIRO_HOME 都在 tmpdir 下，退出时删除。
 *
 * ## 已知边界
 *
 * - 样本是本脚本内置的 prompt 集，不是真实用户流量；它只能证明"这个 agent 定义 + 这个
 *   prompt 在这个模型下会不会传英文形式"。
 * - agent JSON 去掉了 `resources`（skill/steering 通配）：那些文件属于开发者本机，不属于
 *   发布物，留着会让读数不可复现。其余字段与 `kiro-mem install` 写下的完全一致。
 * - 会话被 hooks 采集进临时库，摘要走 stub 压缩器（不额外起 kiro-cli 进程）。
 *
 * 用法：
 *   bun run benchmark/probe-agent-search-coverage.ts \
 *     [--report=benchmark/reports/phase2c-agent-coverage.md] \
 *     [--json=benchmark/reports/phase2c-agent-coverage.json] [--keep]
 */

import { spawn, type Subprocess } from 'bun';
import { mkdirSync, mkdtempSync, copyFileSync, symlinkSync, writeFileSync, rmSync, readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { MemoryDB } from '../src/db';
import { generateEmbedding, embeddingToBlob, buildObservationSearchText, DIMENSIONS } from '../src/embedding';
import {
  RAW_PROTOCOL,
  SEMANTIC_EN_PROTOCOL,
  embeddingSpaceKey,
  semanticEnSearchTextFields,
  type SemanticEnRecord,
} from '../src/semantic-en';
import { PACKAGE_VERSION } from '../src/version';

const PKG_ROOT = resolve(import.meta.dir, '..');
const args = process.argv.slice(2);
const flag = (name: string, dflt?: string): string | undefined => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const KEEP = args.includes('--keep');
/**
 * 独立 ACP 会话的轮数（Gate C 第二轮整改）。
 *
 * 单轮不足以描述"Agent 会不会稳定选择 search"：Codex 独立跑到过一轮 5 条 prompt 全部
 * 正常结束、却一次都没调用 search 的情况。多轮才能把这种波动量化，而不是靠重跑到一次
 * 好看的结果。
 */
const ROUNDS = Math.max(1, Number(flag('rounds', '3')));
const REPORT = resolve(flag('report', join(import.meta.dir, 'reports', 'phase2c-agent-coverage.md'))!);
const JSON_OUT = resolve(flag('json', join(import.meta.dir, 'reports', 'phase2c-agent-coverage.json'))!);
const TOKEN = 'c'.repeat(64);
const SESSION_HINT = 'kiro-mem-gray-probe';

/** 一行 search 指标（只有计数与枚举，没有正文）。 */
interface MetricRow {
  id?: number;
  protocol: string | null;
  reject_reason: string | null;
  fts_count: number | null;
  semantic_count: number | null;
  comparable_vectors: number | null;
  scope_vectors: number | null;
  semantic_only: number | null;
  discovery: number | null;
  degraded: number | null;
  latency_ms: number | null;
}

interface RoundTurn {
  round: number;
  prompt: string;
  stopReason: string;
  toolCalls: string[];
  /** 观察到的 `@kiro-mem/search` 工具调用次数（含 tool_call_update 重复上报）。 */
  searchToolCalls: number;
  /** 真正走到检索内核并落盘的 search 行数。 */
  searchMetricRows: number;
  semanticEnRows: number;
  rejectedOrMissingRows: number;
  rows: MetricRow[];
  error?: string;
}

interface RoundResult {
  round: number;
  sessionId: string | null;
  sessionError?: string;
  turns: RoundTurn[];
  prompts: number;
  promptsWithSearch: number;
  stderrTail: string[];
}

// ---------------------------------------------------------------------------
// 语料：6 条中文 Observation + 人工英文派生值
// ---------------------------------------------------------------------------
//
// 内容是**虚构的历史工作**，不是本仓库的真实记录：这个脚本测的是 query 侧行为，用真实
// 记录只会把仓库内容混进报告。英文派生值由人写死（不经 ACP），所以记录侧不参与波动。
interface Fixture {
  title: string;
  summary: string;
  outcome: string;
  learned: string;
  concepts: string[];
  files: string[];
  en: SemanticEnRecord;
}

const FIXTURES: Fixture[] = [
  {
    title: '凭据轮换脚本改成先写新密钥再切读端',
    summary: '轮换过程中读端还指向旧密钥，导致切换窗口内认证失败；改成双写后再切读端。',
    outcome: '切换窗口从 40 秒降到 0，验证脚本连续跑 20 次无 401。',
    learned: '轮换的顺序问题不是加重试能解决的，读写端必须有重叠期。',
    concepts: ['凭据轮换', '双写', '认证失败'],
    files: ['ops/rotate-credentials.sh'],
    en: {
      title: 'Credential rotation now writes the new key before switching readers',
      summary: 'During rotation the readers still pointed at the old key, so authentication failed inside the switch window; changed to dual-write and then move the readers.',
      outcome: 'The switch window dropped from 40 seconds to 0; the verification script ran 20 times with no 401.',
      learned: 'An ordering problem in rotation is not solved by retries; readers and writers need an overlap period.',
      concepts: ['credential rotation', 'dual write', 'authentication failure'],
    },
  },
  {
    title: '任务队列的重试退避从固定 1 秒改成指数',
    summary: '下游超时时固定退避把队列打满，改成指数退避加抖动，并给死信状态单独计数。',
    outcome: '同一负载下重试次数减少 68%，死信数量从 14 降到 2。',
    learned: '固定退避在下游变慢时会放大压力，退避必须跟着失败次数走。',
    concepts: ['重试退避', '指数退避', '死信'],
    files: ['src/jobs/runner.ts'],
    en: {
      title: 'Job queue retry backoff changed from a flat 1s to exponential',
      summary: 'A flat backoff saturated the queue when the downstream timed out; switched to exponential backoff with jitter and counted the dead-letter state separately.',
      outcome: 'Under the same load retries dropped 68% and dead-lettered jobs went from 14 to 2.',
      learned: 'A flat backoff amplifies pressure when the downstream slows down; backoff has to follow the failure count.',
      concepts: ['retry backoff', 'exponential backoff', 'dead letter'],
    },
  },
  {
    title: '搜索接口对空结果返回 200 而不是 404',
    summary: '前端把 404 当成接口坏了并弹错误提示，改成 200 + 空数组，并在响应里带上过滤条件。',
    outcome: '错误提示消失，前端不再需要区分"没搜到"和"接口挂了"。',
    learned: '"没有数据"是正常结果，用错误码表达它会把正常路径变成异常路径。',
    concepts: ['空结果语义', 'HTTP 状态码', '前端错误提示'],
    files: ['src/server/routes/search.ts'],
    en: {
      title: 'Search endpoint returns 200 with an empty list instead of 404',
      summary: 'The frontend treated 404 as a broken endpoint and showed an error toast; changed to 200 with an empty array and echoed the filters in the response.',
      outcome: 'The error toast is gone and the frontend no longer has to tell "nothing found" apart from "the endpoint is down".',
      learned: '"No data" is a normal result; expressing it with an error status turns the normal path into an exception path.',
      concepts: ['empty result semantics', 'HTTP status code', 'frontend error toast'],
    },
  },
  {
    title: '构建缓存键漏了 lockfile 导致依赖升级不生效',
    summary: '缓存键只含 package.json，升级依赖后 CI 仍命中旧缓存，改成把 lockfile 哈希纳入键。',
    outcome: 'CI 首次冷启动 4 分 20 秒，之后命中缓存 55 秒，且依赖升级会正确失效。',
    learned: '缓存键必须覆盖所有能改变产物的输入，少一个就是静默的错误结果。',
    concepts: ['构建缓存', 'lockfile', 'CI'],
    files: ['.github/workflows/ci.yml'],
    en: {
      title: 'Build cache key was missing the lockfile, so dependency upgrades did not take effect',
      summary: 'The cache key only covered package.json, so CI kept hitting a stale cache after upgrades; the lockfile hash is now part of the key.',
      outcome: 'A cold CI run takes 4m20s and a warm one 55s, and a dependency upgrade correctly invalidates the cache.',
      learned: 'A cache key has to cover every input that can change the artifact; one missing input is a silently wrong result.',
      concepts: ['build cache', 'lockfile', 'CI'],
    },
  },
  {
    title: '日志里打印了完整请求体，含用户手机号',
    summary: '排查问题时加的调试日志留在了生产代码里，把整个请求体写进日志文件。',
    outcome: '移除该日志并加了字段白名单，历史日志按保留期清理。',
    learned: '调试日志要么带开关，要么不要打印整个 payload——留下来的那次不会有人记得。',
    concepts: ['日志脱敏', '个人信息', '字段白名单'],
    files: ['src/server/middleware/logging.ts'],
    en: {
      title: 'Logs printed the full request body, including user phone numbers',
      summary: 'A debug log added while investigating an issue stayed in production code and wrote the entire request body to the log file.',
      outcome: 'Removed the log, added a field allowlist, and purged historical logs per the retention window.',
      learned: 'A debug log either has a switch or does not print the whole payload; nobody remembers the one that was left behind.',
      concepts: ['log redaction', 'personal information', 'field allowlist'],
    },
  },
  {
    title: '迁移脚本在大表上加索引把写入卡住了',
    summary: '直接 CREATE INDEX 持锁 6 分钟，期间写入全部排队；改成并发建索引并分批回填。',
    outcome: '写入延迟峰值从 6 分钟降到 300 毫秒以内，索引在 11 分钟内建完。',
    learned: '大表上的 DDL 要按"能不能被中断"来选方案，而不是按语句短不短。',
    concepts: ['在线 DDL', '并发建索引', '写入延迟'],
    files: ['migrations/0042_add_index.sql'],
    en: {
      title: 'A migration adding an index on a large table blocked writes',
      summary: 'A plain CREATE INDEX held the lock for 6 minutes and queued every write; switched to a concurrent index build with batched backfill.',
      outcome: 'Peak write latency fell from 6 minutes to under 300ms and the index finished in 11 minutes.',
      learned: 'DDL on a large table should be chosen by whether it can be interrupted, not by how short the statement looks.',
      concepts: ['online DDL', 'concurrent index build', 'write latency'],
    },
  },
];

/**
 * 会话 prompt：4 条"要查历史"的问法 + 1 条本项目从未做过的事。
 *
 * 前 3 条与语料**词面重叠很低**（"密钥切换顺序"对"凭据轮换"、"越查越慢"对"重试退避"），
 * 所以只有独立语义召回能找回；第 4 条完全零重叠；第 5 条是 hard negative，用来看模型在
 * 拿到 semantic-only 结果时会不会照单全收。
 */
const PROMPTS = [
  '我们之前处理密钥切换顺序的那次改动，具体是怎么做的？',
  '以前有没有遇到过下游变慢之后越查越慢、把队列打满的问题？',
  '前端为什么会把"没搜到"当成接口坏了？当时怎么收口的？',
  '有没有哪次改动是因为把用户信息写进了不该写的地方？',
  '我们做过 Kubernetes 上的 Istio 灰度发布吗？',
];

// ---------------------------------------------------------------------------
// 环境搭建
// ---------------------------------------------------------------------------

const dataDir = mkdtempSync(join(tmpdir(), 'kiro-mem-gray-data-'));
const kiroHome = mkdtempSync(join(tmpdir(), 'kiro-mem-gray-home-'));
const workspace = mkdtempSync(join(tmpdir(), 'kiro-mem-gray-ws-'));

/**
 * 借一个空闲端口。
 *
 * 必须在加载模型之前做完：Bun 1.2.20 下先跑 embedding 再 `Bun.serve` 会崩。生产 Worker
 * 从 `config.worker.port` 取端口，默认 37778——那正是用户真实 Worker 占用的端口，所以
 * 临时 config 必须换一个，否则这次探针会去戳用户的进程。
 */
function borrowFreePort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response('') });
  const p = s.port;
  s.stop(true);
  if (!p) throw new Error('无法借到空闲端口');
  return p;
}
const WORKER_PORT = borrowFreePort();

function layoutDataDir(): void {
  mkdirSync(join(dataDir, 'logs'), { recursive: true });
  writeFileSync(join(dataDir, '.token'), TOKEN, { mode: 0o600 });
  // 生产 profile：显式写出灰度开关，和 `kiro-mem install` 写下的一致；端口换成借到的
  // 空闲端口，避免撞上用户真实 Worker。
  writeFileSync(
    join(dataDir, 'config.json'),
    JSON.stringify(
      {
        language: 'zh',
        worker: { port: WORKER_PORT, host: '127.0.0.1', logLevel: 'info' },
        compression: { concurrency: 1, timeoutMs: 30000, maxRetries: 2 },
        retrieval: { semanticDiscovery: true },
        runtime: { kiroHome: '' },
      },
      null,
      2,
    ),
  );
  // agent JSON 引用 `<dataDir>/src/...` 与 `<dataDir>/hooks/...`（install 会把包复制进去），
  // 这里用 symlink 指回仓库，测的就是当前工作区的代码。
  symlinkSync(join(PKG_ROOT, 'src'), join(dataDir, 'src'));
  symlinkSync(join(PKG_ROOT, 'src', 'hooks'), join(dataDir, 'hooks'));
  copyFileSync(join(PKG_ROOT, 'src', 'agent', 'prompt.md'), join(dataDir, 'prompt.md'));

  // kiro-runtime：`startWorker()` 会先跑 checkRuntimeHome，布局不全直接 exit(1)。
  // 按 install 的布局写：agents/<name>.json + <name>-prompt.md + sessions/。
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
}

function layoutKiroHome(): void {
  mkdirSync(join(kiroHome, 'agents'), { recursive: true });
  const tpl = JSON.parse(
    readFileSync(join(PKG_ROOT, 'src', 'agent', 'kiro-mem.json'), 'utf-8').replaceAll(
      '__KIRO_MEMORY_DIR__',
      dataDir,
    ),
  );
  // 见文件头「已知边界」：只去掉 resources，其余保持发布物原样。
  delete tpl.resources;
  // MCP server 进程靠 KIRO_SESSION_ID 解析默认 scope（生产里由 Kiro 注入）。ACP 模式下
  // 不保证注入，所以显式给一个，并在库里预置对应 session_ref —— 否则默认 scope 解析失败，
  // 测到的就是"agent 会不会补 cwd 参数"，而不是覆盖率。
  tpl.mcpServers['kiro-mem'].env.KIRO_SESSION_ID = SESSION_HINT;
  writeFileSync(join(kiroHome, 'agents', 'kiro-mem.json'), JSON.stringify(tpl, null, 2));
}

async function seedCorpus(db: MemoryDB): Promise<number[]> {
  db.upsertSessionRef({ session_id: SESSION_HINT, cwd: workspace, repo: workspace });
  const ids: number[] = [];
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
      concepts: f.concepts, files_touched: f.files,
      turn_started_at: at, turn_stopped_at: at,
    })!;
    ids.push(id);
    db.upsertObservationSemanticText({
      observation_id: id, protocol: SEMANTIC_EN_PROTOCOL, status: 'ready', payload: f.en,
      translator: 'fixture', translator_version: PACKAGE_VERSION, attempts: 1,
    });
    // 两个空间都建向量，和生产 embed_observation 用同一套文本拼接。
    for (const [space, text] of [
      [embeddingSpaceKey(RAW_PROTOCOL), buildObservationSearchText({
        title: f.title, summary: f.summary, outcome: f.outcome, learned: f.learned,
        concepts: f.concepts, files: f.files,
      })],
      [embeddingSpaceKey(SEMANTIC_EN_PROTOCOL), buildObservationSearchText(
        semanticEnSearchTextFields(f.en, f.files),
      )],
    ] as const) {
      const vec = await generateEmbedding(text);
      db.upsertObservationEmbedding(id, space, DIMENSIONS, embeddingToBlob(vec));
    }
  }
  return ids;
}

/**
 * 以生产方式启动 Worker：子进程 + 隔离 `KIRO_MEMORY_DATA_DIR`。
 *
 * 这样本进程完全不加载 `worker.ts`（见文件头「隔离」），Worker 自己写 `.worker.port`，
 * MCP server 与 hooks 按生产路径找到它。摘要走真实 ACP 压缩器（临时 kiro-runtime 已就位）。
 */
async function startWorkerProcess(): Promise<Subprocess> {
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
      throw new Error(`Worker 子进程退出 (${proc.exitCode}): ${err.slice(0, 800)}`);
    }
    if (existsSync(join(dataDir, '.worker.port'))) {
      try {
        const r = await fetch(`http://127.0.0.1:${WORKER_PORT}/health`);
        if (r.ok) return proc;
      } catch { /* 还没起来 */ }
    }
    await Bun.sleep(250);
  }
  try { proc.kill(); } catch { /* gone */ }
  throw new Error('Worker 30s 内没有就绪');
}

// ---------------------------------------------------------------------------
// 最小 ACP 客户端（要能回应 agent→client 的请求，否则会话会卡住）
// ---------------------------------------------------------------------------

interface ToolCallSeen { name: string; status?: string }

class ProbeSession {
  private proc: Subprocess;
  private buf = '';
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private reader: { read: () => Promise<{ value?: Uint8Array; done: boolean }> };
  private decoder = new TextDecoder();
  sessionId = '';
  toolCalls: ToolCallSeen[] = [];
  text: string[] = [];
  stderr: string[] = [];

  constructor() {
    this.proc = spawn({
      // --trust-all-tools：没有它每次工具调用都会等一个人类确认，测不出任何东西。
      cmd: ['kiro-cli', 'acp', '--agent', 'kiro-mem', '--trust-all-tools'],
      cwd: workspace,
      env: { ...process.env, KIRO_HOME: kiroHome, KIRO_MEMORY_DATA_DIR: dataDir },
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    });
    this.reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
    this.pumpStderr();
  }

  private async pumpStderr(): Promise<void> {
    const r = (this.proc.stderr as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await r.read();
        if (done) break;
        const s = dec.decode(value, { stream: true }).trim();
        if (s) this.stderr.push(s.slice(0, 2000));
      }
    } catch { /* closed */ }
  }

  private send(obj: unknown): void {
    const stdin = this.proc.stdin as { write: (s: string) => void; flush?: () => void };
    stdin.write(JSON.stringify(obj) + '\n');
    stdin.flush?.();
  }

  /** 处理一行：响应 / 通知 / **agent 发来的请求**。 */
  private handle(msg: any): void {
    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method && msg.id != null) {
      // agent → client 请求。不回就是死锁。
      if (msg.method === 'session/request_permission') {
        const options = msg.params?.options ?? [];
        const allow = options.find((o: any) => /allow/i.test(o.kind ?? o.optionId ?? '')) ?? options[0];
        this.send({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'selected', optionId: allow?.optionId } } });
      } else {
        // fs/terminal 之类：我们没声明这些能力，明确报错比静默挂着好。
        this.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unsupported: ${msg.method}` } });
      }
      return;
    }
    if (msg.method === 'session/update' || msg.method === 'session/notification') {
      const u = msg.params?.update ?? {};
      const kind = u.sessionUpdate ?? u.type ?? Object.keys(u)[0];
      if (kind === 'tool_call' || kind === 'tool_call_update') {
        const inner = u.tool_call ?? u.toolCall ?? u;
        const name = String(inner.title ?? inner.name ?? inner.rawInput?.name ?? 'unknown');
        this.toolCalls.push({ name, status: inner.status });
      } else if (kind === 'agent_message_chunk') {
        const c = u.content ?? u.agent_message_chunk?.content;
        const t = typeof c?.text === 'string' ? c.text : '';
        if (t) this.text.push(t);
      }
    }
  }

  private async pumpUntil(id: number, timeoutMs: number): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    return await new Promise<any>((resolvePending, rejectPending) => {
      this.pending.set(id, { resolve: resolvePending, reject: rejectPending });
      (async () => {
        while (Date.now() < deadline) {
          if (!this.pending.has(id)) return;
          let nl: number;
          while ((nl = this.buf.indexOf('\n')) >= 0) {
            const line = this.buf.slice(0, nl).trim();
            this.buf = this.buf.slice(nl + 1);
            if (line) { try { this.handle(JSON.parse(line)); } catch { /* 非 JSON */ } }
            if (!this.pending.has(id)) return;
          }
          const { value, done } = await this.reader.read();
          if (done) break;
          this.buf += this.decoder.decode(value, { stream: true });
        }
        const p = this.pending.get(id);
        if (p) { this.pending.delete(id); p.reject(new Error(`timeout waiting id=${id}`)); }
      })();
    });
  }

  private async request(method: string, params: unknown, timeoutMs: number): Promise<any> {
    const id = this.nextId++;
    this.send({ jsonrpc: '2.0', id, method, params });
    return this.pumpUntil(id, timeoutMs);
  }

  async start(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      clientInfo: { name: 'kiro-mem-gray-probe', version: PACKAGE_VERSION },
    }, 30_000);
    const s = await this.request('session/new', { cwd: workspace, mcpServers: [] }, 60_000);
    this.sessionId = s.sessionId;
  }

  async prompt(text: string, timeoutMs = 180_000): Promise<string> {
    const r = await this.request('session/prompt', {
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text }],
    }, timeoutMs);
    return String(r?.stopReason ?? 'unknown');
  }

  kill(): void { try { this.proc.kill(); } catch { /* gone */ } }
}

// ---------------------------------------------------------------------------
// 运行
// ---------------------------------------------------------------------------

layoutDataDir();
layoutKiroHome();

/** 任何一步失败都必须让退出码非 0：一个"没测到任何东西"的探针不能长得像通过。 */
function die(msg: string, err?: unknown): never {
  console.error(`[gray] ✗ ${msg}${err ? `: ${err instanceof Error ? err.message : String(err)}` : ''}`);
  cleanup();
  process.exit(1);
}

let worker: Subprocess | null = null;
let activeSession: ProbeSession | null = null;
function cleanup(): void {
  try { activeSession?.kill(); } catch { /* gone */ }
  try { worker?.kill(); } catch { /* gone */ }
  if (!KEEP) {
    for (const d of [dataDir, kiroHome, workspace]) rmSync(d, { recursive: true, force: true });
  } else {
    console.log(`[gray] 保留：${dataDir} ${kiroHome} ${workspace}`);
  }
}

let seeded: number[] = [];
{
  const db = new MemoryDB(join(dataDir, 'kiro-mem.db'));
  try {
    console.log('[gray] 播种语料（真实本地模型建向量）…');
    seeded = await seedCorpus(db);
    console.log(`[gray] 已播种 ${seeded.length} 条 Observation`);
  } catch (e) {
    db.close();
    die('播种失败', e);
  }
  // 交给 Worker 子进程之前先放开这个句柄；后面读指标时重新打开。
  db.close();
}

try {
  worker = await startWorkerProcess();
  console.log(`[gray] Worker 子进程就绪 :${WORKER_PORT}`);
} catch (e) {
  die('Worker 启动失败', e);
}

const turns: RoundTurn[] = [];
const rounds: RoundResult[] = [];

/** 读当前 search 指标最大 id，用来把后续行归属到某一条 prompt。 */
function metricHighWater(): number {
  const db = new MemoryDB(join(dataDir, 'kiro-mem.db'));
  const row = db.raw.query("SELECT COALESCE(MAX(id), 0) AS m FROM metric_events WHERE kind = 'search'").get() as { m: number };
  db.close();
  return row.m;
}

/** 取 id 大于水位线的 search 指标行。 */
function metricRowsSince(id: number): MetricRow[] {
  const db = new MemoryDB(join(dataDir, 'kiro-mem.db'));
  const rows = db.raw
    .query("SELECT id, protocol, reject_reason, fts_count, semantic_count, comparable_vectors, scope_vectors, semantic_only, discovery, degraded, latency_ms FROM metric_events WHERE kind = 'search' AND id > ? ORDER BY id")
    .all(id) as MetricRow[];
  db.close();
  return rows;
}

/**
 * 跑一轮：一个全新的 `kiro-cli acp` 进程 + 一个新会话，依次问完所有 prompt。
 *
 * 每条 prompt 单独取指标行，因为 Gate C 要求把两种失败分开：**压根没调用 search**
 * 与**调用了 search 但英文形式缺失/被拒**。前者在指标表里表现为"没有行"，后者表现为
 * "有行但 reject_reason 非空"——只看聚合覆盖率会把前者算成"没有样本"，看起来像 100%。
 */
async function runRound(index: number): Promise<RoundResult> {
  console.log(`\n[gray] ===== round ${index + 1}/${ROUNDS} =====`);
  const session = new ProbeSession();
  activeSession = session;
  const roundTurns: RoundTurn[] = [];
  let sessionError: string | undefined;
  try {
    await session.start();
    console.log(`[gray] ACP 会话 ${session.sessionId}`);
    for (const p of PROMPTS) {
      const water = metricHighWater();
      const beforeCalls = session.toolCalls.length;
      console.log(`[gray] → ${p}`);
      let stopReason = 'error';
      let error: string | undefined;
      try {
        stopReason = await session.prompt(p);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        console.log(`[gray]   ✗ ${error}`);
      }
      const calls = session.toolCalls.slice(beforeCalls).map((t) => t.name);
      const rows = metricRowsSince(water);
      const turn: RoundTurn = {
        round: index + 1,
        prompt: p,
        stopReason,
        toolCalls: calls,
        searchToolCalls: calls.filter((n) => /@kiro-mem\/search/.test(n)).length,
        searchMetricRows: rows.length,
        semanticEnRows: rows.filter((r) => r.protocol === 'semantic-en-v1').length,
        rejectedOrMissingRows: rows.filter((r) => r.reject_reason != null).length,
        rows,
        ...(error ? { error } : {}),
      };
      roundTurns.push(turn);
      turns.push(turn);
      console.log(
        `[gray]   stop=${stopReason} search=${turn.searchMetricRows} 行` +
          `（en ${turn.semanticEnRows} / 缺失或被拒 ${turn.rejectedOrMissingRows}）` +
          `${turn.searchMetricRows === 0 ? ' ⚠ 未调用 search' : ''}`,
      );
    }
  } catch (e) {
    sessionError = e instanceof Error ? e.message : String(e);
    console.log(`[gray] ✗ 会话失败: ${sessionError}`);
  } finally {
    session.kill();
    activeSession = null;
  }
  return {
    round: index + 1,
    sessionId: session.sessionId || null,
    ...(sessionError ? { sessionError } : {}),
    turns: roundTurns,
    promptsWithSearch: roundTurns.filter((t) => t.searchMetricRows > 0).length,
    prompts: roundTurns.length,
    stderrTail: session.stderr.slice(-3),
  };
}

for (let i = 0; i < ROUNDS; i++) {
  rounds.push(await runRound(i));
}

// --- 读指标：这就是 2C 的观测面本身 ---
const db = new MemoryDB(join(dataDir, 'kiro-mem.db'));
const rows = db.raw
  .query("SELECT protocol, reject_reason, fts_count, semantic_count, comparable_vectors, scope_vectors, semantic_only, discovery, degraded, latency_ms FROM metric_events WHERE kind = 'search' ORDER BY id")
  .all() as Record<string, number | string | null>[];
const stats = db.getObservabilityStats().search24h;
db.close();

// 一次都没搜 = 这次运行对覆盖率一无所知。它是失败，不是 0%。
if (rows.length === 0) {
  const failed = turns.filter((t) => t.error).length;
  die(`${ROUNDS} 轮下来没有采到任何 search 指标（${failed}/${turns.length} 轮出错）——本次运行不构成覆盖率证据`);
}

/**
 * 会话级覆盖率：**需要检索的 prompt 里有多少真的调用了 search**。
 *
 * 这是 Gate C 新增的口径。旧报告只报"发生了的 search 里有多少走英文空间"，那个数字在
 * Agent 压根不搜的那一轮是 0/0，聚合起来仍然显示 100%——把"没证据"读成了"没问题"。
 */
const promptsTotal = turns.length;
const promptsWithSearch = turns.filter((t) => t.searchMetricRows > 0).length;
const promptsWithoutSearch = turns.filter((t) => t.searchMetricRows === 0);
const promptsToolCalledButNoRow = turns.filter((t) => t.searchToolCalls > 0 && t.searchMetricRows === 0).length;
const searchesTotal = turns.reduce((n, t) => n + t.searchMetricRows, 0);
const searchesSemanticEn = turns.reduce((n, t) => n + t.semanticEnRows, 0);
const searchesRejectedOrMissing = turns.reduce((n, t) => n + t.rejectedOrMissingRows, 0);

const summary = {
  rounds: ROUNDS,
  roundsWithSessionError: rounds.filter((r) => r.sessionError).length,
  roundsWithNoSearchAtAll: rounds.filter((r) => r.promptsWithSearch === 0).length,
  promptsTotal,
  promptsWithSearch,
  promptSearchRate: Number((promptsWithSearch / promptsTotal).toFixed(3)),
  promptsWithoutSearch: promptsWithoutSearch.length,
  promptsWithoutSearchDetail: promptsWithoutSearch.map((t) => ({ round: t.round, prompt: t.prompt, stopReason: t.stopReason })),
  promptsToolCalledButNoRow,
  searchesTotal,
  searchesSemanticEn,
  searchesRejectedOrMissing,
  searchMetricRows: rows.length,
  failedTurns: turns.filter((t) => t.error).length,
  ...stats,
};

console.log('\n[gray] === 实测覆盖率 ===');
console.log(`  轮次 / 会话出错          ${summary.rounds} / ${summary.roundsWithSessionError}`);
console.log(`  prompt 调用了 search     ${promptsWithSearch}/${promptsTotal} (${(summary.promptSearchRate * 100).toFixed(1)}%)`);
console.log(`  完全没搜的轮次           ${summary.roundsWithNoSearchAtAll}/${ROUNDS}`);
console.log(`  search 请求数            ${summary.searchMetricRows}`);
console.log(`  semantic-en-v1          ${stats.protocolSemanticEn} (${(stats.semanticEnRate * 100).toFixed(1)}%)`);
console.log(`  raw-v1                  ${stats.protocolRaw}`);
console.log(`  英文形式问题分布        ${JSON.stringify(stats.semanticQueryIssues)}`);
console.log(`  降级(FTS-only)          ${stats.ftsOnly} (${(stats.degradeRate * 100).toFixed(1)}%)`);
console.log(`  zero-FTS / 其中被召回   ${stats.zeroFts} / ${stats.zeroFtsRecalled}`);
console.log(`  semantic-only 总/均/最坏 ${stats.semanticOnlyTotal} / ${stats.semanticOnlyPerRequest} / ${stats.semanticOnlyMax}`);
console.log(`  可比向量均值            ${stats.comparableVectorsAvg}`);
console.log(`  延迟 p50 / p95          ${stats.latencyMsP50}ms / ${stats.latencyMsP95}ms`);

const kiroVersion = (() => {
  const p = Bun.spawnSync({ cmd: ['kiro-cli', '--version'] });
  return new TextDecoder().decode(p.stdout).trim();
})();
const git = (a: string[]) => new TextDecoder().decode(Bun.spawnSync({ cmd: ['git', ...a], cwd: PKG_ROOT }).stdout).trim();

const payload = {
  provenance: {
    generatedAt: new Date().toISOString(),
    commit: git(['rev-parse', '--short', 'HEAD']),
    dirty: git(['status', '--porcelain']).length > 0,
    kiroCli: kiroVersion,
    bun: Bun.version,
    packageVersion: PACKAGE_VERSION,
    agent: 'kiro-mem (install 模板，去掉 resources)',
    policy: 'DEFAULT_RETRIEVAL_POLICY (discovery=on floor=0.197 cap=2)',
    worker: `子进程 bun run src/server/worker.ts（隔离 KIRO_MEMORY_DATA_DIR，端口 ${WORKER_PORT}）`,
    workerImportedInProbe: false,
    dataDir: KEEP ? dataDir : '(临时目录，已删除)',
    seededObservations: seeded.length,
    rounds: ROUNDS,
    promptsPerRound: PROMPTS.length,
  },
  prompts: PROMPTS,
  fixtures: FIXTURES.map((f) => f.title),
  // 全部轮次都留档，成功的和失败的一样（Gate C：不得只保留成功报告）。
  rounds,
  turns,
  summary,
  rows,
  agentStderrTail: rounds.flatMap((r) => r.stderrTail).slice(-5),
};
writeFileSync(JSON_OUT, JSON.stringify(payload, null, 2));

const md: string[] = [];
md.push('# Phase 2C 灰度实测：真实 Agent 的检索行为与 `semantic_query_en` 覆盖率', '');
md.push('> 本报告只读 `metric_events`。里面没有 query 正文、没有 Observation 正文、没有 workspace 路径。', '');
md.push('## Provenance', '');
md.push('| 项 | 值 |', '| --- | --- |');
for (const [k, v] of Object.entries(payload.provenance)) md.push(`| ${k} | \`${String(v)}\` |`);
md.push('', '## 两种失败必须分开读', '');
md.push('| 口径 | 实测 | 含义 |', '| --- | ---: | --- |');
md.push(`| prompt 调用了 search | **${promptsWithSearch}/${promptsTotal}（${(summary.promptSearchRate * 100).toFixed(1)}%）** | Agent 是否稳定选择检索。0/0 会让下面那行显示 100%，所以它必须单独报 |`);
md.push(`| 完全没搜的轮次 | **${summary.roundsWithNoSearchAtAll}/${ROUNDS}** | 一整轮 prompt 都没触发检索 |`);
md.push(`| 调了工具但没落盘 | ${promptsToolCalledButNoRow} | 工具被调用却没进检索内核（如 scope 解析失败） |`);
md.push(`| search 走英文空间 | **${searchesSemanticEn}/${searchesTotal}** | 发生了的 search 里，英文形式合法的比例 |`);
md.push(`| search 缺失或被拒英文形式 | **${searchesRejectedOrMissing}/${searchesTotal}** | 传了但被护栏拒，或压根没传 |`);
md.push(`| 会话级错误 | ${summary.roundsWithSessionError}/${ROUNDS} | ACP 会话本身失败 |`);
md.push('', '## 逐轮结果（全部留档）', '');
md.push('| round | sessionId | prompt 调用 search | 会话错误 |', '| ---: | --- | ---: | --- |');
for (const r of rounds) {
  md.push(`| ${r.round} | \`${r.sessionId ?? '—'}\` | ${r.promptsWithSearch}/${r.prompts} | ${r.sessionError ? `❌ ${r.sessionError}` : '—'} |`);
}
md.push('', '### 逐 prompt', '');
md.push('| round | prompt | stopReason | search 行 | en | 缺失/被拒 | 备注 |');
md.push('| ---: | --- | --- | ---: | ---: | ---: | --- |');
for (const t of turns) {
  const note = t.error
    ? `❌ ${t.error}`
    : t.searchMetricRows === 0
      ? (t.searchToolCalls > 0 ? '⚠ 调了工具但没落盘' : '⚠ 未调用 search')
      : '';
  md.push(`| ${t.round} | ${t.prompt} | ${t.stopReason} | ${t.searchMetricRows} | ${t.semanticEnRows} | ${t.rejectedOrMissingRows} | ${note} |`);
}
md.push('', '## 实测读数（24h 窗口 = 本次运行）', '');
md.push('| 指标 | 实测 |', '| --- | ---: |');
md.push(`| search 请求数 | ${summary.searchMetricRows} |`);
md.push(`| \`semantic-en-v1\` 请求数 / 覆盖率 | ${stats.protocolSemanticEn} / ${(stats.semanticEnRate * 100).toFixed(1)}% |`);
md.push(`| \`raw-v1\` 请求数 | ${stats.protocolRaw} |`);
md.push(`| 英文形式问题分布 | \`${JSON.stringify(stats.semanticQueryIssues)}\` |`);
md.push(`| discovery 生效请求数 | ${stats.discoveryEffective} |`);
md.push(`| 降级（FTS-only）/ 降级率 | ${stats.ftsOnly} / ${(stats.degradeRate * 100).toFixed(1)}% |`);
md.push(`| zero-FTS / 其中靠语义召回 | ${stats.zeroFts} / ${stats.zeroFtsRecalled} |`);
md.push(`| semantic-only 总数 / 每请求 / 最坏 | ${stats.semanticOnlyTotal} / ${stats.semanticOnlyPerRequest} / ${stats.semanticOnlyMax} |`);
md.push(`| 候选池可比向量均值 | ${stats.comparableVectorsAvg} |`);
md.push(`| **scope 内向量** 均值 / 最小 / 测量到 | ${stats.scopeVectorsAvg} / ${stats.scopeVectorsMin} / ${stats.scopeVectorsMeasured} |`);
md.push(`| scope 无向量的请求数 | ${stats.emptyScopeRequests} |`);
md.push(`| 延迟 p50 / p95 | ${stats.latencyMsP50}ms / ${stats.latencyMsP95}ms |`);
md.push('', '## 逐请求指标行', '');
md.push('| # | protocol | reject | ftsCount | semanticCount | semanticOnly | 池内可比 | scope 向量 | discovery | degraded | ms |');
md.push('| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | :--: | :--: | ---: |');
rows.forEach((r, i) => md.push(`| ${i + 1} | ${r.protocol ?? '—'} | ${r.reject_reason ?? '—'} | ${r.fts_count ?? '—'} | ${r.semantic_count ?? '—'} | ${r.semantic_only ?? '—'} | ${r.comparable_vectors ?? '—'} | ${r.scope_vectors ?? 'NULL'} | ${r.discovery ? '✅' : '—'} | ${r.degraded ? '⚠️' : '—'} | ${r.latency_ms ?? '—'} |`));
md.push('', '## 已知边界', '');
md.push('- 样本是脚本内置的 5 条 prompt 与 6 条虚构语料，不是真实用户流量；它证明的是"这个 agent 定义 + 这个 prompt 在当前模型下会不会传英文形式"，不是长期覆盖率分布。');
md.push('- agent JSON 去掉了 `resources`（本机 skill/steering 通配），其余与 `kiro-mem install` 写下的一致。');
md.push('- Worker 以子进程启动（隔离 `KIRO_MEMORY_DATA_DIR`），本脚本进程不导入 `worker.ts`，因此不会打开真实 `~/.kiro-mem` 库。');
md.push('- 本次会话自身被 hooks 采集进临时库并由真实 ACP 压缩器摘要，因此库里会多出探针自己的 Observation；它们晚于播种语料，可能出现在后续搜索结果里。');
md.push('- 多轮共用同一个临时 dataDir 与 Worker，只有 ACP 会话是每轮新建；因此后一轮可能搜到前一轮对话被压缩出的 Observation。');
md.push('- 临时 dataDir / KIRO_HOME / workspace 均在 tmpdir 下，退出即删（`--keep` 可保留）。');
writeFileSync(REPORT, md.join('\n') + '\n');

if (!existsSync(REPORT) || !existsSync(JSON_OUT)) die('报告未落盘');
console.log(`\n[gray] 报告：${REPORT}`);
console.log(`[gray] JSON：${JSON_OUT}`);

cleanup();
process.exit(0);
