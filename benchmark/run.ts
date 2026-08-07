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
import { indexBody, factMatches, factLabel } from './scoring';
import type { RetrievalPolicy } from '../src/server/observation-search';
import {
  DATASET_DIR,
  loadDataset,
  validateQueries,
  annotationToResult,
  loadAcpEnFixture,
  assertAcpEnFixtureComplete,
  PHASE2_QUERIES_FILE,
  FUSION_QUERIES_FILE,
  EMPTY_EXT_QUERIES_FILE,
  type DatasetTurn,
  type DatasetQuery,
} from './dataset';

// 数据集类型、标注自检与"标注 → gold Observation"的映射都在 `./dataset.ts`：
// 两个离线 probe 需要同一份，手抄一份就是给同一个概念造第二个事实来源。

// ---------------------------------------------------------------------------
// CLI 参数
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
function flag(name: string, fallback?: string): string | undefined {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const compressorKind = flag('compressor', 'gold') as 'gold' | 'acp';
/**
 * 阶段 1b 的 A/B 自变量，也是**唯一**自变量。
 *
 * `raw`         —— 当前项目行为：原文直接向量化（对照组 A，与 phase 0 口径一致）。
 * `semantic-en` —— 双侧英文归一化（arm B）：记录侧派生值与 query 侧英文形式都取
 *                  ACP 固定输入，模型/dtype/维度/字段拼接/候选池/FTS/RRF/limit 全部不变。
 *
 * 不做成"自动检测有没有固定输入"：那会让一次缺文件的运行静默变成 arm A，然后被
 * 当成 arm B 的读数。
 */
const protocolArg = flag('protocol', 'raw') as 'raw' | 'semantic-en';
if (protocolArg !== 'raw' && protocolArg !== 'semantic-en') {
  console.error(`unknown --protocol=${protocolArg} (expected raw|semantic-en)`);
  process.exit(2);
}
const useSemanticEn = protocolArg === 'semantic-en';

// ---------------------------------------------------------------------------
// 检索策略参数（阶段 2A，方案 §6.2 第 4 项）
// ---------------------------------------------------------------------------
//
// 每个 knob 都必须**显式**给出，缺省即取 `DEFAULT_RETRIEVAL_POLICY`。不做成环境
// 变量：方案 §4.1 明确禁止"从环境变量隐式改变质量实验"，而一个从 shell 继承来的
// floor 会让报告里写的 policy 与实际跑的 policy 不一致——那比没有 policy 更坏。
//
// 解析失败一律退出而不是回落到默认值：`--semantic-floor=0.22.3` 静默变成 0.2，
// 就等于把一个 arm 的结果写进了另一个 arm 的名下。
const numFlag = (name: string): number | undefined => {
  const raw = flag(name);
  if (raw === undefined) return undefined;
  const n = raw === 'inf' || raw === 'none' ? Number.POSITIVE_INFINITY : Number(raw);
  if (Number.isNaN(n)) {
    console.error(`--${name}=${raw} 不是数字（无上限写 inf）`);
    process.exit(2);
  }
  return n;
};
const boolFlag = (name: string): boolean | undefined => {
  const raw = flag(name);
  if (raw === undefined) return undefined;
  if (raw !== 'on' && raw !== 'off') {
    console.error(`--${name}=${raw} 只接受 on|off`);
    process.exit(2);
  }
  return raw === 'on';
};
const bigramVoteArg = flag('bigram-vote');
const BIGRAM_VOTES = ['always', 'discovery-only'] as const;
if (bigramVoteArg !== undefined && !(BIGRAM_VOTES as readonly string[]).includes(bigramVoteArg)) {
  console.error(`--bigram-vote=${bigramVoteArg} 只接受 ${BIGRAM_VOTES.join('|')}`);
  process.exit(2);
}
const tieBreakArg = flag('tie-break');
const TIE_BREAKS = ['recency', 'source-confidence', 'semantic-rank'] as const;
if (tieBreakArg !== undefined && !(TIE_BREAKS as readonly string[]).includes(tieBreakArg)) {
  console.error(`--tie-break=${tieBreakArg} 只接受 ${TIE_BREAKS.join('|')}`);
  process.exit(2);
}

/** 只含**显式给出**的字段，逐字段覆盖到内核默认值上。 */
const policyOverride: Partial<RetrievalPolicy> = {
  ...(boolFlag('semantic-discovery') !== undefined ? { semanticDiscovery: boolFlag('semantic-discovery')! } : {}),
  ...(numFlag('semantic-floor') !== undefined ? { semanticFloor: numFlag('semantic-floor')! } : {}),
  ...(numFlag('semantic-only-limit') !== undefined ? { semanticOnlyLimit: numFlag('semantic-only-limit')! } : {}),
  ...(numFlag('rrf-k') !== undefined ? { rrfK: numFlag('rrf-k')! } : {}),
  ...(numFlag('fts-weight') !== undefined ? { ftsWeight: numFlag('fts-weight')! } : {}),
  ...(numFlag('semantic-weight') !== undefined ? { semanticWeight: numFlag('semantic-weight')! } : {}),
  ...(tieBreakArg !== undefined ? { tieBreak: tieBreakArg as RetrievalPolicy['tieBreak'] } : {}),
  // 阶段 3B：语义候选池大小。`inf` = 全 scope brute-force。缺省即 200（当前发布行为）。
  ...(numFlag('semantic-candidate-pool') !== undefined ? { semanticCandidatePool: numFlag('semantic-candidate-pool')! } : {}),
  ...(numFlag('semantic-topk') !== undefined ? { semanticTopK: numFlag('semantic-topk')! } : {}),
  // 阶段 3A：中文两字词辅助腿。与上面同一套纪律——缺省即取内核默认值（关闭），
  // 解析失败退出而不是回落，否则一个 arm 的结果会被写进另一个 arm 的名下。
  ...(boolFlag('bigram-aux') !== undefined ? { bigramAux: boolFlag('bigram-aux')! } : {}),
  ...(numFlag('bigram-df-ratio-ceiling') !== undefined ? { bigramDfRatioCeiling: numFlag('bigram-df-ratio-ceiling')! } : {}),
  ...(numFlag('bigram-min-matches') !== undefined ? { bigramMinMatches: numFlag('bigram-min-matches')! } : {}),
  ...(numFlag('bigram-only-limit') !== undefined ? { bigramOnlyLimit: numFlag('bigram-only-limit')! } : {}),
  ...(numFlag('bigram-weight') !== undefined ? { bigramWeight: numFlag('bigram-weight')! } : {}),
  ...(bigramVoteArg !== undefined ? { bigramVote: bigramVoteArg as RetrievalPolicy['bigramVote'] } : {}),
};
/**
 * 读一次新增验证集（20 条，中英文各 10）。
 *
 * 显式开关而不是默认加载：这批样本的全部价值就在于"没参与过任何选择"，而默认
 * 加载会让它在每次调参跑 bench 时被消耗掉，几轮之后它和 tuned 就没区别了。
 * 它也不进任何门槛——门槛数值是在 phase 0 之后写死的，事后为新样本补一个阈值
 * 等于没有阈值（§9 纪律 3）。
 */
const withValidation = args.includes('--validation');
/**
 * 加载 Gate A 冻结的 Phase 2 校准集（121 条，全部 `ftsCount = 0`）。
 *
 * 与 `--validation` 一样是显式开关，但理由不同：validation 怕被消耗，phase2 怕被混入。
 * 打开它会改变**全局**聚合（`hitAt5` / `semanticOnly*` / 延迟分布 / 泄漏计数都跨全集
 * 汇总），所以「与 Phase 1b 逐 query 一致」那份中立性报告必须在**不带**这个开关的
 * 情况下跑。分层指标见报告的「Phase 2 校准集」一节。
 */
const withPhase2 = args.includes('--phase2');
/**
 * 加载 Phase 3A-R2 的两份冻结数据集（fusion 62 条 S1–S5 / empty-ext 32 条 N1–N4）。
 *
 * 与 phase2 同一条纪律、同一个理由：默认不加载，怕被**混入**。R2 的 empty-ext 尤其危险——
 * `expectedEmptyRows` 是按 `kind === 'empty'` 取的，若不把 R2 的 id 排除掉，那 32 条会涌进
 * 既有 5 条 expected-empty 的连续性锁里，把 Gate E 明确要求保留的门槛冲掉。排除逻辑写在
 * 下面 `expectedEmptyRows` 的过滤条件里。
 */
const withFusion = args.includes('--fusion');
const withEmptyExt = args.includes('--empty-ext');
/**
 * 从数据集中**彻底移除** heldout query（阶段 2B 扫参用）。
 *
 * 方案 §7.3 / §14.7：`heldout` 是确认集，只能在策略冻结之后跑一次，不得参与选参。
 * 做成"算出来但不看"不够——那只是承诺。这个开关让 heldout 在加载阶段就消失，于是
 * 矩阵 arm 的报告里**不存在**任何 heldout 数字，Codex 可以直接从 JSON 缺失该字段
 * 来验证纪律，而不是相信我没看。
 *
 * 阶段 2A 我曾在一次 flag 验证里看到过 `(floor=0.223, cap=3)` 的 heldout 读数并已披露；
 * 这个开关就是那次错误的结构性补救。
 */
const noHeldout = args.includes('--no-heldout');
const enableEmbeddings = !args.includes('--no-embeddings');
const concurrencyOverride = flag('concurrency') ? Number(flag('concurrency')) : undefined;
const reportPath = resolve(
  flag(
    'report',
    join(
      import.meta.dir,
      'reports',
      `${compressorKind}-latest${useSemanticEn ? '-semantic-en' : ''}.md`,
    ),
  )!,
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
      tunedMrr: m.retrievalMetrics.tunedMrr,
      heldoutMrr: m.retrievalMetrics.heldoutMrr,
      recallAt10: m.retrievalMetrics.recallAt10,
      rPrecision: m.retrievalMetrics.rPrecision,
      expectedEmptyReturned: m.retrievalMetrics.expectedEmptyReturned,
      factRecall: m.summaryMetrics.factRecall,
      fileRecall: m.summaryMetrics.fileRecall,
      memoryTypeAccuracy: m.summaryMetrics.memoryTypeAccuracy,
      outcomePresentRate: m.summaryMetrics.outcomePresentRate,
      fallback: m.summaryMetrics.fallback,
      // 阶段 1b 新增：压缩 prompt 变长的两个代价面。
      // `jsonRepairs` 上升说明输出变长后更容易返回坏 JSON；`derivedReady` 是生产形态
      // 下记录侧英文归一化的首轮成功条数（30 为满分）。两者在 gold 模式下恒定。
      jsonRepairs: m.compressorStats?.repairs ?? 0,
      parseFallbacks: m.compressorStats?.parseFallbacks ?? 0,
      derivedReady: m.protocolStats?.derived?.ready ?? 0,
      derivedPending: m.protocolStats?.derived?.pending ?? 0,
      derivedFailed: m.protocolStats?.derived?.failed ?? 0,
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
const { hybridSearchObservations, DEFAULT_RETRIEVAL_POLICY, validateRetrievalPolicy } =
  await import('../src/server/observation-search');
const { buildBootstrapContext } = await import('../src/bootstrap-context');
const { extractArtifacts } = await import('../src/jobs/artifacts');

const { turns, queries: allQueries } = loadDataset(DATASET_DIR, {
  withValidation, withPhase2, withFusion, withEmptyExt,
});
const queries = noHeldout ? allQueries.filter((q) => q.origin !== 'heldout') : allQueries;
if (noHeldout) {
  console.log(
    `[benchmark] --no-heldout：已移除 ${allQueries.length - queries.length} 条 heldout query，` +
      `本次运行不产生任何 heldout 指标`,
  );
}
/** Phase 2 校准集的 id 集合。按文件成员分桶，不靠 id 前缀约定。 */
const phase2Ids = new Set<string>(
  withPhase2
    ? (JSON.parse(
        readFileSync(join(DATASET_DIR, PHASE2_QUERIES_FILE), 'utf-8'),
      ) as DatasetQuery[]).map((q) => q.id)
    : [],
);

/**
 * R2 两份数据集的 id 与 fusion 集的**冻结分层**。
 *
 * 分层从文件读，不在这里重算：`queries-fusion.json` 里的 `precheck.stratum` 是数据集冻结时
 * 由预检判定的，checksum 已锁。按 arm 运行结果重算分层会让「S2/S5 必须逐条不变」这条硬锁
 * 自我实现——那两层的定义本身就会随 arm 漂移。
 */
type R2Row = DatasetQuery & { precheck?: { stratum?: string; layer?: string } };
const readR2 = (file: string): R2Row[] =>
  JSON.parse(readFileSync(join(DATASET_DIR, file), 'utf-8')) as R2Row[];
const fusionRaw = withFusion ? readR2(FUSION_QUERIES_FILE) : [];
const emptyExtRaw = withEmptyExt ? readR2(EMPTY_EXT_QUERIES_FILE) : [];
const fusionIds = new Set(fusionRaw.map((q) => q.id));
const emptyExtIds = new Set(emptyExtRaw.map((q) => q.id));
const stratumOfId = new Map<string, string>(
  fusionRaw.map((q) => [q.id, q.precheck?.stratum ?? '?']),
);
const nLayerOfId = new Map<string, string>(
  emptyExtRaw.map((q) => [q.id, q.precheck?.layer ?? '?']),
);

const datasetErrors = validateQueries(queries);
if (datasetErrors.length) {
  for (const e of datasetErrors) console.error(`[benchmark] ${e}`);
  process.exit(2);
}

// arm B 的固定输入。缺任何一条都直接退出：静默回落成 raw 协议的那一条 query 会
// 被算进"英文归一化"的读数里，而那是两个 arm 混算。
const enFixture = useSemanticEn
  ? loadAcpEnFixture(DATASET_DIR, { withValidation, withPhase2, withR2: withFusion || withEmptyExt })
  : null;
if (enFixture) {
  const missing = assertAcpEnFixtureComplete(enFixture, { turns, queries });
  if (missing.length) {
    console.error('[benchmark] semantic-en 固定输入不完整：');
    for (const m of missing) console.error(`  ${m}`);
    console.error('[benchmark] 用 benchmark/probe-acp-translate.ts 补齐后再跑。');
    process.exit(2);
  }
  console.log(
    `[benchmark] protocol=semantic-en，固定输入：记录 ${Object.keys(enFixture.records).length} 条 / query ${Object.keys(enFixture.queries).length} 条`,
  );
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

/**
 * 本次运行实际生效的检索策略。
 *
 * 在 provenance 里写死，并在**每一条** query 的 `onCandidates` 回调里与内核上报的
 * policy 逐字段核对（见 `policyMismatches`）。只写 provenance 不够：一份自称
 * floor=0.223 的报告如果注入通道断了，每行都会安静地跑在 0.2 上。
 */
const resolvedPolicy: RetrievalPolicy = { ...DEFAULT_RETRIEVAL_POLICY, ...policyOverride };
// 值域校验放在**播种之前**：一个被静默接受的非法值会跑出一份完整报告，而报告的
// provenance 写的是那个非法值，读者无法从结果分辨它有没有真的生效。宁可不产出报告。
const policyErrors = validateRetrievalPolicy(resolvedPolicy);
if (policyErrors.length) {
  console.error('[benchmark] 检索策略非法：');
  for (const e of policyErrors) console.error(`  ${e}`);
  process.exit(2);
}
/** 无上限的 cap 在报告里写成 `inf`，因为 JSON 会把 Infinity 序列化成 null。 */
const policyForReport = {
  ...resolvedPolicy,
  semanticOnlyLimit: Number.isFinite(resolvedPolicy.semanticOnlyLimit)
    ? resolvedPolicy.semanticOnlyLimit
    : 'inf',
  bigramOnlyLimit: Number.isFinite(resolvedPolicy.bigramOnlyLimit)
    ? resolvedPolicy.bigramOnlyLimit
    : 'inf',
};
console.log(
  `[benchmark] policy: discovery=${resolvedPolicy.semanticDiscovery ? 'on' : 'off'}` +
    ` floor=${resolvedPolicy.semanticFloor} cap=${policyForReport.semanticOnlyLimit}` +
    ` K=${resolvedPolicy.rrfK} w=${resolvedPolicy.ftsWeight}:${resolvedPolicy.semanticWeight}` +
    ` tie=${resolvedPolicy.tieBreak}` +
    ` bigram=${resolvedPolicy.bigramAux ? 'on' : 'off'}` +
    `(df≤${resolvedPolicy.bigramDfRatioCeiling} min=${resolvedPolicy.bigramMinMatches}` +
    ` cap=${policyForReport.bigramOnlyLimit} w=${resolvedPolicy.bigramWeight})`,
);

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
    turnsHash: hashFile(join(DATASET_DIR, 'turns.json')),
    queriesHash: hashFile(join(DATASET_DIR, 'queries.json')),
    runHash: hashFile(join(import.meta.dir, 'run.ts')),
    scoringHash: hashFile(join(import.meta.dir, 'scoring.ts')),
    // 数据集契约与"标注 → gold Observation"映射搬到了 dataset.ts。不把它纳入
    // provenance，那份映射一改数字就变、报告却自称同一份脚本。
    datasetHash: hashFile(join(import.meta.dir, 'dataset.ts')),
    /** 检索策略：报告里必须能读出这组数字是哪个 arm 跑出来的（方案 §6.2 第 5 项）。 */
    retrievalPolicy: policyForReport,
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
    const result = annotationToResult(turn.annotation);
    // arm B: the derived value rides along with the summary, exactly as the ACP
    // compressor's own response does in production — so `summarize_turn` takes
    // the same code path in both arms, with no second translator call.
    if (enFixture) result.semantic_en = enFixture.records[turn.id];
    return result;
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

/**
 * 播种时每个 turn 的 `stopped_at`（Gate D 第二轮 P1-1）。
 *
 * 必须显式且唯一，不能让 `markTurnClosed()` 落回 `new Date()`。理由不是"洁癖"：
 * `recency` tie-break 的第一顺位就是 `turn_stopped_at`，第二顺位才是 id。播种走运行时时钟
 * 时，同一毫秒内关闭的 turn 走 id、跨毫秒的走时间戳，**于是精确平局的基线次序会随机器
 * 快慢变化**。实测过：同一份代码与数据、同一个 `tieBreak=recency`，v16 的 `match_source`
 * 次序在不同次运行里出现 `hybrid+semantic+fts` 与 `hybrid+fts+semantic` 两种结果。这不是
 * 指标噪声，而是本阶段**正在被比较的基线行为**在变。
 *
 * 口径：**当天 UTC 零点往前 30 天**为基准，按数据集顺序每个 turn 加 1 分钟。
 *
 * 为什么不用一个写死的绝对日期：`search` 的默认时间窗是 90 天，而且是相对墙上时钟算的。
 * 写死 `2026-01-01` 当天就跑不通——实测所有记录被窗口过滤掉，`allGatesOk: false`、
 * 全部 hit@5 归零。绝对基准会让这份基准集在某一天静默失效，这比不确定更糟。
 *
 * 所以确定性的口径是：**同一天内逐位可复现，跨天整体平移**。平移是均匀的，相对次序、
 * 间隔和落在窗口内这三件事都不变，因此平局行为完全一致。任何两个 turn 的时间都不同，
 * `recency` 永远在第一顺位决出结果，不会退到 id——两个顺位混用才是不确定性的来源。
 */
const SEED_STOPPED_AT_BASE_MS = (() => {
  const d = new Date();
  const dayStartUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return dayStartUtc - 30 * 24 * 60 * 60 * 1000;
})();
const seedStoppedAt = (index: number): string =>
  new Date(SEED_STOPPED_AT_BASE_MS + index * 60_000).toISOString();

for (const [turnIndex, t] of turns.entries()) {
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
  db.markTurnClosed(turn.id, seedStoppedAt(turnIndex));
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
  // arm B 还要等英文那条腿建完：`ready` 只要求"至少一个当前空间里有向量"，
  // 一条只有 raw 向量的记录同样满足它，于是 arm B 可能在英文空间只建了一半时
  // 就开始跑检索——读数会偏低，而原因看不出来。
  if (useSemanticEn) {
    await waitFor(
      () =>
        (db.getObservabilityStats().embeddings.byProtocol.find(
          (p) => p.protocol === 'semantic-en-v1',
        )?.ready ?? 0) >= turns.length,
      10 * 60_000,
      'semantic-en-v1 向量未在预算内全部建完',
    );
  }
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
/** 任意样本的百分位。延迟另有一份就地实现（`pct`），因为它复用已排序的数组。 */
const pctOf = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))] ?? 0;
};

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
/** 同上，primary scope 的 Observation id。泄漏判定需要「本 query 所搜 scope」两侧都有。 */
const primaryScopeObsIds = new Set(
  turns.filter((t) => t.scope === 'primary').map((t) => obsIdOf.get(t.id)!).filter(Boolean),
);

