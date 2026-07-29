#!/usr/bin/env bun
/**
 * kiro-mem V3 质量基准评估（技术设计 §12.3 / 发布清单 §5.1）
 *
 * 单元测试只能证明代码契约，证明不了摘要质量与检索精度。本脚本用人工标注的
 * 数据集驱动**生产合成链路**（createApp 的 summarize_turn / embed_observation
 * job + hybridSearchObservations），把质量变成可重复测量的数字。
 *
 * 用法：
 *   bun run benchmark/run.ts                     # gold 压缩器：检索/隔离/延迟基线 + 指标自检
 *   bun run benchmark/run.ts --compressor=acp    # 真实 ACP 压缩器：摘要质量 + 端到端检索
 *   bun run benchmark/run.ts --report=path.md    # 指定报告输出路径
 *   bun run benchmark/run.ts --no-embeddings     # 只测 FTS 路径
 *   bun run benchmark/run.ts --compressor=acp --runs=3   # 多次运行并记录方差
 *
 * 两种压缩器：
 *   gold — 直接返回人工标注，用于（a）在不依赖 kiro-cli 的环境下建立可重复的
 *          检索基线；（b）自检评估代码本身——gold 跑出来的摘要类指标必须接近
 *          满分，否则是打分器有 bug 而不是系统有 bug。
 *   acp  — 走真实 `kiro-cli acp` 子进程与生产 prompt，测量真实摘要质量。
 *
 * 隔离：全程使用临时数据目录与临时 SQLite，不触碰开发者真实 ~/.kiro-mem。
 * ACP 模式例外地读取真实 <dataDir>/kiro-runtime（压缩子 Agent 的安装位置）。
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { loadConfig, getDataDir, resolveRuntimeHome, type Config } from '../src/config';
import type { MemoryCompressor, ObservationSummaryResult } from '../src/compressor';
import { indexBody, factMatches, factLabel, type KeyFact } from './scoring';

// ---------------------------------------------------------------------------
// 数据集类型
// ---------------------------------------------------------------------------

interface DatasetEvent {
  tool: string;
  input: Record<string, unknown>;
  response: Record<string, unknown>;
}

interface Annotation {
  request: string;
  completed: boolean;
  memory_type: string;
  /** 关键文件：应出现在 Observation.files_touched 中 */
  key_files: string[];
  /**
   * 可核对事实标记：应保留在 Observation 正文中。按 token 边界匹配，语序与
   * 中间插入的词不影响判定；需要接受中英/同义表达时写成 `{ any: [...] }`，
   * 让"什么算同一个事实"留在可审阅的数据里，而不是藏在打分器的启发式里。
   */
  key_facts: KeyFact[];
  /** 未完成项：非空时 next_steps 必须非空 */
  unfinished: string[];
  /** 不允许出现的断言（虚构完成状态检测） */
  forbidden_claims?: string[];
  title: string;
  summary: string;
  outcome: string;
  learned: string;
  concepts: string[];
}

interface DatasetTurn {
  id: string;
  scope: 'primary' | 'other';
  session: string;
  prompt: string;
  assistant_response: string;
  events: DatasetEvent[];
  annotation: Annotation;
}

interface DatasetQuery {
  id: string;
  /**
   * relevance — 有应命中的标注 Observation，度量召回与排序。
   * leakage   — 只检验跨 scope 硬隔离；**可以**有本 scope 的合法命中。
   * empty     — 本 scope 内既无相关记忆也无合法词汇重叠，理想返回空。
   *
   * `empty` 必须显式声明，不能用 `expect.length === 0` 推断：leakage 类的
   * `expect` 也是空的，但它空的含义是"不该返回**别的 scope**的记录"，不是
   * "什么都不该返回"。q20 就是反例——它故意与本 scope 的 401/token 词汇重叠，
   * 按 `expect: []` 推断会把正确的关键词命中记成误召回，指标于是惩罚了正确
   * 行为（与 B6 打分器缺陷同一类错误）。
   */
  kind: 'relevance' | 'leakage' | 'empty';
  /**
   * 仅 relevance 有意义：这条 query 是否参与过检索实现的调优。
   *
   * `tuned`   — 最初的 18 条。D1（FTS 召回恒为 0）就是靠它们发现并修的，
   *             `benchmark/README.md` 自述那次修复让 gold hit@5 从 66.7% 升到
   *             94.4%，所以检索实现确实是在这批 query 上调过的。
   * `heldout` — 后补的 18 条，写完直接测、不据此改任何检索参数。它们才是泛化
   *             证据：两个子集的 hit@5 若明显分叉，就是 B4 说的过拟合从"风险"
   *             变成"事实"。
   *
   * 这个划分不完美——同一个人写的标注、同一份 turn 语料——但它比"完全没有
   * heldout"强，而且成本只是多标一个字段。
   */
  origin?: 'tuned' | 'heldout';
  scope: 'primary' | 'other';
  query: string;
  expect: string[];
  note?: string;
}

