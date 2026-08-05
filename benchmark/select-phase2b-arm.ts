/**
 * 阶段 2B 的确定性 arm 选择器（方案 §7.4 可行性门槛 + §7.5 选择规则）。
 *
 * ## 为什么必须是脚本
 *
 * 方案 §7.8 要求"策略选择的确定性计算脚本，不能手工抄表选择"。理由不是懒：手工从
 * 12 份报告里挑一个，等于让"选择规则"在看完数字之后才最终成形，而那正是 §14.3
 * 「先写门槛再跑候选」要排除的东西。这个文件在**任何 arm 运行之前**写完并冻结，
 * 它的 checksum 会进矩阵报告的 provenance。
 *
 * ## 它只读什么
 *
 * 每个 arm 的机器可读 JSON 里，只读两组字段：
 *
 *   - `phase2*`  —— Gate A 冻结的 121 条校准集。选参的**唯一**依据。
 *   - `tuned*` / `expectedEmpty*` / 结构与性能字段 —— 历史连续性锁与硬门。
 *
 * 它**不读** `heldout*` 与 `validation*`。矩阵 arm 用 `--no-heldout` 跑，那些字段
 * 在 JSON 里是 `null` 或不存在；就算存在，这里也不会去看（见 `FORBIDDEN_FIELDS`
 * 的运行时断言）。
 *
 * ## 用法
 *
 *   bun run benchmark/select-phase2b-arm.ts \
 *     --baseline=benchmark/reports/phase2b-baseline.json \
 *     --arms=benchmark/reports/phase2b-arm-*.json \
 *     --report=benchmark/reports/phase2b-selection.md
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { glob } from 'fs/promises';

const args = process.argv.slice(2);
function flag(name: string, fallback?: string): string | undefined {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

// ---------------------------------------------------------------------------
// §7.4 可行性门槛 —— 在任何 arm 运行之前写死
// ---------------------------------------------------------------------------
//
// 数值直接来自方案 §7.4 那张表，逐行对应。不在这里"留一点余量"：门槛就是门槛，
// 事后放宽等于没有门槛。

/** 既有 tuned 的三项连续性锁（Phase 1b 实测值，不得回退）。 */
const TUNED_HIT5_MIN = 0.944;
const TUNED_MRR_MIN = 0.833;
const TUNED_RPRECISION_MIN = 0.778;
/** Phase 2 empty 的误召回约束。 */
const PHASE2_EMPTY_MEAN_MAX = 1;
const PHASE2_EMPTY_WORST_MAX = 3;
/** 既有 expected-empty 的历史口径连续性。 */
const LEGACY_EMPTY_MEAN_MAX = 1;
const LEGACY_EMPTY_WORST_MAX = 3;
/** 性能门。 */
const P95_MAX_MS = 300;
/** benchmark 的 `limit`（run.ts 固定传 10），用于 cap 不变量的上界。 */
const REQUEST_LIMIT = 10;

/**
 * 「一条 query 的分辨力」——§7.5 第 2 步用它判断两个 arm 的 hit@5 是否可区分。
 *
 * Phase 2 relevance 共 121 条里的 72 条，所以一条 query 值 1/72。差值**小于**这个数
 * 就认为 hit@5 分不出高下，进入下一顺位。写成从 JSON 里读的条数而不是硬编码 72，
 * 这样万一集合规模变了，判据跟着变而不是悄悄失效。
 */
const resolutionOf = (n: number) => (n > 0 ? 1 / n : 0);

// ---------------------------------------------------------------------------
// 读入
// ---------------------------------------------------------------------------

interface ArmMetrics {
  label: string;
  path: string;
  floor: number;
  cap: number | 'inf';
  discovery: boolean;
  rrfK: number;
  weights: string;
  tieBreak: string;
  // Phase 2 校准集
  phase2Relevance: number;
  phase2HitAt5: number;
  phase2Mrr: number;
  phase2RPrecision: number;
  phase2EmptyQueries: number;
  phase2EmptyReturned: number;
  phase2EmptyWorst: number;
  // 连续性锁
  tunedHitAt5: number;
  tunedMrr: number;
  tunedRPrecision: number;
  legacyEmptyReturned: number;
  legacyEmptyWorst: number;
  // 结构与性能
  semanticOnlyMax: number;
  leakTotal: number;
  rawProtocolQueries: number;
  latencyP95: number;
  discoveryRequested: number;
  discoveryEffective: number;
  discoveryBlocked: number;
}