interface QueryRow {
  id: string;
  kind: string;
  /** 与 `DatasetQuery` 同源，避免两处 union 各自漂移。 */
  origin?: DatasetQuery['origin'];
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
  /** 返回页的有序数据集 id——行为 fingerprint 的主体（Gate D 第二轮 P1-2）。 */
  resultIds: string[];
  latencyMs: number;
  returned: number;
  // --- 分路明细（方案 §4.4）---
  //
  // 没有这些字段，一次 miss 的四种成因在最终结果里长得一模一样：FTS 没召回 /
  // 语义没召回 / 两路都召回但 RRF 排坏 / 被结果上限截掉。`matchSources` 也不够
  // ——它只是对**已返回**结果去重，看不到候选层。
  /** FTS 候选数（不是返回数）。`heldoutNoAnchor` 与 zero-FTS 子集靠它，且拆门后无法从结果反推。 */
  ftsCount: number;
  /** 越过 SEMANTIC_FLOOR 的语义候选数。 */
  semanticCount: number;
  /** 最终结果里 match_source === 'semantic' 的条数（阶段 2 限额的读数）。 */
  semanticOnlyReturned: number;
  /** 这条 query 是否降级为 FTS-only（原先只有全局计数）。 */
  degraded: boolean;
  /** 最靠前的 expected 名次（= ranks 取 min，显式落一列）。 */
  firstExpectedRank: number;
  /** expected 记录在 FTS 名次表里的位次；未进该路则 0。 */
  ftsRank: number;
  /** expected 记录在语义名次表里的位次；未进该路则 0。 */
  semanticRank: number;
  // --- 协议明细（阶段 1b）---
  /** 这条 query 实际用的向量空间协议。 */
  protocol: string;
  /** 提供的英文形式被护栏拒绝的原因；未拒绝为空。 */
  semanticQueryRejected: string | null;
  // --- 策略明细（阶段 2A）---
  /** 被 `semanticOnlyLimit` 丢弃的 semantic-only 候选数。默认 profile 下恒为 0。 */
  semanticOnlyDropped: number;
  // --- 阶段 3A：中文两字词辅助腿 ---
  //
  // 与上面 FTS/语义两路同一个理由：没有候选层读数，「bigram 腿把它找回来了」和
  // 「别的东西动了」在结果里长得一样。`bigramHitUnits` 是判据 §6.2 要求的归因——
  // 收益必须指到具体某个两字词。
  /** bigram 腿的候选数。关闭时恒为 0。 */
  bigramCount: number;
  /** 最终结果里 match_source === 'bigram' 的条数。 */
  bigramOnlyReturned: number;
  /** 被 `bigramOnlyLimit` 丢弃的 bigram-only 候选数。 */
  bigramOnlyDropped: number;
  /** expected 记录在 bigram 名次表里的位次；未进该路则 0。 */
  bigramRank: number;
  /** 实际发出辅助查询的两字词个数（无 CJK 的 query 恒为 0）。 */
  bigramUnitsProbed: number;
  /** 语料里根本不存在的两字词个数。 */
  bigramUnitsZeroDf: number;
  /** 被 DF 比例上限滤掉的两字词（带 DF）。 */
  bigramUnitsDropped: { bigram: string; df: number }[];
  /** 命中 expected 记录的两字词。3A 收益的逐条归因证据。 */
  bigramHitUnits: string[];
  // --- 阶段 3A-R2 ---
  /** 本次搜索实际生效的投票范围。 */
  bigramVoteMode: string;
  /** 因 `discovery-only` 而未计入的 bigram 项数。开关生效的直接读数。 */
  bigramVotesSuppressed: number;
  /** fusion 集的冻结分层（S1–S5）；非 fusion 行为空。 */
  fusionStratum: string | null;
  /** empty-ext 集的冻结层（N1–N4）；非该集行为空。 */
  emptyExtLayer: string | null;
  /** 融合分 `===` 相等的候选对数（全部候选，cap 与 limit 之前）。 */
  exactTiePairs: number;
  /** 其中是否至少有一组平局的成员进了结果页——只有这种平局能影响指标。 */
  exactTieInPage: boolean;
  /** policy 请求的 discovery。 */
  discoveryRequested: boolean;
  /**
   * 实际生效的 discovery = 请求了 **且** 在 `semantic-en-v1` 空间里。
   *
   * 与 requested 分开记的理由是归因：一个 arm 如果 `semantic_query_en` 覆盖率差，
   * 大量 query 其实从未离开关键词门，而报告只写"discovery=on"，那个 arm 的召回不足
   * 会被错误归给 floor（Gate A 整改）。
   */
  discoveryEffective: boolean;
}