// ---------------------------------------------------------------------------
// CLI 参数
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
function flag(name: string, fallback?: string): string | undefined {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const compressorKind = flag('compressor', 'gold') as 'gold' | 'acp';
const enableEmbeddings = !args.includes('--no-embeddings');
const concurrencyOverride = flag('concurrency') ? Number(flag('concurrency')) : undefined;
const reportPath = resolve(
  flag('report', join(import.meta.dir, 'reports', `${compressorKind}-latest.md`))!,
);
/** 机器可读指标输出路径（`--runs=N` 的子进程用它回传数字）。 */
const jsonPath = flag('json') ? resolve(flag('json')!) : undefined;
const runs = Number(flag('runs', '1'));

if (compressorKind !== 'gold' && compressorKind !== 'acp') {
  console.error(`unknown --compressor=${compressorKind} (expected gold|acp)`);
  process.exit(2);
}
if (!Number.isInteger(runs) || runs < 1) {
  console.error(`--runs must be a positive integer (got ${flag('runs')})`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// --runs=N：多次运行 + 方差（B5）
// ---------------------------------------------------------------------------
//
// ACP 压缩器每轮输出会波动，所以单次运行的数字不足以支撑任何"质量已验证"的说法
// ——README 自己也承认 hit@5 在 94.4%~100% 之间浮动。这里用子进程重跑而不是在
// 进程内循环：每次运行都需要全新的临时 DB、全新的 job 队列和全新的 worker 单例，
// 子进程是唯一能保证互不污染的方式。
if (runs > 1) {
  const runDir = mkdtempSync(join(tmpdir(), 'kiro-mem-bench-runs-'));
  const collected: Record<string, number>[] = [];

  for (let i = 1; i <= runs; i++) {
    const childJson = join(runDir, `run-${i}.json`);
    const childArgs = args.filter((a) => !a.startsWith('--runs=') && !a.startsWith('--json='));
    console.log(`\n[benchmark] === run ${i}/${runs} ===`);
    const proc = Bun.spawnSync({
      cmd: [process.execPath, 'run', resolve(import.meta.path), ...childArgs, `--json=${childJson}`],
      cwd: join(import.meta.dir, '..'),
      stdout: 'inherit',
      stderr: 'inherit',
    });
    if (!existsSync(childJson)) {
      console.error(`[benchmark] run ${i} produced no metrics (exit ${proc.exitCode})`);
      process.exit(1);
    }
    const m = JSON.parse(readFileSync(childJson, 'utf-8'));
    collected.push({
      hitAt5: m.retrievalMetrics.hitAt5,
      hitAt10: m.retrievalMetrics.hitAt10,
      mrr: m.retrievalMetrics.mrr,
      recallAt10: m.retrievalMetrics.recallAt10,
      rPrecision: m.retrievalMetrics.rPrecision,
      expectedEmptyReturned: m.retrievalMetrics.expectedEmptyReturned,
      factRecall: m.summaryMetrics.factRecall,
      fileRecall: m.summaryMetrics.fileRecall,
      memoryTypeAccuracy: m.summaryMetrics.memoryTypeAccuracy,
      outcomePresentRate: m.summaryMetrics.outcomePresentRate,
      fallback: m.summaryMetrics.fallback,
      gatesOk: m.allGatesOk ? 1 : 0,
    });
  }

  const varianceLines: string[] = [
    `# kiro-mem V3 质量基准方差报告（${compressorKind}，${runs} 次运行）`,
    '',
    `- 生成时间：${new Date().toISOString()}`,
    `- 命令行：\`bun run benchmark/run.ts ${args.join(' ')}\``,
    '',
    '单次运行的数字不能代表一个会波动的压缩器。下表给出每个指标的均值、极值与',
    '样本标准差；`min` 才是可以对外承诺的下界。',
    '',
    '| 指标 | 均值 | min | max | 样本标准差 |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const key of Object.keys(collected[0]!)) {
    const xs = collected.map((c) => c[key]!);
    const avg = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = xs.length > 1
      ? Math.sqrt(xs.reduce((s, x) => s + (x - avg) ** 2, 0) / (xs.length - 1))
      : 0;
    varianceLines.push(
      `| ${key} | ${avg.toFixed(4)} | ${Math.min(...xs).toFixed(4)} | ${Math.max(...xs).toFixed(4)} | ${sd.toFixed(4)} |`,
    );
  }
  varianceLines.push('');

  const variancePath = resolve(
    flag('report', join(import.meta.dir, 'reports', `${compressorKind}-variance.md`))!,
  );
  mkdirSync(join(import.meta.dir, 'reports'), { recursive: true });
  writeFileSync(variancePath, varianceLines.join('\n'), 'utf-8');
  console.log(`\n${varianceLines.slice(8).join('\n')}`);
  console.log(`\n[benchmark] 方差报告已写入 ${variancePath}`);
  rmSync(runDir, { recursive: true, force: true });
  process.exit(collected.every((c) => c.gatesOk === 1) ? 0 : 1);
}

// ---------------------------------------------------------------------------
// 隔离：真实数据目录只用于定位 ACP runtime，其余一律走临时目录
// ---------------------------------------------------------------------------

const realDataDir = getDataDir();
const realConfig = loadConfig();

const workDir = mkdtempSync(join(tmpdir(), 'kiro-mem-bench-'));
const benchDataDir = join(workDir, 'data');
mkdirSync(benchDataDir, { recursive: true });
process.env.KIRO_MEMORY_DATA_DIR = benchDataDir;

// 动态导入：worker.ts 在模块层建生产 DB 单例，必须在 env 改写之后加载。
const { MemoryDB, computeScopeKey } = await import('../src/db');
const { createApp } = await import('../src/server/worker');
const { hybridSearchObservations } = await import('../src/server/observation-search');
const { buildBootstrapContext } = await import('../src/bootstrap-context');
const { extractArtifacts } = await import('../src/jobs/artifacts');

const turns: DatasetTurn[] = JSON.parse(
  readFileSync(join(import.meta.dir, 'dataset/turns.json'), 'utf-8'),
);
const queries: DatasetQuery[] = JSON.parse(
  readFileSync(join(import.meta.dir, 'dataset/queries.json'), 'utf-8'),
);

// 标注自相矛盾会静默产出错误指标——expected-empty 就是这么被算错过一次。
for (const q of queries) {
  const wantsHits = q.kind === 'relevance';
  if (wantsHits !== q.expect.length > 0) {
    console.error(
      `[benchmark] ${q.id}: kind=${q.kind} 与 expect(${q.expect.length} 条) 矛盾` +
        `（relevance 必须有应命中项，leakage/empty 必须没有）`,
    );
    process.exit(2);
  }
  // origin 决定这条 query 算不算泛化证据，缺省就等于把 heldout 混进 tuned。
  if (wantsHits && q.origin !== 'tuned' && q.origin !== 'heldout') {
    console.error(`[benchmark] ${q.id}: relevance query 必须声明 origin: "tuned" | "heldout"`);
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Provenance（B5）
// ---------------------------------------------------------------------------
//
// 一份只写了生成时间的报告无法自证是哪个版本、哪份数据集、哪条命令产出的。
// 尤其不能用文件 mtime 反推——mtime 不是 provenance。这里采集的是"复现这组数字
// 所需的全部输入"，其中 `dirty` 是关键：工作区脏的运行结果不可复现，报告必须
// 把这件事写在正面。
const { EMBEDDING_MODEL, DIMENSIONS } = await import('../src/embedding');

const provenance = (() => {
  const git = (a: string[]): string => {
    try {
      const p = Bun.spawnSync(['git', ...a], { cwd: join(import.meta.dir, '..') });
      return p.exitCode === 0 ? p.stdout.toString().trim() : 'unknown';
    } catch {
      return 'unknown';
    }
  };
  const hashFile = (p: string): string => {
    try {
      const h = new Bun.CryptoHasher('sha256');
      h.update(readFileSync(p));
      return h.digest('hex').slice(0, 12);
    } catch {
      return 'unknown';
    }
  };
  return {
    commit: git(['rev-parse', '--short', 'HEAD']),
    dirty: git(['status', '--porcelain']) !== '',
    turnsHash: hashFile(join(import.meta.dir, 'dataset/turns.json')),
    queriesHash: hashFile(join(import.meta.dir, 'dataset/queries.json')),
    runHash: hashFile(join(import.meta.dir, 'run.ts')),
    scoringHash: hashFile(join(import.meta.dir, 'scoring.ts')),
    bunVersion: Bun.version,
    platform: process.platform,
    arch: process.arch,
  };
})();

// 两个 scope 用真实存在的非 git 临时目录，保证 seeding 与 buildBootstrapContext
// 计算出的 scope_key 一致（后者会对 cwd 做真实 repo 探测）。
const scopeCwd: Record<'primary' | 'other', string> = {
  primary: join(workDir, 'scope-primary'),
  other: join(workDir, 'scope-other'),
};
mkdirSync(scopeCwd.primary, { recursive: true });
mkdirSync(scopeCwd.other, { recursive: true });
const scopeKeyOf = (s: 'primary' | 'other') => computeScopeKey(null, scopeCwd[s]);

// ---------------------------------------------------------------------------
// gold 压缩器：按 user_prompt 反查标注
// ---------------------------------------------------------------------------

class GoldCompressor implements MemoryCompressor {
  private byPrompt = new Map<string, DatasetTurn>();
  constructor(dataset: DatasetTurn[]) {
    for (const t of dataset) this.byPrompt.set(t.prompt.trim(), t);
  }
  async summarizeObservation(input: {
    user_prompt: string;
    assistant_response: string;
    artifacts: {
      files_touched: string[];
      commands: string[];
      test_signals: string[];
      error_signals: string[];
      facts: string[];
    };
  }): Promise<ObservationSummaryResult> {
    const turn = this.byPrompt.get(input.user_prompt.trim());
    if (!turn) throw new Error('gold compressor: prompt not found in dataset');
    const a = turn.annotation;
    return {
      title: a.title,
      summary: a.summary,
      request: a.request,
      outcome: a.outcome,
      learned: a.learned,
      next_steps: a.unfinished.join('；'),
      memory_type: a.memory_type,
      files_touched: a.key_files,
      concepts: a.concepts,
      // key_facts 可能带变体声明；gold 取第一个写法作为 evidence 文本。
      evidence: a.key_facts.map((f) => (typeof f === 'string' ? f : f.any[0] ?? '')),
      importance_score: 0.6,
      confidence_score: a.completed ? 0.9 : 0.5,
      unresolved_score: a.unfinished.length ? 0.7 : 0,
    };
  }
}

async function buildCompressor(): Promise<MemoryCompressor> {
  if (compressorKind === 'gold') return new GoldCompressor(turns);

  const { ACPCompressor, checkRuntimeHome, formatIssues } = await import('../src/acp');
  const kiroHome = realConfig.runtime.kiroHome || join(realDataDir, 'kiro-runtime');
  const agentName = 'kiro-mem-compressor';
  const issues = checkRuntimeHome(kiroHome, agentName);
  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length) {
    console.error('[benchmark] kiro-runtime 不完整，无法用真实 ACP 评估：');
    console.error(formatIssues(issues));
    console.error('[benchmark] 先运行 `kiro-mem install`，或改用 --compressor=gold。');
    process.exit(1);
  }
  const acpConcurrency = concurrencyOverride ?? realConfig.compression.concurrency;
  console.log(`[benchmark] ACP 压缩器：kiroHome=${kiroHome} concurrency=${acpConcurrency}`);
  return new ACPCompressor({
    agentName,
    kiroHome,
    concurrency: acpConcurrency,
    timeoutMs: realConfig.compression.timeoutMs,
    maxRetries: realConfig.compression.maxRetries,
  });
}

// ---------------------------------------------------------------------------
// 播种：把标注 turn 写成真实 Truth Layer 行，再入队生产 job
// ---------------------------------------------------------------------------

const db = new MemoryDB(join(workDir, 'bench.sqlite'));
const config: Config = {
  ...realConfig,
  language: 'zh',
  compression: {
    ...realConfig.compression,
    concurrency: concurrencyOverride ?? realConfig.compression.concurrency,
  },
};
const compressor = await buildCompressor();
const { jobRunner } = createApp({
  db,
  compressor,
  config,
  enableEmbeddings,
  enableAuth: false,
  jobPollMs: 50,
});

/** turn 数据集 id -> 数据库 turn id */
const turnIdOf = new Map<string, number>();

for (const t of turns) {
  const cwd = scopeCwd[t.scope];
  db.upsertSessionRef({ session_id: t.session, cwd, repo: null });
  const seq = db.allocateNextTurnSeq(t.session);
  const turn = db.createTurn({
    session_id: t.session,
    seq,
    cwd,
    repo: null,
    prompt_text: t.prompt,
  });
  for (const ev of t.events) {
    db.appendTurnEvent({
      turn_id: turn.id,
      session_id: t.session,
      hook_event_name: 'postToolUse',
      tool_name: ev.tool,
      payload_json: JSON.stringify({ tool_input: ev.input, tool_response: ev.response }),
    });
  }
  db.appendTurnEvent({
    turn_id: turn.id,
    session_id: t.session,
    hook_event_name: 'stop',
    payload_json: JSON.stringify({ assistant_response: t.assistant_response }),
  });
  db.markTurnClosed(turn.id);
  turnIdOf.set(t.id, turn.id);
  db.enqueueJob({
    job_type: 'summarize_turn',
    dedupe_key: `sum:turn:${turn.id}`,
    entity_type: 'turn',
    entity_id: String(turn.id),
    payload_json: JSON.stringify({ turn_id: turn.id }),
  });
}

console.log(`[benchmark] 播种 ${turns.length} 个 closed turn，开始跑 summarize_turn…`);

const startedAt = Date.now();
jobRunner.start();

const summarizeTimeoutMs = compressorKind === 'acp' ? 15 * 60_000 : 60_000;
await waitFor(
  () => turns.every((t) => db.getObservationByTurnId(turnIdOf.get(t.id)!) != null),
  summarizeTimeoutMs,
  'summarize_turn 未在预算内全部完成',
);
const summarizeMs = Date.now() - startedAt;

if (enableEmbeddings) {
  await waitFor(
    () => db.getObservabilityStats().embeddings.ready >= turns.length,
    10 * 60_000,
    'embed_observation 未在预算内全部完成',
  );
}
jobRunner.stop();
const compressorStats = compressor.stats ? { ...compressor.stats } : null;
await compressor.close?.();

const stats = db.getObservabilityStats();
console.log(
  `[benchmark] 合成完成：observations=${stats.observations.total} normal=${stats.observations.normal} ` +
    `fallback=${stats.observations.fallback} embedding coverage=${stats.embeddings.coverage.toFixed(2)} ` +
    `耗时=${(summarizeMs / 1000).toFixed(1)}s`,
);

async function waitFor(pred: () => boolean, timeoutMs: number, message: string): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`${message}（等待 ${timeoutMs}ms）`);
    await Bun.sleep(200);
  }
}

// ---------------------------------------------------------------------------
// 摘要质量评估
// ---------------------------------------------------------------------------

interface SummaryRow {
  id: string;
  quality: string;
  hasUnfinished: boolean;
  memoryTypeOk: boolean;
  outcomePresent: boolean;
  nextStepsMissing: boolean;
  nextStepsExtra: boolean;
  factRecall: number;
  missingFacts: string[];
  fileRecall: number;
  missingFiles: string[];
  hallucinatedFiles: string[];
  forbiddenHits: string[];
}

const summaryRows: SummaryRow[] = [];

for (const t of turns) {
  const dbTurnId = turnIdOf.get(t.id)!;
  const obs = db.getObservationByTurnId(dbTurnId)!;
  const a = t.annotation;
  const parse = (json: string): string[] => {
    try {
      const p = JSON.parse(json);
      return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  };
  const obsFiles = parse(obs.files_touched_json);
  const body = [
    obs.title,
    obs.summary,
    obs.request ?? '',
    obs.outcome ?? '',
    obs.learned ?? '',
    obs.next_steps ?? '',
    parse(obs.evidence_json).join(' '),
    parse(obs.concepts_json).join(' '),
    obsFiles.join(' '),
  ].join('\n');

  // 事实标记召回：标注的可核对事实是否保留。用 token 边界匹配 + 数据集里显式
  // 声明的表达变体，而不是原来的整串 substring —— 后者既会因为语序/语言差异
  // 惩罚正确输出，也会让 `en`、`0.2` 这类短事实在 `content`、`10.25` 里意外命中。
  // 判定逻辑与其单测都在 benchmark/scoring.ts。
  const bodyIndex = indexBody(body);
  const missingFacts = a.key_facts
    .filter((f) => !factMatches(bodyIndex, f))
    .map(factLabel);
  const factRecall = a.key_facts.length
    ? (a.key_facts.length - missingFacts.length) / a.key_facts.length
    : 1;

  // 关键文件召回 + 幻觉文件（本轮任何证据里都没出现过的路径）
  const truthFiles = new Set(extractArtifacts(db, dbTurnId).files_touched);
  // 证据文本 = 全部 turn_events 原始 payload。命令输出/错误信息里提到的文件是
  // 真实证据，只是没被 tool_input.path 收进 files_touched，不能算幻觉。
  const evidenceText = db
    .listTurnEvents(dbTurnId)
    .map((e) => e.payload_json)
    .join('\n');
  const missingFiles = a.key_files.filter(
    (f) => !obsFiles.some((o) => o === f || o.endsWith(f) || f.endsWith(o)),
  );
  const fileRecall = a.key_files.length
    ? (a.key_files.length - missingFiles.length) / a.key_files.length
    : 1;
  const hallucinatedFiles = obsFiles.filter(
    (o) =>
      !truthFiles.has(o) &&
      ![...truthFiles].some((tf) => tf.endsWith(o) || o.endsWith(tf)) &&
      !evidenceText.includes(o),
  );

  // 完整性：outcome 必须有；有未完成项时 next_steps 必须非空（§12.3 的「缺失
  // 率」指的就是这个方向）。反向的「标注无未完成项但模型仍写了 next_steps」是
  // 过度生成，危害小得多，单独统计不设门槛。
  const outcomePresent = !!(obs.outcome && obs.outcome.trim());
  const hasNext = !!(obs.next_steps && obs.next_steps.trim());
  const nextStepsMissing = a.unfinished.length > 0 && !hasNext;
  const nextStepsExtra = a.unfinished.length === 0 && hasNext;

  // 虚构完成状态：标注禁止出现的断言不得出现在正文
  const forbiddenHits = (a.forbidden_claims ?? []).filter((c) => body.includes(c));

  summaryRows.push({
    id: t.id,
    quality: obs.quality,
    hasUnfinished: a.unfinished.length > 0,
    memoryTypeOk: obs.memory_type === a.memory_type,
    outcomePresent,
    nextStepsMissing,
    nextStepsExtra,
    factRecall,
    missingFacts,
    fileRecall,
    missingFiles,
    hallucinatedFiles,
    forbiddenHits,
  });
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const rate = (n: number, d: number) => (d ? n / d : 0);

const withUnfinished = summaryRows.filter((r) => r.hasUnfinished);
const withoutUnfinished = summaryRows.filter((r) => !r.hasUnfinished);

const summaryMetrics = {
  total: summaryRows.length,
  fallback: summaryRows.filter((r) => r.quality === 'fallback').length,
  outcomePresentRate: rate(summaryRows.filter((r) => r.outcomePresent).length, summaryRows.length),
  /** §12.3 的 next step 缺失率（取补），只在标注确有未完成项的 turn 上统计。 */
  nextStepsRecall: rate(
    withUnfinished.filter((r) => !r.nextStepsMissing).length,
    withUnfinished.length,
  ),
  nextStepsRecallBase: withUnfinished.length,
  /** 反向的过度生成，仅作参考。 */
  nextStepsExtraRate: rate(
    withoutUnfinished.filter((r) => r.nextStepsExtra).length,
    withoutUnfinished.length,
  ),
  nextStepsExtraBase: withoutUnfinished.length,
  factRecall: mean(summaryRows.map((r) => r.factRecall)),
  fileRecall: mean(summaryRows.map((r) => r.fileRecall)),
  memoryTypeAccuracy: rate(summaryRows.filter((r) => r.memoryTypeOk).length, summaryRows.length),
  hallucinatedFileTurns: summaryRows.filter((r) => r.hallucinatedFiles.length > 0).length,
  forbiddenClaimTurns: summaryRows.filter((r) => r.forbiddenHits.length > 0).length,
};

// ---------------------------------------------------------------------------
// 检索评估
// ---------------------------------------------------------------------------

const obsIdOf = new Map<string, number>();
for (const t of turns) obsIdOf.set(t.id, db.getObservationByTurnId(turnIdOf.get(t.id)!)!.id);
const datasetIdOfObs = new Map<number, string>();
for (const [dsId, obsId] of obsIdOf) datasetIdOfObs.set(obsId, dsId);
const otherScopeObsIds = new Set(
  turns.filter((t) => t.scope === 'other').map((t) => obsIdOf.get(t.id)!),
);

interface QueryRow {
  id: string;
  kind: string;
  origin?: 'tuned' | 'heldout';
  query: string;
  expect: string[];
  ranks: number[];
  hitAt5: boolean;
  hitAt10: boolean;
  reciprocalRank: number;
  recallAt10: number;
  rPrecision: number;
  leaked: string[];
  matchSources: string[];
  latencyMs: number;
  returned: number;
}

const queryRows: QueryRow[] = [];
let degradeCount = 0;

for (const q of queries) {
  const t0 = performance.now();
  const results = await hybridSearchObservations(
    db,
    q.query,
    { scopeKey: scopeKeyOf(q.scope), limit: 10 },
    { onDegrade: () => degradeCount++ },
  );
  const latencyMs = performance.now() - t0;

  const ranks = q.expect
    .map((e) => results.findIndex((r) => r.id === obsIdOf.get(e)) + 1)
    .filter((r) => r > 0);
  const best = ranks.length ? Math.min(...ranks) : 0;
  const leaked = results
    .filter((r) => otherScopeObsIds.has(r.id))
    .map((r) => datasetIdOfObs.get(r.id)!);

  // R-precision：在 R = |expect| 这个截断点上的精度。
  //
  // 不用 precision@5：标注集里 expect 通常只有 1 条，那么 precision@5 的**上限**
  // 就是 20%，测出来的 21% 只是 hit@5 的另一种写法，不是精度。R-precision 的
  // 截断点跟着标注规模走，1.0 表示"前 R 条正好就是标注的 R 条"，可解释也可比较。
  const expectedIds = new Set(q.expect.map((e) => obsIdOf.get(e)));
  const r = q.expect.length;
  const rPrecision = r
    ? results.slice(0, r).filter((x) => expectedIds.has(x.id)).length / r
    : 1;

  queryRows.push({
    id: q.id,
    kind: q.kind,
    origin: q.origin,
    query: q.query,
    expect: q.expect,
    ranks,
    hitAt5: best > 0 && best <= 5,
    hitAt10: best > 0 && best <= 10,
    reciprocalRank: best > 0 ? 1 / best : 0,
    recallAt10: q.expect.length ? ranks.length / q.expect.length : 1,
    rPrecision,
    leaked,
    matchSources: [...new Set(results.map((r) => r.match_source))],
    latencyMs,
    returned: results.length,
  });
}

const relevanceRows = queryRows.filter((r) => r.kind === 'relevance');
const tunedRows = relevanceRows.filter((r) => r.origin === 'tuned');
const heldoutRows = relevanceRows.filter((r) => r.origin === 'heldout');
/**
 * expected-empty query：本 scope 内既无相关记忆，也无合法词汇重叠，理想返回空。
 *
 * 之前完全没有针对它的指标，所以一条本该返回空的 query 返回满 10 条也不会被
 * 扣分——等于把该 workspace 近半记忆推给 Agent 而评估体系毫无反应。误召回是
 * 检索质量的另一半，只测 hit@k 只能证明"没漏"，证明不了"没乱给"。
 *
 * 取样口径按**显式 kind**，不再用 `expect.length === 0` 推断。第一版用推断，
 * 于是把 leakage 类的 q20 也算了进去——那条 query 故意与本 scope 的 401/token
 * 词汇重叠（401 在 t11/t19，token 在 5 条 primary turn），返回本 scope 命中是
 * 正确行为，却被记成误召回。指标因此系统性偏高，并且会把"压制正确结果"变成
 * 优化方向。
 */
const expectedEmptyRows = queryRows.filter((r) => r.kind === 'empty');
const latencies = queryRows.map((r) => r.latencyMs).sort((a, b) => a - b);
const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor((latencies.length * p) / 100))] ?? 0;

const retrievalMetrics = {
  queries: queryRows.length,
  relevanceQueries: relevanceRows.length,
  hitAt5: rate(relevanceRows.filter((r) => r.hitAt5).length, relevanceRows.length),
  hitAt10: rate(relevanceRows.filter((r) => r.hitAt10).length, relevanceRows.length),
  mrr: mean(relevanceRows.map((r) => r.reciprocalRank)),
  recallAt10: mean(relevanceRows.map((r) => r.recallAt10)),
  /**
   * R-precision：截断点取 R = |expect|。标注集不完备，所以这仍是**下界**（未标注
   * 的结果一律算不相关），但它至少可解释：1.0 表示前 R 条正好命中标注的 R 条。
   */
  rPrecision: mean(relevanceRows.map((r) => r.rPrecision)),
  /**
   * 分层：tuned 是检索实现调优过的 18 条，heldout 是后补且未据此调参的 18 条。
   * 两者的 hit@5 差距就是泛化损失的直接读数（B4）。
   */
  tunedQueries: tunedRows.length,
  tunedHitAt5: rate(tunedRows.filter((r) => r.hitAt5).length, tunedRows.length),
  tunedRPrecision: mean(tunedRows.map((r) => r.rPrecision)),
  heldoutQueries: heldoutRows.length,
  heldoutHitAt5: rate(heldoutRows.filter((r) => r.hitAt5).length, heldoutRows.length),
  heldoutRPrecision: mean(heldoutRows.map((r) => r.rPrecision)),
  /** heldout 里因为一个字面词都没命中而直接返回空的条数（词汇锚点规则的代价）。 */
  heldoutNoAnchor: heldoutRows.filter((r) => r.returned === 0).length,
  expectedEmptyQueries: expectedEmptyRows.length,
  /** expected-empty query 平均返回条数；理想为 0。 */
  expectedEmptyReturned: mean(expectedEmptyRows.map((r) => r.returned)),
  /** 返回最多的那条 expected-empty query，用于看最坏情况。 */
  expectedEmptyWorst: expectedEmptyRows.reduce((max, r) => Math.max(max, r.returned), 0),
  leakTotal: queryRows.reduce((s, r) => s + r.leaked.length, 0),
  degrades: degradeCount,
  latencyP50: pct(50),
  latencyP95: pct(95),
};

// bootstrap 注入：字节数与构建延迟
function measureBootstrap(scope: 'primary' | 'other') {
  const t0 = performance.now();
  const text = buildBootstrapContext(db, scopeCwd[scope], config.context, config.language);
  return { ms: performance.now() - t0, bytes: Buffer.byteLength(text, 'utf8'), text };
}
const bootstrapPrimary = measureBootstrap('primary');
const bootstrapOther = measureBootstrap('other');
const emptyScopeDir = join(workDir, 'scope-empty');
mkdirSync(emptyScopeDir, { recursive: true });
const bootstrapEmpty = (() => {
  const t0 = performance.now();
  const text = buildBootstrapContext(db, emptyScopeDir, config.context, config.language);
  return { ms: performance.now() - t0, bytes: Buffer.byteLength(text, 'utf8'), text };
})();
/** primary scope 的 bootstrap 里出现了多少条 other scope 的 Observation 编号 */
const bootstrapLeaks = [...otherScopeObsIds].filter((id) =>
  bootstrapPrimary.text.includes(`#O${id}`),
).length;

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

const pctStr = (x: number) => `${(x * 100).toFixed(1)}%`;
const fmt = (x: number, d = 3) => x.toFixed(d);

// --- 新增门槛的阈值 ---
//
// 这两条补上"误召回"这一侧的举证——原来整套评估只有 hit@k，只能证明"没漏"，
// 证明不了"没乱给"。
//
//   - R-precision 的阈值仍是**不回退锁**：实测 61%，而 hit@5 是 94%。差距说明
//     正确答案通常进了 Top-5 但常常不在第 1 位，排序还有明显空间。
//   - expected-empty 已经不是锁而是**目标值 0**，S4 收口后结构上就是 0（见下）。
const R_PRECISION_FLOOR = 0.55;
/**
 * heldout 子集的下界。取实测值（hit@5 44.4% / R-precision 38.9%）向下留一档。
 *
 * 写清楚它是什么：**不回退锁，而且锁在一个很差的水平上**。tuned 与 heldout 的
 * hit@5 差了 50 个百分点，这把 B4 的"存在过拟合风险"变成了实测事实——检索对
 * 调优过的问法有效，对同一批工作的另一种问法只有一半有效。修它需要改检索能力
 * （中文分词 / 同义扩展 / 更强的语义通道），不是调这两个数字。
 */
const HELDOUT_HIT5_FLOOR = 0.4;
const HELDOUT_R_PRECISION_FLOOR = 0.35;
/**
 * expected-empty 的目标值是 0，现在它**就是**门槛，不再是"不回退锁"。
 *
 * 检索层要求词汇锚点：本 scope 的 FTS 无命中即返回空（`observation-search.ts`），
 * 所以一条无关 query 的返回条数在结构上就是 0。留 1.0 的余量只为一种情况：acp
 * 模式下 Observation 正文由模型生成，某条 empty query 可能因此获得一个**真实**的
 * 词汇锚点，那时返回结果是正确行为而非误召回。零锚点必返回空这条硬不变量由单测
 * 钉住（`tests/db/retrieval.test.ts`），不依赖这条门槛。
 */
const EXPECTED_EMPTY_MAX_RETURNED = 1.0;
const EXPECTED_EMPTY_TARGET = 0;

/** 报告会入库，不要把开发者的 home 绝对路径写进去。 */
const tildify = (p: string) => {
  const home = process.env.HOME;
  return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
};

const gate = (ok: boolean) => (ok ? '✅' : '❌');

/**
 * 门槛分类。不同类别的举证能力差别很大，混在一张"全部通过"表里对外阅读即构成
 * 夸大，所以报告按类别分表呈现：
 *
 *   discriminating — 有判别力：会因为实现变差而变红。
 *   selfcheck      — 自检：gold 压缩器把标注逐字搬进结果，而打分器读的是同一份
 *                    标注，所以这些项在 gold 下测的是"评分管道通不通"，不是摘要
 *                    质量。只有 acp 模式下它们才有判别力。
 *   structural     — 结构性恒真：三条检索 SQL 都无条件拼 `AND scope_key = ?`，
 *                    所以"泄漏为 0"实际测的是"这行 WHERE 没被删掉"。保留它作为
 *                    结构回归，但它不是隔离质量的证据。
 *   performance    — 性能余量：当前余量在数量级上，短期内不会变红。
 */
type GateKind = 'discriminating' | 'selfcheck' | 'structural' | 'performance';
interface Gate { name: string; value: string; ok: boolean; kind: GateKind }

/** gold 模式下由标注直接搬运、因而只能自检的摘要类门槛。 */
const summaryGateKind: GateKind = compressorKind === 'gold' ? 'selfcheck' : 'discriminating';

const gates: Gate[] = [
  // tuned 子集：与历史基线口径完全一致的**连续性锁**。它测的是"检索没有比调优
  // 那天更差"，**不能**被引用为泛化证据——检索实现就是在这 18 条上调的。
  { kind: 'discriminating', name: `Top-5 至少一条标注命中（tuned ${retrievalMetrics.tunedQueries} 条；连续性锁）`, value: pctStr(retrievalMetrics.tunedHitAt5), ok: retrievalMetrics.tunedHitAt5 >= 0.9 },
  { kind: 'discriminating', name: `R-precision（tuned；≥${pctStr(R_PRECISION_FLOOR)} 为不回退锁，非质量目标）`, value: pctStr(retrievalMetrics.tunedRPrecision), ok: retrievalMetrics.tunedRPrecision >= R_PRECISION_FLOOR },
  // heldout 子集：写完直接测、未据此调参，这才是泛化读数。阈值取实测值向下留一
  // 档，同样是不回退锁——**44% 不是可接受的质量水平**，它是当前最实质的检索缺口。
  { kind: 'discriminating', name: `Top-5 至少一条标注命中（heldout ${retrievalMetrics.heldoutQueries} 条；泛化读数，≥${pctStr(HELDOUT_HIT5_FLOOR)} 为不回退锁）`, value: pctStr(retrievalMetrics.heldoutHitAt5), ok: retrievalMetrics.heldoutHitAt5 >= HELDOUT_HIT5_FLOOR },
  { kind: 'discriminating', name: `R-precision（heldout；≥${pctStr(HELDOUT_R_PRECISION_FLOOR)} 为不回退锁）`, value: pctStr(retrievalMetrics.heldoutRPrecision), ok: retrievalMetrics.heldoutRPrecision >= HELDOUT_R_PRECISION_FLOOR },
  { kind: 'discriminating', name: `expected-empty query 平均返回条数（${retrievalMetrics.expectedEmptyQueries} 条，最坏 ${retrievalMetrics.expectedEmptyWorst}；目标 ${EXPECTED_EMPTY_TARGET}，门槛 ≤${EXPECTED_EMPTY_MAX_RETURNED}）`, value: fmt(retrievalMetrics.expectedEmptyReturned, 2), ok: retrievalMetrics.expectedEmptyReturned <= EXPECTED_EMPTY_MAX_RETURNED },
  { kind: 'structural', name: '跨 workspace 检索泄漏为 0', value: String(retrievalMetrics.leakTotal), ok: retrievalMetrics.leakTotal === 0 },
  { kind: 'structural', name: '跨 workspace bootstrap 注入为 0', value: String(bootstrapLeaks), ok: bootstrapLeaks === 0 },
  { kind: summaryGateKind, name: 'outcome 非空率', value: pctStr(summaryMetrics.outcomePresentRate), ok: summaryMetrics.outcomePresentRate >= 0.9 },
  { kind: summaryGateKind, name: `next_steps 未完成项召回（${summaryMetrics.nextStepsRecallBase} 条有未完成项）`, value: pctStr(summaryMetrics.nextStepsRecall), ok: summaryMetrics.nextStepsRecall >= 0.85 },
  { kind: summaryGateKind, name: '关键事实召回（token 边界匹配）', value: pctStr(summaryMetrics.factRecall), ok: summaryMetrics.factRecall >= 0.8 },
  { kind: summaryGateKind, name: '关键文件召回', value: pctStr(summaryMetrics.fileRecall), ok: summaryMetrics.fileRecall >= 0.8 },
  { kind: summaryGateKind, name: '虚构完成状态 turn 数', value: String(summaryMetrics.forbiddenClaimTurns), ok: summaryMetrics.forbiddenClaimTurns === 0 },
  { kind: summaryGateKind, name: '幻觉文件 turn 数', value: String(summaryMetrics.hallucinatedFileTurns), ok: summaryMetrics.hallucinatedFileTurns === 0 },
  { kind: 'performance', name: 'search p95 延迟 < 300ms', value: `${fmt(retrievalMetrics.latencyP95, 1)}ms`, ok: retrievalMetrics.latencyP95 < 300 },
  { kind: 'performance', name: 'bootstrap 构建 < 100ms 且在预算内', value: `${fmt(bootstrapPrimary.ms, 1)}ms / ${bootstrapPrimary.bytes}B`, ok: bootstrapPrimary.ms < 100 && bootstrapPrimary.bytes <= config.context.maxOutputBytes },
];
const allGatesOk = gates.every((g) => g.ok);
const gatesOfKind = (kind: GateKind) => gates.filter((g) => g.kind === kind);

const KIND_LABEL: Record<GateKind, string> = {
  discriminating: '有判别力的门槛',
  selfcheck: '自检门槛（gold 模式下不构成质量证据）',
  structural: '结构性门槛（恒真，仅防回归）',
  performance: '性能门槛（余量充足）',
};

const lines: string[] = [];
lines.push(`# kiro-mem V3 质量基准报告（${compressorKind} 压缩器）`);
lines.push('');
lines.push('## Provenance');
lines.push('');
lines.push('报告只记生成时间时无法自证是哪个版本、哪份数据集、哪条命令产出的——');
lines.push('文件 mtime 不是 provenance。下面这些是复现这份数字所需的全部输入。');
lines.push('');
lines.push('| 项 | 值 |');
lines.push('| --- | --- |');
lines.push(`| 生成时间 | ${new Date().toISOString()} |`);
lines.push(`| commit | \`${provenance.commit}\`${provenance.dirty ? ' **（工作区有未提交改动）**' : ''} |`);
lines.push(`| 命令行 | \`bun run benchmark/run.ts ${args.join(' ')}\` |`);
lines.push(`| 数据集 turns.json | \`${provenance.turnsHash}\`（${turns.length} turn） |`);
lines.push(`| 数据集 queries.json | \`${provenance.queriesHash}\`（${queries.length} query） |`);
lines.push(`| 脚本 run.ts / scoring.ts | \`${provenance.runHash}\` / \`${provenance.scoringHash}\` |`);
lines.push(`| embedding 模型 | ${enableEmbeddings ? `${EMBEDDING_MODEL} (${DIMENSIONS}d)` : '关闭'} |`);
lines.push(`| 运行环境 | Bun ${provenance.bunVersion} / ${provenance.platform} ${provenance.arch} |`);
lines.push(`| 运行次数 | 1（多次运行与方差见 \`--runs=N\`） |`);
lines.push('');
lines.push('## 运行配置');
lines.push('');
lines.push(`- 压缩器：\`${compressorKind}\`${compressorKind === 'acp' ? `（kiro-runtime=${tildify(resolveRuntimeHome(realConfig.runtime.kiroHome, realDataDir))}，timeoutMs=${realConfig.compression.timeoutMs}，maxRetries=${realConfig.compression.maxRetries}）` : '（直接返回人工标注，用于检索基线与打分器自检）'}`);
lines.push(`- Embedding：${enableEmbeddings ? `启用，coverage ${fmt(stats.embeddings.coverage, 2)}` : '关闭（仅 FTS 路径）'}`);
lines.push(`- 数据集：${turns.length} 个标注 turn（primary ${turns.filter((t) => t.scope === 'primary').length} / other ${turns.filter((t) => t.scope === 'other').length}），${queries.length} 个标注 query（relevance ${relevanceRows.length} / empty ${expectedEmptyRows.length} / leakage ${queryRows.length - relevanceRows.length - expectedEmptyRows.length}）`);
lines.push(`- 合成结果：normal ${stats.observations.normal} / fallback ${stats.observations.fallback}，summarize 总耗时 ${(summarizeMs / 1000).toFixed(1)}s`);
if (compressorStats) {
  lines.push(
    `- 压缩器计数（§12.4）：JSON repair ${compressorStats.repairs}，repair 耗尽降级 ${compressorStats.parseFallbacks}，` +
      `runtime 回收 ${compressorStats.restarts}，工具调用污染 ${compressorStats.contaminations}。` +
      `job 层的超时/失败由 JobRunner 重试吸收，最终仍为 ${stats.observations.normal} 条 normal。`,
  );
}
lines.push('');
lines.push(`## 门槛结论：${allGatesOk ? '全部通过' : '存在未达标项'}`);
lines.push('');
lines.push('门槛按**举证能力**分表。把自检项与结构性恒真项和真实质量指标混在同一张');
lines.push('"全部通过"表里，对外阅读即构成夸大——所以它们在下面是分开的。');
lines.push('');
for (const kind of ['discriminating', 'selfcheck', 'structural', 'performance'] as GateKind[]) {
  const group = gatesOfKind(kind);
  if (!group.length) continue;
  lines.push(`### ${KIND_LABEL[kind]}`);
  lines.push('');
  if (kind === 'discriminating') {
    lines.push('relevance query 分成两个子集，举证能力完全不同：');
    lines.push('');
    lines.push('- **tuned**（18 条）：检索实现就是在这批 query 上调的（D1 修复让 gold hit@5 从');
    lines.push('  66.7% 升到 94.4%）。它的门槛是**连续性锁**，不能当泛化证据。');
    lines.push(`- **heldout**（18 条）：后补且未据此改任何检索参数。实测 hit@5 ${pctStr(retrievalMetrics.heldoutHitAt5)}，`);
    lines.push('  与 tuned 差了约 50 个百分点——**这是当前最实质的检索缺口**，也把"存在过拟合');
    lines.push('  风险"变成了实测事实。它的门槛同样是不回退锁，锁在一个很差的水平上。');
    lines.push('');
    lines.push('R-precision 与 expected-empty 是**误召回**侧指标——只测 hit@k 只能证明');
    lines.push('"没漏"，证明不了"没乱给"。两者的性质不同：');
    lines.push('');
    lines.push('- R-precision 的阈值是"不回退锁"，不是质量目标：实测远低于 hit@5，说明正确答案');
    lines.push('  通常进了 Top-5 但常常不在第 1 位，排序还有明显空间。');
    lines.push(`- expected-empty 的阈值就是目标值（${EXPECTED_EMPTY_TARGET}）。检索层要求词汇锚点——本 scope 的 FTS`);
    lines.push('  无命中即返回空——所以一条与本 workspace 无关的 query 在结构上返回 0 条。');
    lines.push('');
  }
  if (kind === 'selfcheck') {
    lines.push('gold 压缩器把人工标注逐字搬进结果，而打分器读的是同一份标注，因此这些项');
    lines.push('在 gold 下证明的是"评分管道与播种→job→入库→检索链路是通的"，而不是摘要');
    lines.push('质量。要拿它们当质量证据，必须用 `--compressor=acp` 跑。');
    lines.push('');
  }
  if (kind === 'structural') {
    lines.push('三条检索 SQL 都无条件拼 `AND scope_key = ?`，所以这两项测的是"那行 WHERE 没');
    lines.push('被删掉"，恒为 0。真正会出错的授权层是 `src/server/mcp-scope.ts`，本基准不调用它。');
    lines.push('');
  }
  lines.push('| 门槛 | 实测 | 结果 |');
  lines.push('| --- | --- | --- |');
  for (const g of group) lines.push(`| ${g.name} | ${g.value} | ${gate(g.ok)} |`);
  lines.push('');
}
lines.push('## 摘要质量（§12.3 Summary 完整性 / 事实准确性）');
lines.push('');
lines.push('| 指标 | 值 |');
lines.push('| --- | --- |');
lines.push(`| Observation 总数 | ${summaryMetrics.total} |`);
lines.push(`| fallback 数 | ${summaryMetrics.fallback} |`);
lines.push(`| outcome 非空率 | ${pctStr(summaryMetrics.outcomePresentRate)} |`);
lines.push(`| next_steps 未完成项召回（分母 ${summaryMetrics.nextStepsRecallBase}） | ${pctStr(summaryMetrics.nextStepsRecall)} |`);
lines.push(`| next_steps 过度生成率（分母 ${summaryMetrics.nextStepsExtraBase}，仅参考） | ${pctStr(summaryMetrics.nextStepsExtraRate)} |`);
lines.push(`| 关键事实逐字召回 | ${pctStr(summaryMetrics.factRecall)} |`);
lines.push(`| 关键文件召回 | ${pctStr(summaryMetrics.fileRecall)} |`);
lines.push(`| memory_type 与标注一致率 | ${pctStr(summaryMetrics.memoryTypeAccuracy)} |`);
lines.push(`| 出现幻觉文件的 turn 数 | ${summaryMetrics.hallucinatedFileTurns} |`);
lines.push(`| 出现虚构完成断言的 turn 数 | ${summaryMetrics.forbiddenClaimTurns} |`);
lines.push('');
const flagged = summaryRows.filter(
  (r) =>
    r.missingFacts.length ||
    r.missingFiles.length ||
    r.hallucinatedFiles.length ||
    r.forbiddenHits.length ||
    !r.outcomePresent ||
    r.nextStepsMissing ||
    r.nextStepsExtra ||
    !r.memoryTypeOk,
);
if (flagged.length) {
  lines.push('### 逐条问题明细');
  lines.push('');
  lines.push('| turn | quality | 问题 |');
  lines.push('| --- | --- | --- |');
  for (const r of flagged) {
    const problems: string[] = [];
    if (!r.outcomePresent) problems.push('outcome 为空');
    if (r.nextStepsMissing) problems.push('next_steps 漏报未完成项');
    if (r.nextStepsExtra) problems.push('next_steps 过度生成（参考）');
    if (!r.memoryTypeOk) problems.push('memory_type 不符（参考）');
    if (r.missingFacts.length) problems.push(`事实缺失: ${r.missingFacts.join(' / ')}`);
    if (r.missingFiles.length) problems.push(`文件缺失: ${r.missingFiles.join(' / ')}`);
    if (r.hallucinatedFiles.length) problems.push(`幻觉文件: ${r.hallucinatedFiles.join(' / ')}`);
    if (r.forbiddenHits.length) problems.push(`虚构断言: ${r.forbiddenHits.join(' / ')}`);
    lines.push(`| ${r.id} | ${r.quality} | ${problems.join('；')} |`);
  }
  lines.push('');
} else {
  lines.push('全部 turn 无标注偏差。');
  lines.push('');
}
lines.push('## 检索质量（§12.3 pull 检索精度 / Scope 隔离 / 延迟）');
lines.push('');
lines.push('| 指标 | 值 |');
lines.push('| --- | --- |');
lines.push(`| hit@5（全部 ${retrievalMetrics.relevanceQueries} 条 relevance） | ${pctStr(retrievalMetrics.hitAt5)} |`);
lines.push(`| ├ hit@5（tuned ${retrievalMetrics.tunedQueries} 条，检索曾在其上调优） | ${pctStr(retrievalMetrics.tunedHitAt5)} |`);
lines.push(`| └ hit@5（heldout ${retrievalMetrics.heldoutQueries} 条，未据此调参） | **${pctStr(retrievalMetrics.heldoutHitAt5)}** |`);
lines.push(`| hit@10 | ${pctStr(retrievalMetrics.hitAt10)} |`);
lines.push(`| MRR@10 | ${fmt(retrievalMetrics.mrr)} |`);
lines.push(`| recall@10 | ${pctStr(retrievalMetrics.recallAt10)} |`);
lines.push(`| R-precision（下界） | ${pctStr(retrievalMetrics.rPrecision)} |`);
lines.push(`| ├ R-precision（tuned） | ${pctStr(retrievalMetrics.tunedRPrecision)} |`);
lines.push(`| └ R-precision（heldout） | ${pctStr(retrievalMetrics.heldoutRPrecision)} |`);
lines.push(`| heldout 中因零词汇锚点返回空的条数 | ${retrievalMetrics.heldoutNoAnchor} / ${retrievalMetrics.heldoutQueries} |`);
lines.push(`| expected-empty query 平均返回（${retrievalMetrics.expectedEmptyQueries} 条） | ${fmt(retrievalMetrics.expectedEmptyReturned, 2)}（最坏 ${retrievalMetrics.expectedEmptyWorst}） |`);
lines.push(`| 跨 workspace 泄漏条数 | ${retrievalMetrics.leakTotal} |`);
lines.push(`| FTS-only 降级次数 | ${retrievalMetrics.degrades} / ${retrievalMetrics.queries} |`);
lines.push(`| search p50 / p95 | ${fmt(retrievalMetrics.latencyP50, 1)}ms / ${fmt(retrievalMetrics.latencyP95, 1)}ms |`);
lines.push(`| bootstrap 当前 scope | ${bootstrapPrimary.bytes}B / ${fmt(bootstrapPrimary.ms, 1)}ms（预算 ${config.context.maxOutputBytes}B） |`);
lines.push(`| bootstrap 另一 scope | ${bootstrapOther.bytes}B |`);
lines.push(`| bootstrap 空 scope | ${bootstrapEmpty.bytes}B |`);
lines.push('');
lines.push('### 逐 query 明细');
lines.push('');
lines.push('| query | 类型 | 期望 | 命中名次 | match_source | 泄漏 | 延迟 |');
lines.push('| --- | --- | --- | --- | --- | --- | --- |');
for (const r of queryRows) {
  lines.push(
    `| ${r.id} ${r.query} | ${r.kind} | ${r.expect.join(',') || '—'} | ${r.ranks.join(',') || (r.kind === 'relevance' ? '未命中' : `返回 ${r.returned} 条`)} | ${r.matchSources.join('+') || '—'} | ${r.leaked.join(',') || '0'} | ${fmt(r.latencyMs, 1)}ms |`,
  );
}
lines.push('');
lines.push('## 复现');
lines.push('');
lines.push('```bash');
lines.push(`bun run benchmark/run.ts --compressor=${compressorKind}${enableEmbeddings ? '' : ' --no-embeddings'}`);
lines.push('```');
lines.push('');
lines.push('评估全程使用临时数据目录与临时 SQLite，不读写开发者真实 `~/.kiro-mem`（ACP 模式仅只读引用真实 `kiro-runtime` 以复用已安装的压缩子 Agent）。');
lines.push('');

mkdirSync(join(import.meta.dir, 'reports'), { recursive: true });
writeFileSync(reportPath, lines.join('\n'), 'utf-8');

// 机器可读指标：`--runs=N` 的编排器读它来聚合多次运行的方差。
if (jsonPath) {
  writeFileSync(
    jsonPath,
    JSON.stringify({ provenance, compressorKind, enableEmbeddings, summaryMetrics, retrievalMetrics, allGatesOk }, null, 2),
    'utf-8',
  );
}

console.log('');
console.log(`[benchmark] 门槛：${allGatesOk ? '全部通过' : '存在未达标项'}`);
for (const kind of ['discriminating', 'selfcheck', 'structural', 'performance'] as GateKind[]) {
  const group = gatesOfKind(kind);
  if (!group.length) continue;
  console.log(`  — ${KIND_LABEL[kind]}`);
  for (const g of group) console.log(`    ${gate(g.ok)} ${g.name}: ${g.value}`);
}
console.log('');
console.log(`[benchmark] 报告已写入 ${reportPath}`);

db.close();
rmSync(workDir, { recursive: true, force: true });
process.exit(allGatesOk ? 0 : 1);