function load(path: string): ArmMetrics {
  const raw = readFileSync(path, 'utf-8');
  const j = JSON.parse(raw) as Record<string, any>;
  const m = j.retrievalMetrics as Record<string, any>;
  const p = j.provenance?.retrievalPolicy as Record<string, any>;
  if (!m || !p) throw new Error(`${path}: 缺 retrievalMetrics 或 provenance.retrievalPolicy`);

  // 纪律断言：矩阵 arm 不得携带确认集读数。
  //
  // 两组的判据不同，因为两者"未被使用"的表现不同：
  //   - heldout 用 `--no-heldout` 从数据集里移除，所以 `heldout*` 必须是 **null**。
  //     值为 0 反而可疑：那说明 heldout 行还在，只是全都没命中。
  //   - validation 靠"不传 `--validation`"来排除，此时它的条数是 **0**，其余
  //     validation 指标是 0 而不是 null。所以这里判条数，不判 null。
  if (m.heldoutQueries !== null) {
    throw new Error(
      `${path}: heldoutQueries=${m.heldoutQueries}（应为 null）。矩阵 arm 必须用 --no-heldout 跑（方案 §7.3）`,
    );
  }
  if (Number(m.validationQueries ?? 0) > 0) {
    throw new Error(
      `${path}: validationQueries=${m.validationQueries}。矩阵 arm 不得加 --validation（方案 §7.3）`,
    );
  }

  return {
    label: `floor=${p.semanticFloor} cap=${p.semanticOnlyLimit}`,
    path,
    floor: Number(p.semanticFloor),
    cap: p.semanticOnlyLimit === 'inf' ? 'inf' : Number(p.semanticOnlyLimit),
    discovery: Boolean(p.semanticDiscovery),
    rrfK: Number(p.rrfK),
    weights: `${p.ftsWeight}:${p.semanticWeight}`,
    tieBreak: String(p.tieBreak),
    phase2Relevance: Number(m.phase2RelevanceQueries ?? 0),
    phase2HitAt5: Number(m.phase2HitAt5 ?? 0),
    phase2Mrr: Number(m.phase2Mrr ?? 0),
    phase2RPrecision: Number(m.phase2RPrecision ?? 0),
    phase2EmptyQueries: Number(m.phase2EmptyQueries ?? 0),
    phase2EmptyReturned: Number(m.phase2EmptyReturned ?? 0),
    phase2EmptyWorst: Number(m.phase2EmptyWorst ?? 0),
    tunedHitAt5: Number(m.tunedHitAt5),
    tunedMrr: Number(m.tunedMrr),
    tunedRPrecision: Number(m.tunedRPrecision),
    legacyEmptyReturned: Number(m.expectedEmptyReturned),
    legacyEmptyWorst: Number(m.expectedEmptyWorst),
    semanticOnlyMax: Number(m.semanticOnlyMax),
    leakTotal: Number(m.leakTotal),
    rawProtocolQueries: Number(m.rawProtocolQueries),
    latencyP95: Number(m.latencyP95),
    discoveryRequested: Number(m.discoveryRequestedQueries ?? 0),
    discoveryEffective: Number(m.discoveryEffectiveQueries ?? 0),
    discoveryBlocked: Number(m.discoveryBlockedByProtocol ?? 0),
  };
}

// ---------------------------------------------------------------------------
// §7.4 可行性判定
// ---------------------------------------------------------------------------

interface Check { name: string; ok: boolean; detail: string }