const queryRows: QueryRow[] = [];
/**
 * 内核上报的 policy 与本次运行声明的 policy 不一致的 query。
 *
 * 非空即为硬失败：注入通道断掉时，报告仍会照抄 provenance 里的数字，但每一行跑的
 * 都是默认值。这一列是"报告里写的策略确实是跑出来那个"的唯一凭据。
 */
const policyMismatches: string[] = [];

/** 候选层观测（§4.4）。行为中立：只读，不回流进排序。 */
type Candidates = {
  ftsCount: number;
  semanticCount: number;
  ftsRank: ReadonlyMap<number, number>;
  semanticRank: ReadonlyMap<number, number>;
  protocol: string;
  semanticQueryRejected: string | null;
  policy: RetrievalPolicy;
  discoveryRequested: boolean;
  discoveryEffective: boolean;
  bigramCount: number;
  bigramRank: ReadonlyMap<number, number>;
  bigramMatched: ReadonlyMap<number, readonly string[]>;
  bigramUnits: { probed: number; dropped: { bigram: string; df: number }[]; zeroDf: number; scopeSize: number };
};

for (const q of queries) {
  let captured: Candidates | null = null;
  let degraded = false;
  let semanticOnlyDropped = 0;
  /**
   * 内核**实际算出的**融合排序与分数（Gate D P2）。
   *
   * 精确平局只能这样测，不能推断：一个候选对是否由 tie-break 决定次序，判据就是两条的
   * 融合分在 float64 下 `===`，与比较器里那一行是同一个比较。此前用 `w_sem=1+ε` 的差集
   * 反推是**有限扰动**，一般情况下可能翻转分数只是很接近的严格有序对，因此只能当辅助
   * 诊断，不能当证明。
   */
  let fused: readonly { id: number; score: number; matchSource: string; semRank: number | null; bigramRank: number | null }[] = [];
  let bigramOnlyDropped = 0;
  let bigramOnlyReturned = 0;
  let bigramVoteMode = '—';
  let bigramVotesSuppressed = 0;
  const t0 = performance.now();
  const results = await hybridSearchObservations(
    db,
    q.query,
    {
      scopeKey: scopeKeyOf(q.scope),
      limit: 10,
      // arm B：调用方（生产里是发起 search 的 Agent）随参数给出英文形式，
      // 不在检索路径里另起一次翻译。
      ...(enFixture ? { semanticQueryEn: enFixture.queries[q.id] } : {}),
    },
    {
      // 只传**显式给出**的字段。空对象与不传 policy 在内核里等价，所以默认 profile
      // 走的就是生产那条路径，不是"benchmark 自己拼出来的一份默认值"。
      policy: policyOverride,
      onDegrade: () => { degraded = true; },
      onCandidates: (info) => { captured = info; },
      onFusion: (info) => {
        semanticOnlyDropped = info.semanticOnlyDropped;
        bigramOnlyDropped = info.bigramOnlyDropped;
        bigramOnlyReturned = info.bigramOnlyReturned;
        bigramVoteMode = info.bigramVoteMode;
        bigramVotesSuppressed = info.bigramVotesSuppressed;
        fused = info.ranked;
      },
    },
  );
  const latencyMs = performance.now() - t0;
  const cand = captured as Candidates | null;

  const ranks = q.expect
    .map((e) => results.findIndex((r) => r.id === obsIdOf.get(e)) + 1)
    .filter((r) => r > 0);
  const best = ranks.length ? Math.min(...ranks) : 0;
  // 泄漏 = 返回了**不属于本 query 所搜 scope** 的记录。
  //
  // 早先的写法是 `otherScopeObsIds.has(r.id)`——把「来自 other scope」直接当泄漏，与 query
  // 自己在哪个 scope 无关。在此之前所有 query 都搜 primary，两种定义完全重合，所以那个
  // 简写一直没出问题。R2 的 w40（gold 是 x03，属 other scope）是第一条搜 other 的 query：
  // 它正确地在 other scope 里找到了 x03，却被旧口径记成一次泄漏。
  //
  // 对既有全部 query（都搜 primary）两种口径给出完全相同的结果，所以这是纯粹的定义修正，
  // 不改任何历史读数。
  const ownScopeObsIds = q.scope === 'primary' ? primaryScopeObsIds : otherScopeObsIds;
  const leaked = results
    .filter((r) => !ownScopeObsIds.has(r.id))
    .map((r) => datasetIdOfObs.get(r.id)!);

  // 两路名次按 §4.2 的排名口径：多 expected 取最靠前的那个，一个都没进则 0。
  const expectedObsIds = q.expect.map((e) => obsIdOf.get(e)!);
  const bestRankIn = (m: ReadonlyMap<number, number> | undefined): number => {
    const rs = expectedObsIds.map((id) => m?.get(id) ?? 0).filter((r) => r > 0);
    return rs.length ? Math.min(...rs) : 0;
  };

  // R-precision：在 R = |expect| 这个截断点上的精度。
  //
  // 不用 precision@5：标注集里 expect 通常只有 1 条，那么 precision@5 的**上限**
  // 就是 20%，测出来的 21% 只是 hit@5 的另一种写法，不是精度。R-precision 的
  // 截断点跟着标注规模走，1.0 表示"前 R 条正好就是标注的 R 条"，可解释也可比较。
  const expectedIds = new Set(expectedObsIds);
  const r = q.expect.length;
  const rPrecision = r
    ? results.slice(0, r).filter((x) => expectedIds.has(x.id)).length / r
    : 1;

  // --- 精确平局枚举（Gate D P2）---
  //
  // 按融合分分组：同一组内两两之间的次序完全由 tie-break 规则决定，与分数无关。
  // `exactTieInPage` 只在该组至少有一条进了结果页时为真——排在页外深处的平局不影响
  // 任何指标，把它计进去会让"平局规模"这个数字失去意义。
  const byScore = new Map<number, number[]>();
  for (const f of fused) {
    const g = byScore.get(f.score);
    if (g) g.push(f.id);
    else byScore.set(f.score, [f.id]);
  }
  const tieGroups = [...byScore.values()].filter((g) => g.length > 1);
  const returnedIds = new Set(results.map((x) => x.id));
  const exactTiePairs = tieGroups.reduce((n, g) => n + (g.length * (g.length - 1)) / 2, 0);
  const exactTieInPage = tieGroups.some((g) => g.some((id) => returnedIds.has(id)));

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
    /**
     * 返回页的**有序**数据集 id（Gate D 第二轮 P1-2）。
     *
     * 没有它，两条无关 hybrid 互换位置时 `ranks` / `matchSources`（去重过）/ `returned`
     * 可能全部不变，逐 query diff 就会漏报——于是"改动 4/9""候选是 source-confidence 改动集
     * 的超集""D4 覆盖数量"都变成无法机械证明的说法。用数据集 id 而不是数据库自增 id：
     * 前者与播种顺序解耦，报告里也读得懂。
     */
    resultIds: results.map((r) => datasetIdOfObs.get(r.id) ?? `obs:${r.id}`),
    latencyMs,
    returned: results.length,
    ftsCount: cand?.ftsCount ?? 0,
    semanticCount: cand?.semanticCount ?? 0,
    semanticOnlyReturned: results.filter((x) => x.match_source === 'semantic').length,
    degraded,
    firstExpectedRank: best,
    ftsRank: bestRankIn(cand?.ftsRank),
    bigramCount: cand?.bigramCount ?? 0,
    bigramOnlyReturned,
    bigramOnlyDropped,
    bigramRank: bestRankIn(cand?.bigramRank),
    bigramUnitsProbed: cand?.bigramUnits.probed ?? 0,
    bigramUnitsZeroDf: cand?.bigramUnits.zeroDf ?? 0,
    bigramUnitsDropped: cand?.bigramUnits.dropped ?? [],
    // 命中 expected 记录的两字词。判据 §6.2 的归因证据：3A 的收益必须能指到
    // 具体某个词，而不是"FTS 整体变好了"。
    bigramHitUnits: [
      ...new Set(expectedObsIds.flatMap((id) => [...(cand?.bigramMatched.get(id) ?? [])])),
    ],
    bigramVoteMode,
    bigramVotesSuppressed,
    fusionStratum: stratumOfId.get(q.id) ?? null,
    emptyExtLayer: nLayerOfId.get(q.id) ?? null,
    semanticRank: bestRankIn(cand?.semanticRank),
    protocol: cand?.protocol ?? 'unknown',
    semanticQueryRejected: cand?.semanticQueryRejected ?? null,
    semanticOnlyDropped,
    exactTiePairs,
    exactTieInPage,
    discoveryRequested: cand?.discoveryRequested ?? false,
    discoveryEffective: cand?.discoveryEffective ?? false,
  });

  // 逐条核对内核实际用的 policy 与本次运行声明的一致。空 query 不触发
  // `onCandidates`，那种情况没有 policy 可核，跳过而不是记成不一致。
  if (cand && JSON.stringify(cand.policy) !== JSON.stringify(resolvedPolicy)) {
    policyMismatches.push(`${q.id}: ${JSON.stringify(cand.policy)}`);
  }
}

