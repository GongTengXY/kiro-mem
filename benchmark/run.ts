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

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { loadConfig, getDataDir, type Config } from '../src/config';
import type { MemoryCompressor, ObservationSummaryResult } from '../src/compressor';

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
  /** 可核对事实标记：应出现在 Observation 正文中（逐字子串） */
  key_facts: string[];
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
  kind: 'relevance' | 'leakage';
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

if (compressorKind !== 'gold' && compressorKind !== 'acp') {
  console.error(`unknown --compressor=${compressorKind} (expected gold|acp)`);
  process.exit(2);
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
      evidence: a.key_facts,
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

  // 事实标记召回：标注的可核对事实是否保留。比较前去掉空白，"58fps" 与
  // "58 fps" 是同一个事实，不该因为排版差异算缺失。
  const squash = (s: string) => s.replace(/\s+/g, '');
  const squashedBody = squash(body);
  const missingFacts = a.key_facts.filter((f) => !squashedBody.includes(squash(f)));
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
  query: string;
  expect: string[];
  ranks: number[];
  hitAt5: boolean;
  hitAt10: boolean;
  reciprocalRank: number;
  recallAt10: number;
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

  queryRows.push({
    id: q.id,
    kind: q.kind,
    query: q.query,
    expect: q.expect,
    ranks,
    hitAt5: best > 0 && best <= 5,
    hitAt10: best > 0 && best <= 10,
    reciprocalRank: best > 0 ? 1 / best : 0,
    recallAt10: q.expect.length ? ranks.length / q.expect.length : 1,
    leaked,
    matchSources: [...new Set(results.map((r) => r.match_source))],
    latencyMs,
    returned: results.length,
  });
}

const relevanceRows = queryRows.filter((r) => r.kind === 'relevance');
const latencies = queryRows.map((r) => r.latencyMs).sort((a, b) => a - b);
const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor((latencies.length * p) / 100))] ?? 0;

const retrievalMetrics = {
  queries: queryRows.length,
  relevanceQueries: relevanceRows.length,
  hitAt5: rate(relevanceRows.filter((r) => r.hitAt5).length, relevanceRows.length),
  hitAt10: rate(relevanceRows.filter((r) => r.hitAt10).length, relevanceRows.length),
  mrr: mean(relevanceRows.map((r) => r.reciprocalRank)),
  recallAt10: mean(relevanceRows.map((r) => r.recallAt10)),
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
/** 报告会入库，不要把开发者的 home 绝对路径写进去。 */
const tildify = (p: string) => {
  const home = process.env.HOME;
  return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
};

const gate = (ok: boolean) => (ok ? '✅' : '❌');
const gates = [
  { name: 'Top-5 至少一条标注 Observation 命中', value: pctStr(retrievalMetrics.hitAt5), ok: retrievalMetrics.hitAt5 >= 0.9 },
  { name: '跨 workspace 检索泄漏为 0', value: String(retrievalMetrics.leakTotal), ok: retrievalMetrics.leakTotal === 0 },
  { name: '跨 workspace bootstrap 注入为 0', value: String(bootstrapLeaks), ok: bootstrapLeaks === 0 },
  { name: 'outcome 非空率', value: pctStr(summaryMetrics.outcomePresentRate), ok: summaryMetrics.outcomePresentRate >= 0.9 },
  { name: `next_steps 未完成项召回（${summaryMetrics.nextStepsRecallBase} 条有未完成项）`, value: pctStr(summaryMetrics.nextStepsRecall), ok: summaryMetrics.nextStepsRecall >= 0.85 },
  { name: '关键事实逐字召回', value: pctStr(summaryMetrics.factRecall), ok: summaryMetrics.factRecall >= 0.8 },
  { name: '关键文件召回', value: pctStr(summaryMetrics.fileRecall), ok: summaryMetrics.fileRecall >= 0.8 },
  { name: '虚构完成状态 turn 数', value: String(summaryMetrics.forbiddenClaimTurns), ok: summaryMetrics.forbiddenClaimTurns === 0 },
  { name: '幻觉文件 turn 数', value: String(summaryMetrics.hallucinatedFileTurns), ok: summaryMetrics.hallucinatedFileTurns === 0 },
  { name: 'search p95 延迟 < 300ms', value: `${fmt(retrievalMetrics.latencyP95, 1)}ms`, ok: retrievalMetrics.latencyP95 < 300 },
  { name: 'bootstrap 构建 < 100ms 且在预算内', value: `${fmt(bootstrapPrimary.ms, 1)}ms / ${bootstrapPrimary.bytes}B`, ok: bootstrapPrimary.ms < 100 && bootstrapPrimary.bytes <= config.context.maxOutputBytes },
];
const allGatesOk = gates.every((g) => g.ok);

const lines: string[] = [];
lines.push(`# kiro-mem V3 质量基准报告（${compressorKind} 压缩器）`);
lines.push('');
lines.push(`- 生成时间：${new Date().toISOString()}`);
lines.push(`- 压缩器：\`${compressorKind}\`${compressorKind === 'acp' ? `（kiro-runtime=${tildify(realConfig.runtime.kiroHome || join(realDataDir, 'kiro-runtime'))}，timeoutMs=${realConfig.compression.timeoutMs}，maxRetries=${realConfig.compression.maxRetries}）` : '（直接返回人工标注，用于检索基线与打分器自检）'}`);
lines.push(`- Embedding：${enableEmbeddings ? `启用，coverage ${fmt(stats.embeddings.coverage, 2)}` : '关闭（仅 FTS 路径）'}`);
lines.push(`- 数据集：${turns.length} 个标注 turn（primary ${turns.filter((t) => t.scope === 'primary').length} / other ${turns.filter((t) => t.scope === 'other').length}），${queries.length} 个标注 query（relevance ${relevanceRows.length} / leakage ${queryRows.length - relevanceRows.length}）`);
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
lines.push('| 门槛 | 实测 | 结果 |');
lines.push('| --- | --- | --- |');
for (const g of gates) lines.push(`| ${g.name} | ${g.value} | ${gate(g.ok)} |`);
lines.push('');
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
lines.push(`| hit@5（Top-5 至少一条标注命中） | ${pctStr(retrievalMetrics.hitAt5)} |`);
lines.push(`| hit@10 | ${pctStr(retrievalMetrics.hitAt10)} |`);
lines.push(`| MRR@10 | ${fmt(retrievalMetrics.mrr)} |`);
lines.push(`| recall@10 | ${pctStr(retrievalMetrics.recallAt10)} |`);
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
    `| ${r.id} ${r.query} | ${r.kind} | ${r.expect.join(',') || '—'} | ${r.ranks.join(',') || (r.kind === 'leakage' ? `返回 ${r.returned} 条` : '未命中')} | ${r.matchSources.join('+') || '—'} | ${r.leaked.join(',') || '0'} | ${fmt(r.latencyMs, 1)}ms |`,
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

console.log('');
console.log(`[benchmark] 门槛：${allGatesOk ? '全部通过' : '存在未达标项'}`);
for (const g of gates) console.log(`  ${gate(g.ok)} ${g.name}: ${g.value}`);
console.log('');
console.log(`[benchmark] 报告已写入 ${reportPath}`);

db.close();
rmSync(workDir, { recursive: true, force: true });
process.exit(allGatesOk ? 0 : 1);