function feasibility(a: ArmMetrics, baseline: ArmMetrics): Check[] {
  const capBound = a.cap === 'inf' ? REQUEST_LIMIT : Math.min(a.cap, REQUEST_LIMIT);
  return [
    { name: '既有 tuned hit@5 ≥ 94.4%', ok: a.tunedHitAt5 >= TUNED_HIT5_MIN - 1e-9,
      detail: `${(a.tunedHitAt5 * 100).toFixed(1)}%` },
    { name: '既有 tuned MRR ≥ 0.833', ok: a.tunedMrr >= TUNED_MRR_MIN - 1e-9,
      detail: a.tunedMrr.toFixed(3) },
    { name: '既有 tuned R-precision ≥ 77.8%', ok: a.tunedRPrecision >= TUNED_RPRECISION_MIN - 1e-9,
      detail: `${(a.tunedRPrecision * 100).toFixed(1)}%` },
    { name: 'Phase 2 zero-FTS hit@5 高于基线', ok: a.phase2HitAt5 > baseline.phase2HitAt5,
      detail: `${(a.phase2HitAt5 * 100).toFixed(1)}% vs 基线 ${(baseline.phase2HitAt5 * 100).toFixed(1)}%` },
    { name: 'Phase 2 zero-FTS MRR 高于基线', ok: a.phase2Mrr > baseline.phase2Mrr,
      detail: `${a.phase2Mrr.toFixed(3)} vs 基线 ${baseline.phase2Mrr.toFixed(3)}` },
    { name: 'Phase 2 empty 平均返回 ≤ 1', ok: a.phase2EmptyReturned <= PHASE2_EMPTY_MEAN_MAX + 1e-9,
      detail: a.phase2EmptyReturned.toFixed(2) },
    { name: 'Phase 2 empty 最坏返回 ≤ 3', ok: a.phase2EmptyWorst <= PHASE2_EMPTY_WORST_MAX,
      detail: String(a.phase2EmptyWorst) },
    { name: '既有 expected-empty 平均 ≤ 1', ok: a.legacyEmptyReturned <= LEGACY_EMPTY_MEAN_MAX + 1e-9,
      detail: a.legacyEmptyReturned.toFixed(2) },
    { name: '既有 expected-empty 最坏 ≤ 3', ok: a.legacyEmptyWorst <= LEGACY_EMPTY_WORST_MAX,
      detail: String(a.legacyEmptyWorst) },
    { name: 'semantic-only ≤ min(cap, limit)', ok: a.semanticOnlyMax <= capBound,
      detail: `max ${a.semanticOnlyMax} ≤ ${capBound}` },
    { name: '跨 scope 泄漏 = 0', ok: a.leakTotal === 0, detail: String(a.leakTotal) },
    { name: 'protocol 混排 = 0（raw 腿 0 条）', ok: a.rawProtocolQueries === 0,
      detail: `raw ${a.rawProtocolQueries}` },
    { name: 'search p95 < 300ms', ok: a.latencyP95 < P95_MAX_MS,
      detail: `${a.latencyP95.toFixed(1)}ms` },
  ];
}

// ---------------------------------------------------------------------------
// §7.5 选择规则（顺序固定，不允许事后解释）
// ---------------------------------------------------------------------------

/**
 * 返回排序后的可行 arm。第一个就是选中的。
 *
 * 顺位：
 *   1. Phase 2 hit@5 更高；
 *   2. 差值 < 一条 query 的分辨力时，Phase 2 MRR 更高；
 *   3. 仍不可区分时，Phase 2 empty 平均返回更低；
 *   4. 再相同，cap 更小；
 *   5. 再相同，floor 更高。
 *
 * 第 2 步的"不可区分"用**分辨力**判断而不是精确相等：hit@5 是阶跃函数，两个 arm 差
 * 半条 query 是不可能的，但浮点表示可能让 24/72 与 24/72 算出不同的尾数。
 */