if (policyMismatches.length) {
  console.error('[benchmark] 内核上报的 policy 与本次运行声明的不一致：');
  for (const m of policyMismatches) console.error(`  ${m}`);
  console.error(`[benchmark] 声明值：${JSON.stringify(resolvedPolicy)}`);
  process.exit(2);
}

const relevanceRows = queryRows.filter(
  // validation 与 phase2 单独统计：把它们混进 relevanceRows 会改动全局 hitAt5 / mrr，
  // 而那些数字要和 phase 0 / arm A 逐项对比。
  (r) => r.kind === 'relevance' && r.origin !== 'validation' && !phase2Ids.has(r.id),
);
const tunedRows = relevanceRows.filter((r) => r.origin === 'tuned');
const heldoutRows = relevanceRows.filter((r) => r.origin === 'heldout');
/**
 * zero-FTS relevance：FTS 候选数为 0 的 relevance query，跨 origin 汇总。
 *
 * 这是阶段 2 拆门的**主正面证据**（方案 §7.4）。它必须独立于 origin 统计：既有
 * `tuned` 里有 1 条（q08）、`heldout` 里有 9 条，而 Phase 2 校准集整整 74 条全是
 * 这一类。按 origin 分桶会把同一个现象拆成三份小样本。
 *
 * `semanticDiscovery=false` 时这批 query 的 hit@5 与 MRR 结构上恒为 0——不是模型
 * 不行，是它们在 embedding 之前就返回了。这正是拆门要改变的那个数。
 */
const zeroFtsRelevanceRows = relevanceRows.filter((r) => r.ftsCount === 0);
/**
 * Phase 2 校准集（Gate A 冻结，121 条全部 `ftsCount = 0`）。
 *
 * 与既有 `tuned` / `heldout` **严格分桶**，两个方向都要挡住：
 *
 *  - 它不能进 `relevanceRows` / `expectedEmptyRows`，否则 tuned 连续性锁与历史
 *    expected-empty 口径会被 121 条新样本冲掉，而那两个数字要和 phase 0 / 1b 逐项对比；
 *  - 既有样本也不能进 Phase 2 指标，否则"选参只用 Gate A 冻结的集合"就不成立
 *    （方案 §7.3）。
 *
 * 分桶键取**文件成员**而不是 `origin`：phase2 的 empty 行没有 `origin`（按 dataset.ts
 * 的约定 origin 只对 relevance 有意义），按 origin 判会漏掉 49 条 empty。
 */
const phase2RelevanceRows = queryRows.filter((r) => phase2Ids.has(r.id) && r.kind === 'relevance');
const phase2EmptyRows = queryRows.filter((r) => phase2Ids.has(r.id) && r.kind === 'empty');
const isCjk = (s: string) => /[\u4e00-\u9fff]/.test(s);
const phase2RelevanceZhRows = phase2RelevanceRows.filter((r) => isCjk(r.query));
const phase2RelevanceEnRows = phase2RelevanceRows.filter((r) => !isCjk(r.query));
const phase2EmptyZhRows = phase2EmptyRows.filter((r) => isCjk(r.query));
const phase2EmptyEnRows = phase2EmptyRows.filter((r) => !isCjk(r.query));
/** 新增验证集（§5.6）。空数组表示这次没跑 `--validation`。 */
const validationRows = queryRows.filter((r) => r.origin === 'validation');
/** 中文 / 英文两半分开报：它们测的不是同一件事。 */
const validationZhRows = validationRows.filter((r) => /[\u4e00-\u9fff]/.test(r.query));
const validationEnRows = validationRows.filter((r) => !/[\u4e00-\u9fff]/.test(r.query));
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
// --- 阶段 3A-R2 分层 ---
//
// 五层各有职责，混起来看会掩盖问题（判据 §4.2）：S1 测加票有没有破坏已有排序，
// S2/S5 是中立性硬锁（bigram 腿跑了但没碰到 gold，任何参数都不该改变它们），
// S3 测词面锚点的正面作用，S4 是 `bigramOnlyLimit` 唯一完全管辖的一层。
const fusionRows = queryRows.filter((r) => fusionIds.has(r.id));
const fusionByStratum = (st: string) => fusionRows.filter((r) => r.fusionStratum === st);
const emptyExtRows = queryRows.filter((r) => emptyExtIds.has(r.id));
const emptyExtByLayer = (l: string) => emptyExtRows.filter((r) => r.emptyExtLayer === l);

const expectedEmptyRows = queryRows.filter(
  // R2 的 empty-ext 也必须排除，否则那 32 条会冲掉既有 5 条的连续性锁——Gate E 明确裁定
  // 「不能用结果出来后的集合替换既有连续性锁」，而混进同一个分母就是最隐蔽的那种替换。
  (r) => r.kind === 'empty' && !phase2Ids.has(r.id) && !emptyExtIds.has(r.id),
);
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
  /**
   * 分层 MRR（§4.1）。
   *
   * hit@5 是阶跃函数：期望记录从第 4 位升到第 1 位它一动不动。而"门关着"的阶段
   * 里，换编码器**唯一**能改变的就是排序——只看 hit@5，一个真正更好的编码器会
   * 显示为"没变化"，然后一个正确的改动被回退。MRR 仍不是连续量（它是离散 rank
   * 的函数），但比 hit@5 细得多：单条 query 对它的**最大**贡献是 1/n（未命中升到
   * 第 1 位），不是每条固定 1/n。
   */
  tunedMrr: mean(tunedRows.map((r) => r.reciprocalRank)),
  tunedRPrecision: mean(tunedRows.map((r) => r.rPrecision)),
  // `--no-heldout` 下一律为 null 而不是 0：0 是一个会被误读成"读数"的值，而这里的
  // 事实是"本次运行没有测量它"。JSON 里的 null 也让 Codex 能直接验证纪律。
  heldoutQueries: noHeldout ? null : heldoutRows.length,
  heldoutHitAt5: noHeldout ? null : rate(heldoutRows.filter((r) => r.hitAt5).length, heldoutRows.length),
  heldoutMrr: noHeldout ? null : mean(heldoutRows.map((r) => r.reciprocalRank)),
  heldoutRPrecision: noHeldout ? null : mean(heldoutRows.map((r) => r.rPrecision)),
  /**
   * heldout 中 FTS 候选数为 0 的条数 —— **阶段 2 起的主口径**。
   *
   * 方案 §6.2 第 6 项要求换成这一列。理由是旧口径（`heldoutReturnedEmpty`）在拆门后
   * 会自动掉到 0，但那不是因为找回了锚点，而是因为"返回条数为 0"不再测量它名字所指
   * 的东西。FTS 候选数是纯输入侧读数，与 policy、floor、cap、融合全部无关，所以它在
   * 拆门前后可比。
   */
  heldoutNoAnchor: noHeldout ? null : heldoutRows.filter((r) => r.ftsCount === 0).length,
  /**
   * 旧口径，保留只为与阶段 0/1 的报告对齐：heldout 中最终返回条数为 0 的条数。
   *
   * `semanticDiscovery=false` 时两者必然相等（有 FTS 命中就一定会进 RRF、一定会返回）。
   * 拆门后它会分叉，届时它测的是"两路都没有候选"，不是"没有词汇锚点"。
   */
  heldoutReturnedEmpty: noHeldout ? null : heldoutRows.filter((r) => r.returned === 0).length,
  expectedEmptyQueries: expectedEmptyRows.length,
  /** expected-empty query 平均返回条数；理想为 0。 */
  expectedEmptyReturned: mean(expectedEmptyRows.map((r) => r.returned)),
  /** 返回最多的那条 expected-empty query，用于看最坏情况。 */
  expectedEmptyWorst: expectedEmptyRows.reduce((max, r) => Math.max(max, r.returned), 0),
  leakTotal: queryRows.reduce((s, r) => s + r.leaked.length, 0),
  degrades: queryRows.filter((r) => r.degraded).length,
  // --- 阶段 2 指标（方案 §6.2 第 7 项）---
  /** FTS 候选为 0 的 relevance query 数，跨 origin 汇总。 */
  zeroFtsRelevanceQueries: zeroFtsRelevanceRows.length,
  /** 同上子集的 hit@5 / MRR：拆门的主正面证据。discovery=off 时结构上恒为 0。 */
  zeroFtsHitAt5: rate(
    zeroFtsRelevanceRows.filter((r) => r.hitAt5).length,
    zeroFtsRelevanceRows.length,
  ),
  zeroFtsMrr: mean(zeroFtsRelevanceRows.map((r) => r.reciprocalRank)),
  /**
   * semantic-only 返回条数的**分布**，不只是总数。
   *
   * 总数会被均值掩盖：40 条 query 各返回 2 条与 4 条 query 各返回 20 条的
   * `semanticOnlyTotal` 一样，但后者是一次严重误召回。cap 要挡的是 max，不是 mean。
   */
  semanticOnlyMean: mean(queryRows.map((r) => r.semanticOnlyReturned)),
  semanticOnlyP95: pctOf(queryRows.map((r) => r.semanticOnlyReturned), 95),
  semanticOnlyMax: queryRows.reduce((m, r) => Math.max(m, r.semanticOnlyReturned), 0),
  /** 被 `semanticOnlyLimit` 丢弃的候选总数。默认 profile（无 cap）下恒为 0。 */
  semanticOnlyDroppedTotal: queryRows.reduce((s, r) => s + r.semanticOnlyDropped, 0),
  // --- 阶段 3A：bigram 辅助腿 ---
  //
  // `bigramOnlyMax` 与 semantic 那侧同理，是 cap 的结构不变量读数：它**必须**
  // ≤ min(bigramOnlyLimit, limit)，否则护栏没生效。
  bigramOnlyTotal: queryRows.reduce((s, r) => s + r.bigramOnlyReturned, 0),
  bigramOnlyMean: mean(queryRows.map((r) => r.bigramOnlyReturned)),
  bigramOnlyMax: queryRows.reduce((m, r) => Math.max(m, r.bigramOnlyReturned), 0),
  bigramOnlyDroppedTotal: queryRows.reduce((s, r) => s + r.bigramOnlyDropped, 0),
  /** 实际发出过辅助查询的 query 数。不含 CJK 的 query 恒不计入（中立性读数）。 */
  bigramProbedQueries: queryRows.filter((r) => r.bigramUnitsProbed > 0).length,
  /** 拿到过 bigram 候选的 query 数。 */
  bigramCandidateQueries: queryRows.filter((r) => r.bigramCount > 0).length,
  /** 被 DF 比例上限滤掉的两字词总数（跨 query 累计，含重复）。 */
  bigramUnitsDroppedTotal: queryRows.reduce((s, r) => s + r.bigramUnitsDropped.length, 0),
  // --- 阶段 3A-R2：投票范围与 fusion 分层 ---
  /** 因 `discovery-only` 抑制的 bigram 项总数。`always` 下恒为 0（构造保证）。 */
  bigramVotesSuppressedTotal: queryRows.reduce((s, r) => s + r.bigramVotesSuppressed, 0),
  /** fusion 集（62）整体与逐层。分层取自数据集冻结值，不按 arm 重算。 */
  fusionHitAt5: rate(
    fusionRows.filter((r) => r.kind === 'relevance' && r.hitAt5).length,
    fusionRows.filter((r) => r.kind === 'relevance').length,
  ),
  fusionMrr: mean(fusionRows.filter((r) => r.kind === 'relevance').map((r) => r.reciprocalRank)),
  fusionRPrecision: mean(fusionRows.filter((r) => r.kind === 'relevance').map((r) => r.rPrecision)),
  fusionByStratum: Object.fromEntries(
    ['S1', 'S2', 'S3', 'S4', 'S5'].map((st) => {
      const g = fusionByStratum(st);
      return [st, {
        n: g.length,
        hitAt5: rate(g.filter((r) => r.hitAt5).length, g.length),
        mrr: mean(g.map((r) => r.reciprocalRank)),
        rPrecision: mean(g.map((r) => r.rPrecision)),
        // S2/S5 的硬锁靠这一列做逐条比对（判据 §6.1）。
        resultIds: Object.fromEntries(g.map((r) => [r.id, r.resultIds])),
      }];
    }),
  ),
  /** S3 + S4 合计——S4 只有 7 条，判据 §4.3 禁止单独作结论。 */
  fusionS3S4HitAt5: (() => {
    const g = [...fusionByStratum('S3'), ...fusionByStratum('S4')];
    return rate(g.filter((r) => r.hitAt5).length, g.length);
  })(),
  /** empty-ext（32）：误召回主门槛。N3 层单列，它专门瞄准通用两字词噪声。 */
  emptyExtReturned: mean(emptyExtRows.map((r) => r.returned)),
  emptyExtWorst: emptyExtRows.reduce((m, r) => Math.max(m, r.returned), 0),
  emptyExtByLayer: Object.fromEntries(
    ['N1', 'N2', 'N3', 'N4'].map((l) => {
      const g = emptyExtByLayer(l);
      return [l, {
        n: g.length,
        mean: mean(g.map((r) => r.returned)),
        worst: g.reduce((m, r) => Math.max(m, r.returned), 0),
      }];
    }),
  ),
  // 精确平局（Gate D P2）：由内核实际融合分 `===` 分组得到，不是从权重扰动反推的。
  // `InPage` 才是有判别力的那个——页外深处的平局不影响任何指标。
  exactTieQueries: queryRows.filter((r) => r.exactTiePairs > 0).length,
  exactTieInPageQueries: queryRows.filter((r) => r.exactTieInPage).length,
  exactTiePairsTotal: queryRows.reduce((s, r) => s + r.exactTiePairs, 0),
  // --- discovery 协议边界观测（Gate A 整改）---
  /** 请求了 discovery 的 query 数。 */
  discoveryRequestedQueries: queryRows.filter((r) => r.discoveryRequested).length,
  /** discovery 真正生效的 query 数（请求了且在 semantic-en-v1 空间）。 */
  discoveryEffectiveQueries: queryRows.filter((r) => r.discoveryEffective).length,
  /**
   * 请求了但被协议边界挡住的 query 数。
   *
   * 这一列不为 0 就说明该 arm 里有 query 在 `raw-v1` 空间下被拒绝独立召回——那是
   * 正确行为（raw-v1 没有校准过的 floor），但它同时意味着 arm 的有效样本比声称的小。
   */
  discoveryBlockedByProtocol: queryRows.filter((r) => r.discoveryRequested && !r.discoveryEffective).length,
  /**
   * expected-empty 的**语义候选数**与返回数分开报。
   *
   * ⚠️ 实测读数：`semanticDiscovery=false` 时这一列恒为 **0**，而且它是结构恒真的。
   * 原因是关键词门在语义步骤之前返回，零词面的 empty query 压根没有候选被打过分——
   * 所以它**不能**用来在拆门前估计误召回压力（我起初就是这么写的，实测证伪）。
   * 要拿到那个先验，只能跑一个 `semanticDiscovery=true` 的诊断 arm。
   *
   * 保留这一列的意义在 2B：那时它与返回数的差就是 floor 和 cap 各自挡掉了多少。
   */
  expectedEmptySemanticCandidates: mean(expectedEmptyRows.map((r) => r.semanticCount)),
  expectedEmptySemanticCandidatesWorst: expectedEmptyRows.reduce(
    (m, r) => Math.max(m, r.semanticCount),
    0,
  ),
  // --- Phase 2 校准集（Gate A 冻结；`--phase2` 未开时全部为 0 条）---
  //
  // 方案 §7.4 的可行性门槛与 §7.5 的选择规则**只**读这一组。它与既有 tuned/heldout
  // 严格分桶，所以同一份报告里两组数字可以并列而不互相污染。
  phase2RelevanceQueries: phase2RelevanceRows.length,
  phase2HitAt5: rate(phase2RelevanceRows.filter((r) => r.hitAt5).length, phase2RelevanceRows.length),
  phase2Mrr: mean(phase2RelevanceRows.map((r) => r.reciprocalRank)),
  phase2RPrecision: mean(phase2RelevanceRows.map((r) => r.rPrecision)),
  /** 中英分层：英文 query 打中文语料是双语用户场景，与中文 query 测的不是同一件事。 */
  phase2ZhQueries: phase2RelevanceZhRows.length,
  phase2ZhHitAt5: rate(phase2RelevanceZhRows.filter((r) => r.hitAt5).length, phase2RelevanceZhRows.length),
  phase2ZhMrr: mean(phase2RelevanceZhRows.map((r) => r.reciprocalRank)),
  phase2EnQueries: phase2RelevanceEnRows.length,
  phase2EnHitAt5: rate(phase2RelevanceEnRows.filter((r) => r.hitAt5).length, phase2RelevanceEnRows.length),
  phase2EnMrr: mean(phase2RelevanceEnRows.map((r) => r.reciprocalRank)),
  /** Phase 2 empty：§7.4 的误召回约束（平均 ≤1、最坏 ≤3）。 */
  phase2EmptyQueries: phase2EmptyRows.length,
  phase2EmptyReturned: mean(phase2EmptyRows.map((r) => r.returned)),
  phase2EmptyWorst: phase2EmptyRows.reduce((m, r) => Math.max(m, r.returned), 0),
  phase2EmptyZhReturned: mean(phase2EmptyZhRows.map((r) => r.returned)),
  phase2EmptyEnReturned: mean(phase2EmptyEnRows.map((r) => r.returned)),
  /** hard-negative 与异域分开报：前者才是 floor/cap 的真正约束来源。 */
  phase2EmptySemanticCandidates: mean(phase2EmptyRows.map((r) => r.semanticCount)),
  phase2EmptySemanticCandidatesWorst: phase2EmptyRows.reduce((m, r) => Math.max(m, r.semanticCount), 0),
  /** semantic-only 返回总条数（阶段 2 的限额护栏要读它，现在恒为两路都命中之外的残量）。 */
  semanticOnlyTotal: queryRows.reduce((s, r) => s + r.semanticOnlyReturned, 0),
  latencyP50: pct(50),
  latencyP95: pct(95),
  // --- 协议指标（阶段 1b）---
  /** 配置的协议（自变量），与下面实际用到的协议分开报。 */
  protocol: protocolArg,
  /** 实际在 semantic-en-v1 空间里跑的 query 数。 */
  semanticEnQueries: queryRows.filter((r) => r.protocol === 'semantic-en-v1').length,
  /** 实际落回 raw-v1 的 query 数。arm B 里这应当为 0。 */
  rawProtocolQueries: queryRows.filter((r) => r.protocol === 'raw-v1').length,
  /** 英文形式被护栏拒绝的 query 数（含拒绝原因分布，见逐条明细）。 */
  semanticQueryRejects: queryRows.filter((r) => r.semanticQueryRejected != null).length,
  // --- 新增验证集（§5.6，只读一次，不设门槛）---
  validationQueries: validationRows.length,
  validationHitAt5: rate(validationRows.filter((r) => r.hitAt5).length, validationRows.length),
  validationMrr: mean(validationRows.map((r) => r.reciprocalRank)),
  validationRPrecision: mean(validationRows.map((r) => r.rPrecision)),
  validationZhHitAt5: rate(validationZhRows.filter((r) => r.hitAt5).length, validationZhRows.length),
  validationZhMrr: mean(validationZhRows.map((r) => r.reciprocalRank)),
  validationEnHitAt5: rate(validationEnRows.filter((r) => r.hitAt5).length, validationEnRows.length),
  validationEnMrr: mean(validationEnRows.map((r) => r.reciprocalRank)),
  /** 一个字面词都没命中的验证集条数——上限就是词汇锚点门，不是协议。 */
  validationZeroFtsAnchor: validationRows.filter((r) => r.ftsCount === 0).length,
};