function rank(feasible: ArmMetrics[], resolution: number): ArmMetrics[] {
  return [...feasible].sort((a, b) => {
    const dHit = b.phase2HitAt5 - a.phase2HitAt5;
    if (Math.abs(dHit) >= resolution - 1e-12) return dHit > 0 ? 1 : -1;
    if (Math.abs(b.phase2Mrr - a.phase2Mrr) > 1e-9) return b.phase2Mrr - a.phase2Mrr;
    if (Math.abs(a.phase2EmptyReturned - b.phase2EmptyReturned) > 1e-9) {
      return a.phase2EmptyReturned - b.phase2EmptyReturned;
    }
    const ca = a.cap === 'inf' ? Number.POSITIVE_INFINITY : a.cap;
    const cb = b.cap === 'inf' ? Number.POSITIVE_INFINITY : b.cap;
    if (ca !== cb) return ca - cb;
    return b.floor - a.floor;
  });
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const baselinePath = flag('baseline');
if (!baselinePath) {
  console.error('必须传 --baseline=<关键词门基线的 JSON>');
  process.exit(2);
}
const armPatterns = (flag('arms', '') || '').split(',').map((x) => x.trim()).filter(Boolean);
if (!armPatterns.length) {
  console.error('必须传 --arms=<glob 或逗号分隔的 JSON 路径>');
  process.exit(2);
}

const armPaths: string[] = [];
for (const pattern of armPatterns) {
  if (pattern.includes('*')) {
    for await (const p of glob(pattern)) armPaths.push(resolve(p));
  } else {
    armPaths.push(resolve(pattern));
  }
}
armPaths.sort();

const baseline = load(resolve(baselinePath));
if (baseline.discovery) {
  console.error(`基线必须是关键词门（discovery=off），但 ${baselinePath} 的 discovery=on`);
  process.exit(2);
}
const arms = armPaths.map(load);
for (const a of arms) {
  if (!a.discovery) {
    console.error(`${a.path}: arm 必须 discovery=on`);
    process.exit(2);
  }
}

// §7.1 固定项自检：本轮只允许 floor 与 cap 变动。
const fixedViolations: string[] = [];
for (const a of arms) {
  if (a.rrfK !== 60) fixedViolations.push(`${a.label}: rrfK=${a.rrfK}，§7.1 固定为 60`);
  if (a.weights !== '1:1') fixedViolations.push(`${a.label}: 权重=${a.weights}，§7.1 固定为 1:1`);
  if (a.tieBreak !== 'recency') fixedViolations.push(`${a.label}: tieBreak=${a.tieBreak}，§7.1 固定不变`);
}
if (fixedViolations.length) {
  console.error('§7.1 要求本阶段只变 floor 与 cap：');
  for (const v of fixedViolations) console.error(`  ${v}`);
  process.exit(2);
}

const resolution = resolutionOf(baseline.phase2Relevance || arms[0]?.phase2Relevance || 0);
const evaluated = arms.map((a) => ({ arm: a, checks: feasibility(a, baseline) }));
const feasible = evaluated.filter((e) => e.checks.every((c) => c.ok)).map((e) => e.arm);
const ranked = rank(feasible, resolution);
const winner = ranked[0] ?? null;

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const capStr = (c: number | 'inf') => String(c);

const lines: string[] = [
  '# 阶段 2B arm 选择（确定性计算）',
  '',
  `> 生成时间：${new Date().toISOString()}`,
  `> 基线：\`${baselinePath}\``,
  `> arm 数：${arms.length}`,
  `> 一条 query 的分辨力：1/${baseline.phase2Relevance} = ${resolution.toFixed(5)}`,
  '',
  '判据与顺位在任何 arm 运行之前写死于本脚本（方案 §7.4 / §7.5），选择过程不含人工判断。',
  '本脚本不读取 `heldout*` 与 `validation*`；矩阵 arm 用 `--no-heldout` 跑，读到非 null 的',
  '确认集指标会直接报错退出。',
  '',
  '## 关键词门基线',
  '',
  '| 指标 | 值 |',
  '| --- | ---: |',
  `| Phase 2 relevance 条数 | ${baseline.phase2Relevance} |`,
  `| Phase 2 hit@5 | ${pct(baseline.phase2HitAt5)} |`,
  `| Phase 2 MRR | ${baseline.phase2Mrr.toFixed(3)} |`,
  `| Phase 2 empty 平均 / 最坏 | ${baseline.phase2EmptyReturned.toFixed(2)} / ${baseline.phase2EmptyWorst} |`,
  `| 既有 tuned hit@5 / MRR / R-prec | ${pct(baseline.tunedHitAt5)} / ${baseline.tunedMrr.toFixed(3)} / ${pct(baseline.tunedRPrecision)} |`,
  '',
  '## 全部 arm（含失败项与失败原因）',
  '',
  '| arm | Phase2 hit@5 | Phase2 MRR | empty 均/坏 | tuned hit@5/MRR/R | semOnly max | p95 | 可行 | 失败原因 |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | :--: | --- |',
];

for (const { arm, checks } of evaluated) {
  const failed = checks.filter((c) => !c.ok);
  lines.push(
    `| ${arm.label} | ${pct(arm.phase2HitAt5)} | ${arm.phase2Mrr.toFixed(3)} | ` +
      `${arm.phase2EmptyReturned.toFixed(2)}/${arm.phase2EmptyWorst} | ` +
      `${pct(arm.tunedHitAt5)}/${arm.tunedMrr.toFixed(3)}/${pct(arm.tunedRPrecision)} | ` +
      `${arm.semanticOnlyMax} | ${arm.latencyP95.toFixed(1)}ms | ${failed.length ? '❌' : '✅'} | ` +
      `${failed.map((c) => `${c.name}（${c.detail}）`).join('；') || '—'} |`,
  );
}

lines.push('', '## 可行 arm 的排序（§7.5 顺位）', '');
if (!ranked.length) {
  lines.push('**没有任何 arm 可行。**按 §7.5 第 6 条，阶段 2B 结论为未通过，不进入生产 profile。');
} else {
  lines.push('| # | arm | Phase2 hit@5 | Phase2 MRR | empty 均值 | cap | floor |');
  lines.push('| ---: | --- | ---: | ---: | ---: | ---: | ---: |');
  ranked.forEach((a, i) => {
    lines.push(
      `| ${i + 1} | ${a.label} | ${pct(a.phase2HitAt5)} | ${a.phase2Mrr.toFixed(3)} | ` +
        `${a.phase2EmptyReturned.toFixed(2)} | ${capStr(a.cap)} | ${a.floor} |`,
    );
  });
  lines.push('', `## 选中：\`${winner!.label}\``, '');
  lines.push('| 项 | 值 |');
  lines.push('| --- | --- |');
  lines.push(`| semanticFloor | \`${winner!.floor}\` |`);
  lines.push(`| semanticOnlyLimit | \`${capStr(winner!.cap)}\` |`);
  lines.push(`| Phase 2 hit@5 | ${pct(winner!.phase2HitAt5)}（基线 ${pct(baseline.phase2HitAt5)}） |`);
  lines.push(`| Phase 2 MRR | ${winner!.phase2Mrr.toFixed(3)}（基线 ${baseline.phase2Mrr.toFixed(3)}） |`);
  lines.push(`| Phase 2 empty 平均 / 最坏 | ${winner!.phase2EmptyReturned.toFixed(2)} / ${winner!.phase2EmptyWorst} |`);
  lines.push(`| discovery 请求 / 生效 / 被协议边界挡 | ${winner!.discoveryRequested} / ${winner!.discoveryEffective} / ${winner!.discoveryBlocked} |`);
  lines.push(`| 报告 | \`${winner!.path}\` |`);
}

const reportPath = flag('report');
if (reportPath) {
  writeFileSync(resolve(reportPath), lines.join('\n') + '\n', 'utf-8');
  console.log(`[select] 报告：${resolve(reportPath)}`);
}
const jsonPath = flag('json');
if (jsonPath) {
  writeFileSync(
    resolve(jsonPath),
    JSON.stringify(
      {
        resolution,
        baseline,
        arms: evaluated.map(({ arm, checks }) => ({ ...arm, checks })),
        ranked: ranked.map((a) => a.label),
        winner: winner ? { floor: winner.floor, cap: winner.cap, label: winner.label } : null,
      },
      null,
      2,
    ),
    'utf-8',
  );
  console.log(`[select] JSON：${resolve(jsonPath)}`);
}

console.log(lines.join('\n'));
process.exit(winner ? 0 : 1);