// --- 协议侧的库内读数（阶段 1b）---
//
// 单独取一次 stats：检索指标看不见"有几条记录压根没有英文向量"，而那正是
// "英文归一化到底覆盖了多少语料"这个问题的答案。
const protocolStats = (() => {
  const s = db.getObservabilityStats();
  const en = s.embeddings.byProtocol.find((p) => p.protocol === 'semantic-en-v1');
  const raw = s.embeddings.byProtocol.find((p) => p.protocol === 'raw-v1');
  return {
    rawReady: raw?.ready ?? 0,
    rawCoverage: raw?.coverage ?? 0,
    semanticEnReady: en?.ready ?? 0,
    semanticEnCoverage: en?.coverage ?? 0,
    derived: s.embeddings.semanticEn,
  };
})();

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
 * 阶段 2C 之前它是结构恒真的：词汇锚点门在语义步骤之前，无关 query 的返回条数必然
 * 是 0。生产默认改成独立语义召回之后，这条读数第一次有了判别力——无关 query 会真的
 * 被语义打分，返回条数由 floor（0.197）和 semantic-only cap（2）决定。留 1.0 的余量
 * 是 2B 实测得到的：既有 5 条 expected-empty 在选中工作点上平均返回 1.00，没有安全
 * 余量，因此这条门槛在 2C 之后是**紧的**，不是形式化的。
 * 零锚点 + 全部低于 floor 必返回空这条硬不变量由单测钉住
 * （`tests/db/retrieval.test.ts`、`tests/integration/retrieval-policy.test.ts`）。
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
  // `--no-heldout` 时这两道门整个消失，而不是判为通过或失败：本次运行没有测量它，
  // 报告不该对它有任何结论。
  ...(noHeldout ? [] : [
    { kind: 'discriminating' as const, name: `Top-5 至少一条标注命中（heldout ${retrievalMetrics.heldoutQueries} 条；泛化读数，≥${pctStr(HELDOUT_HIT5_FLOOR)} 为不回退锁）`, value: pctStr(retrievalMetrics.heldoutHitAt5!), ok: retrievalMetrics.heldoutHitAt5! >= HELDOUT_HIT5_FLOOR },
    { kind: 'discriminating' as const, name: `R-precision（heldout；≥${pctStr(HELDOUT_R_PRECISION_FLOOR)} 为不回退锁）`, value: pctStr(retrievalMetrics.heldoutRPrecision!), ok: retrievalMetrics.heldoutRPrecision! >= HELDOUT_R_PRECISION_FLOOR },
  ]),
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

// 阶段 1b 的协议门槛。只在 arm B 有意义——在 arm A 下它们全部恒真，列出来只会
// 让"全部通过"看起来更厚。
if (useSemanticEn) {
  gates.push(
    {
      kind: 'discriminating',
      name: `英文派生值 ready 覆盖（${protocolStats.derived.ready}/${turns.length}，pending ${protocolStats.derived.pending} / failed ${protocolStats.derived.failed}）`,
      value: fmt(protocolStats.semanticEnCoverage, 2),
      ok: protocolStats.semanticEnCoverage === 1,
    },
    {
      // §5.5 协议门槛：非法/缺失派生值进入 semantic-en-v1 向量表 = 0 条。
      // 等价可测形式：该空间的向量条数正好等于 ready 的派生值条数。
      kind: 'structural',
      name: 'semantic-en-v1 向量数 == ready 派生值数（非法值入表为 0）',
      value: `${protocolStats.semanticEnReady} == ${protocolStats.derived.ready}`,
      ok: protocolStats.semanticEnReady === protocolStats.derived.ready,
    },
    {
      kind: 'discriminating',
      name: `query 侧协议一致（${retrievalMetrics.semanticEnQueries}/${queryRows.length} 走 semantic-en-v1，护栏拒绝 ${retrievalMetrics.semanticQueryRejects}）`,
      value: String(retrievalMetrics.rawProtocolQueries),
      ok: retrievalMetrics.rawProtocolQueries === 0 && retrievalMetrics.semanticQueryRejects === 0,
    },
    {
      // 迁移期的硬约束：raw 那条腿必须继续存在，否则调用方一旦不给英文形式就
      // 只剩 FTS，而这不是"降级"，是把功能删了。
      kind: 'structural',
      name: 'raw-v1 腿仍然完整（降级路径可用）',
      value: fmt(protocolStats.rawCoverage, 2),
      ok: protocolStats.rawCoverage === 1,
    },
  );
}
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
lines.push(`| 脚本 run.ts / scoring.ts / dataset.ts | \`${provenance.runHash}\` / \`${provenance.scoringHash}\` / \`${provenance.datasetHash}\` |`);
lines.push(`| embedding 模型 | ${enableEmbeddings ? `${EMBEDDING_MODEL} (${DIMENSIONS}d)` : '关闭'} |`);
lines.push(`| 归一化协议 | \`${protocolArg}\`${useSemanticEn ? '（双侧英文归一化，arm B）' : '（原文直接向量化，对照组 A）'} |`);
if (enFixture) {
  lines.push(
    `| 英文固定输入 | ${enFixture.sources.map((s) => `\`${s}\``).join(' + ')}（记录 ${Object.keys(enFixture.records).length} / query ${Object.keys(enFixture.queries).length}，由生产 ACP 产出） |`,
  );
}
lines.push(`| 运行环境 | Bun ${provenance.bunVersion} / ${provenance.platform} ${provenance.arch} |`);
lines.push(`| 运行次数 | 1（多次运行与方差见 \`--runs=N\`） |`);
// 检索策略必须在 provenance 表里，而不只在正文某处提一句：阶段 2B 的 12 个 arm
// 只差这几个数字，读者要能在报告最上方就确定这份读数属于哪个 arm。
lines.push(
  `| 检索策略 | discovery=\`${resolvedPolicy.semanticDiscovery ? 'on' : 'off'}\`` +
    ` floor=\`${resolvedPolicy.semanticFloor}\`` +
    ` semanticOnlyLimit=\`${policyForReport.semanticOnlyLimit}\`` +
    ` rrfK=\`${resolvedPolicy.rrfK}\`` +
    ` w(fts:sem)=\`${resolvedPolicy.ftsWeight}:${resolvedPolicy.semanticWeight}\`` +
    ` tieBreak=\`${resolvedPolicy.tieBreak}\` |`,
);
lines.push(
  `| 策略注入自检 | ${queryRows.length} / ${queryRows.length} 条 query 上报的 policy 与上表一致（不一致即退出） |`,
);
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
    lines.push(`- **heldout**（18 条）：后补且未据此改任何检索参数。实测 hit@5 ${noHeldout ? '未测量（--no-heldout）' : pctStr(retrievalMetrics.heldoutHitAt5!)}，`);
    lines.push('  与 tuned 差了约 50 个百分点——**这是当前最实质的检索缺口**，也把"存在过拟合');
    lines.push('  风险"变成了实测事实。它的门槛同样是不回退锁，锁在一个很差的水平上。');
    lines.push('');
    lines.push('R-precision 与 expected-empty 是**误召回**侧指标——只测 hit@k 只能证明');
    lines.push('"没漏"，证明不了"没乱给"。两者的性质不同：');
    lines.push('');
    lines.push('- R-precision 的阈值是"不回退锁"，不是质量目标：实测远低于 hit@5，说明正确答案');
    lines.push('  通常进了 Top-5 但常常不在第 1 位，排序还有明显空间。');
    lines.push(`- expected-empty 的阈值就是目标值（${EXPECTED_EMPTY_TARGET}）。它读什么取决于本次运行的 policy：`);
    lines.push('  discovery 关闭时，本 scope 的 FTS 无命中即返回空，于是无关 query 在**结构上**返回 0 条，');
    lines.push('  这只是连续性读数；discovery 生效时，无关 query 会真的被语义打分，这时它才是');
    lines.push('  floor 与 semantic-only cap 在控制误召回的证据。');
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
lines.push(`| └ hit@5（heldout ${noHeldout ? '未测量' : `${retrievalMetrics.heldoutQueries} 条，未据此调参`}） | ${noHeldout ? '未测量（--no-heldout）' : `**${pctStr(retrievalMetrics.heldoutHitAt5!)}**`} |`);
lines.push(`| hit@10 | ${pctStr(retrievalMetrics.hitAt10)} |`);
lines.push(`| MRR@10 | ${fmt(retrievalMetrics.mrr)} |`);
lines.push(`| ├ MRR@10（tuned；排序敏感，阶段 1 主读数） | ${fmt(retrievalMetrics.tunedMrr)} |`);
lines.push(`| └ MRR@10（heldout；排序敏感，泛化读数） | ${retrievalMetrics.heldoutMrr === null ? '未测量（--no-heldout）' : fmt(retrievalMetrics.heldoutMrr)} |`);
lines.push(`| recall@10 | ${pctStr(retrievalMetrics.recallAt10)} |`);
lines.push(`| R-precision（下界） | ${pctStr(retrievalMetrics.rPrecision)} |`);
lines.push(`| ├ R-precision（tuned） | ${pctStr(retrievalMetrics.tunedRPrecision)} |`);
lines.push(`| └ R-precision（heldout） | ${retrievalMetrics.heldoutRPrecision === null ? '未测量（--no-heldout）' : pctStr(retrievalMetrics.heldoutRPrecision)} |`);
lines.push(`| heldout 中零词汇锚点条数（FTS 候选=0，**主口径**） | ${noHeldout ? '未测量（--no-heldout）' : `${retrievalMetrics.heldoutNoAnchor} / ${retrievalMetrics.heldoutQueries}`} |`);
lines.push(`| └ 旧口径：最终返回条数为 0（拆门后会分叉） | ${noHeldout ? '未测量（--no-heldout）' : `${retrievalMetrics.heldoutReturnedEmpty} / ${retrievalMetrics.heldoutQueries}`} |`);
lines.push(`| zero-FTS relevance（跨 origin 汇总） | ${retrievalMetrics.zeroFtsRelevanceQueries} 条 |`);
lines.push(`| ├ zero-FTS hit@5 | ${pctStr(retrievalMetrics.zeroFtsHitAt5)}${resolvedPolicy.semanticDiscovery ? '' : '（discovery=off，结构上恒为 0）'} |`);
lines.push(`| └ zero-FTS MRR | ${fmt(retrievalMetrics.zeroFtsMrr, 3)}${resolvedPolicy.semanticDiscovery ? '' : '（同上）'} |`);
lines.push(`| expected-empty query 平均返回（${retrievalMetrics.expectedEmptyQueries} 条） | ${fmt(retrievalMetrics.expectedEmptyReturned, 2)}（最坏 ${retrievalMetrics.expectedEmptyWorst}） |`);
lines.push(`| └ 同上的语义候选数（越过 floor，拆门前的误召回压力） | 平均 ${fmt(retrievalMetrics.expectedEmptySemanticCandidates, 2)}（最坏 ${retrievalMetrics.expectedEmptySemanticCandidatesWorst}） |`);
lines.push(`| semantic-only 返回分布 | 总 ${retrievalMetrics.semanticOnlyTotal} / 均值 ${fmt(retrievalMetrics.semanticOnlyMean, 2)} / p95 ${retrievalMetrics.semanticOnlyP95} / max ${retrievalMetrics.semanticOnlyMax} |`);
lines.push(`| └ 被 cap 丢弃 | ${retrievalMetrics.semanticOnlyDroppedTotal}（cap=${policyForReport.semanticOnlyLimit}） |`);
lines.push(`| discovery 请求 / 生效 / 被协议边界挡住 | ${retrievalMetrics.discoveryRequestedQueries} / ${retrievalMetrics.discoveryEffectiveQueries} / ${retrievalMetrics.discoveryBlockedByProtocol} |`);
if (withPhase2) {
  lines.push('');
  lines.push('### Phase 2 校准集（Gate A 冻结，全部 `ftsCount = 0`）');
  lines.push('');
  lines.push('> 这一组是方案 §7.4 可行性门槛与 §7.5 选择规则的**唯一**输入。它与上面的');
  lines.push('> tuned / heldout 严格分桶：既有样本不进这组指标，这组样本也不进既有指标。');
  lines.push('> 它是校准集，不是泛化证据——见 `phase2-calibration-set.md` §0。');
  lines.push('');
  lines.push('| 指标 | 值 | §7.4 门槛 |');
  lines.push('| --- | ---: | --- |');
  lines.push(`| relevance 条数 | ${retrievalMetrics.phase2RelevanceQueries} | — |`);
  lines.push(`| hit@5 | ${pctStr(retrievalMetrics.phase2HitAt5)} | 高于关键词门基线 |`);
  lines.push(`| MRR | ${fmt(retrievalMetrics.phase2Mrr, 3)} | 高于关键词门基线 |`);
  lines.push(`| R-precision | ${pctStr(retrievalMetrics.phase2RPrecision)} | — |`);
  lines.push(`| ├ 中文 hit@5 / MRR（${retrievalMetrics.phase2ZhQueries} 条） | ${pctStr(retrievalMetrics.phase2ZhHitAt5)} / ${fmt(retrievalMetrics.phase2ZhMrr, 3)} | 分层读数 |`);
  lines.push(`| └ 英文 hit@5 / MRR（${retrievalMetrics.phase2EnQueries} 条） | ${pctStr(retrievalMetrics.phase2EnHitAt5)} / ${fmt(retrievalMetrics.phase2EnMrr, 3)} | 分层读数 |`);
  lines.push(`| empty 条数 | ${retrievalMetrics.phase2EmptyQueries} | — |`);
  lines.push(`| empty 平均返回 | ${fmt(retrievalMetrics.phase2EmptyReturned, 2)} | ≤ 1 |`);
  lines.push(`| empty 最坏返回 | ${retrievalMetrics.phase2EmptyWorst} | ≤ 3 |`);
  lines.push(`| ├ 中文 empty 平均 | ${fmt(retrievalMetrics.phase2EmptyZhReturned, 2)} | 分层读数 |`);
  lines.push(`| └ 英文 empty 平均 | ${fmt(retrievalMetrics.phase2EmptyEnReturned, 2)} | 分层读数 |`);
  lines.push(`| empty 语义候选数 | 平均 ${fmt(retrievalMetrics.phase2EmptySemanticCandidates, 2)}（最坏 ${retrievalMetrics.phase2EmptySemanticCandidatesWorst}） | — |`);
  if (!resolvedPolicy.semanticDiscovery) {
    lines.push('');
    lines.push('⚠️ 本次运行 `semanticDiscovery=off`，所以 relevance 侧 hit@5 与 MRR **结构上恒为 0**');
    lines.push('（这 121 条全部 `ftsCount = 0`，在 embedding 之前就返回了），empty 侧的返回数与语义');
    lines.push('候选数同样恒为 0。这是关键词门基线读数，不是模型能力读数。');
  }
}
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
lines.push('### 逐 query 分路明细（§4.4）');
lines.push('');
lines.push('一次 miss 有四种成因，在上面那张表里长得一模一样：FTS 没召回 / 语义没召回 /');
lines.push('两路都召回但 RRF 排坏 / 被结果上限截掉。这张表把它们拆开。`ftsRank`、');
lines.push('`semRank` 是期望记录在**各自那一路的候选名次表**里的位次，0 = 没进该路。');
lines.push('');
lines.push('| query | 类型 | 协议 | fts候选 | 语义候选 | 返回 | 仅语义 | ftsRank | semRank | 最终名次 | 降级 |');
lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const r of queryRows) {
  const rank0 = (n: number) => (n > 0 ? String(n) : '—');
  const proto = r.protocol === 'semantic-en-v1' ? 'en' : 'raw';
  lines.push(
    `| ${r.id} | ${r.kind}${r.origin ? `/${r.origin}` : ''} | ${proto}${r.semanticQueryRejected ? `(拒:${r.semanticQueryRejected})` : ''} | ${r.ftsCount} | ${r.semanticCount} | ${r.returned} | ${r.semanticOnlyReturned} | ${rank0(r.ftsRank)} | ${rank0(r.semanticRank)} | ${rank0(r.firstExpectedRank)} | ${r.degraded ? '是' : '否'} |`,
  );
}
lines.push('');
if (validationRows.length) {
  lines.push('## 新增验证集（§5.6，只读一次，不设门槛）');
  lines.push('');
  lines.push(`共 ${validationRows.length} 条（中文 ${validationZhRows.length} / 英文 ${validationEnRows.length}），`);
  lines.push('在实现冻结之后才标注，未参与协议选择、prompt 调整、护栏规则或 floor 取值。');
  lines.push('');
  lines.push('**诚实边界**：它由实现者本人依据 `turns.json` 的标注写成，写的时候已经看过');
  lines.push('tuned / heldout 的结果，所以它弱于独立第三方标注。它唯一强的地方是：这些具体');
  lines.push('问法从未参与任何选择。引用它时必须带上这句限定。');
  lines.push('');
  lines.push('| 子集 | 条数 | hit@5 | MRR | R-precision |');
  lines.push('| --- | --- | --- | --- | --- |');
  lines.push(`| 全部 | ${validationRows.length} | ${pctStr(retrievalMetrics.validationHitAt5)} | ${fmt(retrievalMetrics.validationMrr)} | ${pctStr(retrievalMetrics.validationRPrecision)} |`);
  lines.push(`| 中文 | ${validationZhRows.length} | ${pctStr(retrievalMetrics.validationZhHitAt5)} | ${fmt(retrievalMetrics.validationZhMrr)} | — |`);
  lines.push(`| 英文 | ${validationEnRows.length} | ${pctStr(retrievalMetrics.validationEnHitAt5)} | ${fmt(retrievalMetrics.validationEnMrr)} | — |`);
  lines.push('');
  lines.push(`其中 ${retrievalMetrics.validationZeroFtsAnchor} 条一个字面词都没命中（FTS 候选为 0）。`);
  lines.push('这批 query 的上限由词汇锚点门决定，不由归一化协议决定——门在阶段 2 才拆。');
  lines.push('');
}
lines.push('## 协议明细（阶段 1b）');
lines.push('| 项 | 值 |');
lines.push('| --- | --- |');
lines.push(`| 配置协议 | \`${protocolArg}\` |`);
lines.push(`| raw-v1 向量覆盖 | ${protocolStats.rawReady}/${turns.length}（${fmt(protocolStats.rawCoverage, 2)}） |`);
lines.push(`| semantic-en-v1 向量覆盖 | ${protocolStats.semanticEnReady}/${turns.length}（${fmt(protocolStats.semanticEnCoverage, 2)}） |`);
lines.push(`| 英文派生值 ready / pending / failed | ${protocolStats.derived.ready} / ${protocolStats.derived.pending} / ${protocolStats.derived.failed} |`);
lines.push(`| query 走 semantic-en-v1 / raw-v1 | ${retrievalMetrics.semanticEnQueries} / ${retrievalMetrics.rawProtocolQueries} |`);
lines.push(`| 英文形式被护栏拒绝 | ${retrievalMetrics.semanticQueryRejects} |`);
lines.push('');
lines.push('两个空间同时存在且互不排序：读取时按 `model:dtype:dims:protocol` 过滤，所以');
lines.push('`raw-v1` 与 `semantic-en-v1` 虽同为 384 维同一模型，也不会被放进同一次 cosine');
lines.push('比较。arm B 里 raw 那条腿仍然建满，是为了让"调用方没给英文形式"时有降级路径，');
lines.push('而不是只剩 FTS。');
lines.push('');
lines.push('## 复现');
lines.push('');
lines.push('```bash');
lines.push(`bun run benchmark/run.ts --compressor=${compressorKind} --protocol=${protocolArg}${enableEmbeddings ? '' : ' --no-embeddings'}`);
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
    JSON.stringify(
      {
        provenance,
        compressorKind,
        protocol: protocolArg,
        enableEmbeddings,
        summaryMetrics,
        retrievalMetrics,
        protocolStats,
        // ACP 模式下这两组是本阶段唯一能回答"压缩 prompt 变长有没有代价"的读数：
        // repair 次数上升 = 输出变长后 JSON 更容易坏；派生值 ready 率 = 生产形态下
        // 记录侧英文归一化的首轮成功率。gold 模式下它们恒定，没有信息。
        compressorStats,
        queryRows,
        allGatesOk,
        // 逐条门槛落盘（3A 新增）。此前 JSON 里只有 `allGatesOk` 这个布尔值，于是
        // 「哪一条没过」只存在于 Markdown 与 stdout 里——一个上层驱动想把「门槛未达标」
        // 记成 arm 的结果就只能重新实现一遍判定，那是第二个事实来源。
        gates: gates.map((g) => ({ kind: g.kind, name: g.name, value: g.value, ok: g.ok })),
      },
      null,
      2,
    ),
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
