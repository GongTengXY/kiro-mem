/**
 * 候选池策略轮次：按预登记判据机械计算门槛与选择结果。
 *
 * 判据：`benchmark/reports/pool-policy-criteria.md`（A0 `b62d31533d4f2465` +
 * B1 `b16760f5edef3c30`）。本脚本不做任何判断，只执行 §6.1 的门槛与 §7 的顺序规则——
 * 判据 §10 第 3 项要求"脚本输出，不得手工编辑"，因为手工抄表选择就是"看完数字再解释"的
 * 入口。
 *
 * 三个输入都是已落盘的 arm 读数，本脚本不跑检索：
 *   pool-policy/recall.json    6 个召回 arm（2,000 条冻结装置）
 *   pool-policy/scale-10k.json 2,000 / 10,000 档 × 4 个池值
 *   pool-policy/scale-50k.json 50,000 档 × 4 个池值
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

const REPORTS = join(import.meta.dir, 'reports');
const sha16 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);
const read = (p: string): any => JSON.parse(readFileSync(join(REPORTS, p), 'utf-8'));

const recall = read('pool-policy/recall.json');
const scale10 = read('pool-policy/scale-10k.json');
const scale50 = read('pool-policy/scale-50k.json');

// --- 判据里的常数，逐条抄自 §6.1，不在这里重新发明 ------------------------------
const CAP = 2;                    // semanticOnlyLimit
const EMPTY_MEAN_MAX = 4.06;      // G8: 基线 3.56 + 0.50
const EMPTY_SO_MEAN_MAX = 1.36;   // G10: 基线 0.86 + 0.50
const P95_MAX = 300;              // G13
const P99_MAX = 500;              // G14
const RSS_LOOP_MAX = 512;         // G15（50,000 档）
const RSS_PEAK_MAX = 1024;        // G16（50,000 档）
const MIN_SAMPLES = 200;          // G14 的样本口径
const BASE = 'pool-200';

/** §5.1 登记为结构验证 arm，不参与选择。 */
const STRUCTURAL_ONLY = new Set(['pool-1970', 'pool-1971']);

interface Check { id: string; pass: boolean; reading: string }

const perQuery: Record<string, any[]> = recall.perQuery;
const baseRows = new Map<string, any>((perQuery[BASE] ?? []).map((r) => [r.id, r]));

/** G5′ + G6′ + 新进页统计：逐 query 对比 arm 与基线的返回页。 */
function pageDiff(arm: string) {
  const rows = perQuery[arm] ?? [];
  let semanticNew = 0;
  let nonSemanticNew = 0;
  let wasFtsCandidate = 0;
  let unexplained = 0;
  let semanticOver = 0;
  let goldLostTop5 = 0;
  let goldLostPage = 0;
  let goldGainTop5 = 0;
  const unexplainedExamples: string[] = [];
  for (const r of rows) {
    const b = baseRows.get(r.id);
    if (!b) continue;
    const before = new Set<string>(b.resultIds);
    const baseFts = new Set<string>(b.ftsIds ?? []);
    let semanticThisQuery = 0;
    r.resultIds.forEach((id: string, i: number) => {
      if (before.has(id)) return;
      if (r.resultSources[i] === 'semantic') { semanticNew++; semanticThisQuery++; return; }
      nonSemanticNew++;
      // G5′(b)：已是基线的 FTS 候选 → 本次只是被融合重排（结构界 S2），不是新候选。
      if (baseFts.has(id)) wasFtsCandidate++;
      else { unexplained++; if (unexplainedExamples.length < 5) unexplainedExamples.push(`${r.id}:${id}`); }
    });
    // G5′(a)：新进页的 semantic 条数受 cap 约束。
    if (semanticThisQuery > CAP) semanticOver++;
    if (r.kind === 'relevance' && r.expect.length) {
      const was5 = b.goldRank !== null && b.goldRank <= 5;
      const is5 = r.goldRank !== null && r.goldRank <= 5;
      if (was5 && !is5) goldLostTop5++;
      if (!was5 && is5) goldGainTop5++;
      if (b.goldRank !== null && r.goldRank === null) goldLostPage++;
    }
  }
  return {
    semanticNew, nonSemanticNew, wasFtsCandidate, unexplained, unexplainedExamples,
    semanticOver, goldLostTop5, goldLostPage, goldGainTop5,
  };
}

/** 成本读数：把 arm 的池值映射到 perf 档里的池名。 */
function perfFor(poolName: string): { size: number; r: any }[] {
  const out: { size: number; r: any }[] = [];
  for (const src of [scale10, scale50]) {
    for (const r of src.performance ?? []) if (r.pool === poolName) out.push({ size: r.size, r });
  }
  return out;
}

interface ArmVerdict {
  arm: string;
  pool: number;
  /** 召回读数是实测还是"语料 ≤ 池值，构造上等于 pool-full"。 */
  recallSource: 'measured' | 'by-construction';
  role: 'candidate' | 'structural-only';
  checks: Check[];
  feasible: boolean;
  metrics: Record<string, number>;
}

/**
 * 参选 arm。
 *
 * `5000` / `20000` 的召回读数**不是实测**：装置只有 2,000 条，任何 ≥2000 的池覆盖全部语料，
 * 于是它们与 `pool-full` 的召回读数在构造上相同（判据 §1.2）。这一点必须显式标注，
 * 不能让脚本悄悄把 `pool-full` 的数字当成它们的实测值。
 */
const ARMS: { arm: string; pool: number; perfPool: string; recallFrom: string }[] = [
  { arm: 'pool-200', pool: 200, perfPool: '200', recallFrom: 'pool-200' },
  { arm: 'pool-500', pool: 500, perfPool: '', recallFrom: 'pool-500' },
  { arm: 'pool-1000', pool: 1000, perfPool: '', recallFrom: 'pool-1000' },
  { arm: 'pool-1970', pool: 1970, perfPool: '', recallFrom: 'pool-1970' },
  { arm: 'pool-1971', pool: 1971, perfPool: '', recallFrom: 'pool-1971' },
  { arm: 'pool-5000', pool: 5000, perfPool: '5000', recallFrom: 'pool-full' },
  { arm: 'pool-20000', pool: 20000, perfPool: '20000', recallFrom: 'pool-full' },
  { arm: 'pool-full', pool: Number.POSITIVE_INFINITY, perfPool: 'full', recallFrom: 'pool-full' },
];

const baseM = recall.arms[BASE];
const verdicts: ArmVerdict[] = [];

for (const a of ARMS) {
  const m = recall.arms[a.recallFrom];
  if (!m) { console.error(`✗ 缺少 ${a.recallFrom} 的召回读数`); process.exit(1); }
  const isBase = a.arm === BASE;
  const diff = isBase ? null : pageDiff(a.recallFrom);
  const perf = perfFor(a.perfPool);
  const checks: Check[] = [];
  const add = (id: string, pass: boolean, reading: string) => checks.push({ id, pass, reading });

  add('G1 泄漏=0', m.leakTotal === 0, `${m.leakTotal}`);
  add(`G2 semanticOnlyMax≤${CAP}`, m.semanticOnlyMax <= CAP, `${m.semanticOnlyMax}`);
  add('G4 degrade=0（召回档）', m.degradedCount === 0, `${m.degradedCount}`);
  if (diff) {
    add('G5′ 无法归因的新进页=0', diff.unexplained === 0,
      `${diff.unexplained}（非 semantic ${diff.nonSemanticNew} 条，其中已是 FTS 候选 ${diff.wasFtsCandidate}）`);
    add(`G5′ semantic 新进页>${CAP} 的 query=0`, diff.semanticOver === 0, `${diff.semanticOver}`);
    add('G6′ gold 掉出 top-5=0', diff.goldLostTop5 === 0, `${diff.goldLostTop5}`);
    add('G6′ gold 掉出整页=0', diff.goldLostPage === 0, `${diff.goldLostPage}`);
    add('G7 净收益>0（进入 top-5 > 掉出 top-5）', diff.goldGainTop5 > diff.goldLostTop5,
      `+${diff.goldGainTop5} / −${diff.goldLostTop5}`);
  }
  add(`G8 empty 均值≤${EMPTY_MEAN_MAX}`, m.emptyLike.meanReturned <= EMPTY_MEAN_MAX,
    `${m.emptyLike.meanReturned}`);
  add('G9 empty 最坏≤10', m.emptyLike.worstReturned <= 10, `${m.emptyLike.worstReturned}`);
  add(`G10 empty semantic-only 均值≤${EMPTY_SO_MEAN_MAX} 且 max≤${CAP}`,
    m.emptyLike.semanticOnlyMean <= EMPTY_SO_MEAN_MAX && m.emptyLike.semanticOnlyMax <= CAP,
    `${m.emptyLike.semanticOnlyMean} / ${m.emptyLike.semanticOnlyMax}`);

  if (!a.perfPool) {
    add('G13/G14 成本读数存在', false, '未测（本 arm 未进入成本 instrument）');
  } else if (!perf.length) {
    add('G13/G14 成本读数存在', false, '缺失');
  } else {
    for (const { size, r } of perf) {
      add(`G13 p95<${P95_MAX}ms @${size}`, r.latency.p95 < P95_MAX, `${r.latency.p95}ms`);
      add(`G14 p99<${P99_MAX}ms @${size}`, r.latency.p99 < P99_MAX, `${r.latency.p99}ms`);
      add(`G14 样本≥${MIN_SAMPLES} @${size}`, r.samples >= MIN_SAMPLES, `${r.samples}`);
      add(`G4 degrade=0 @${size}`, r.degradedCount === 0, `${r.degradedCount}`);
      if (size === 50000) {
        add(`G15 循环内 RSS≤${RSS_LOOP_MAX}MB @50000`, r.rssLoop.deltaMb <= RSS_LOOP_MAX,
          `+${r.rssLoop.deltaMb}MB`);
        add(`G16 全局峰值 RSS≤${RSS_PEAK_MAX}MB @50000`, r.rssPeakMb <= RSS_PEAK_MAX,
          `${r.rssPeakMb}MB`);
        add('G17 RSS 跨轮不单调上涨 @50000',
          !r.rssPerRoundMb.every((v: number, i: number, arr: number[]) => i === 0 || v > arr[i - 1]!),
          `[${r.rssPerRoundMb.join(', ')}]`);
      }
    }
  }

  verdicts.push({
    arm: a.arm,
    pool: a.pool,
    recallSource: a.recallFrom === a.arm ? 'measured' : 'by-construction',
    role: STRUCTURAL_ONLY.has(a.arm) ? 'structural-only' : 'candidate',
    checks,
    feasible: checks.every((c) => c.pass),
    metrics: {
      phase2Reached: m.relevance.byOrigin.phase2?.reached ?? 0,
      phase2HitAt5: m.relevance.byOrigin.phase2?.hitAt5 ?? 0,
      phase2Mrr: m.relevance.byOrigin.phase2?.mrr ?? 0,
      fusionHitAt5: m.relevance.byOrigin.fusion?.hitAt5 ?? 0,
      fusionMrr: m.relevance.byOrigin.fusion?.mrr ?? 0,
      reachRate: m.relevance.semanticReachRate,
      hitAt5: m.relevance.hitAt5,
    },
  });
}

// --- G-STEP′：步进函数（B1 修订后的触达口径） --------------------------------
const reachOf = (arm: string): number => recall.arms[arm].relevance.semanticReachedGold;
/**
 * 边界归因：从 `pool-1970` 到 `pool-1971`，语义腿新触达的 gold 目标必须恰好 1 条。
 *
 * 第一版这里数的是"两个 arm 各自触达目标的并集大小"，结果两边都是 27，检查失败。那是**度量
 * 写错了**，不是门槛错了：一条目标只要被任意一条 query 触达就进入并集，而 `t26` 在 1970 档
 * 已经被另一条有 FTS 命中的 query 触达过，所以并集不动。真正要测的是"新进入候选池的那条记录
 * 是不是恰好一条目标"——按 query 的触达翻转（false→true）归因才能测到。
 *
 * 实测：z29 / z53 / z54 三条 query 同时翻转，gold 全部是 `t26`，`comparableVectors`
 * 均值 1964 → 1965（正好 +1 条），无反向翻转。
 */
function stepBoundaryTargets(from: string, to: string): { targets: string[]; queries: string[]; regressed: number } {
  const A = new Map<string, any>((perQuery[from] ?? []).map((r) => [r.id, r]));
  const targets = new Set<string>();
  const queries: string[] = [];
  let regressed = 0;
  for (const r of perQuery[to] ?? []) {
    const a = A.get(r.id);
    if (!a) continue;
    if (!a.semanticReachedGold && r.semanticReachedGold) {
      queries.push(r.id);
      for (const e of r.expect) targets.add(e);
    }
    if (a.semanticReachedGold && !r.semanticReachedGold) regressed++;
  }
  return { targets: [...targets], queries, regressed };
}
const boundary = stepBoundaryTargets('pool-1970', 'pool-1971');
const stepChecks: Check[] = [
  {
    id: 'G-STEP′ pool-500/1000/1970 触达数 = pool-200',
    pass: [ 'pool-500', 'pool-1000', 'pool-1970' ].every((a) => reachOf(a) === reachOf(BASE)),
    reading: `200=${reachOf(BASE)} 500=${reachOf('pool-500')} 1000=${reachOf('pool-1000')} 1970=${reachOf('pool-1970')}`,
  },
  {
    id: 'G-STEP′ pool-1971 恰好多触达 1 条目标',
    pass: boundary.targets.length === 1 && boundary.regressed === 0,
    reading: `新触达目标 [${boundary.targets.join(', ')}]（${boundary.targets.length} 条）` +
      `｜翻转 query ${boundary.queries.join('/')}｜反向翻转 ${boundary.regressed}` +
      `｜可比向量 ${recall.arms['pool-1970'].comparableVectorsAvg} → ${recall.arms['pool-1971'].comparableVectorsAvg}`,
  },
];

// --- §7 选择规则 -------------------------------------------------------------
const RULES: { name: string; key: keyof ArmVerdict['metrics']; }[] = [
  { name: '规则 1 phase2 触达数', key: 'phase2Reached' },
  { name: '规则 2 phase2 hit@5', key: 'phase2HitAt5' },
  { name: '规则 3 phase2 MRR', key: 'phase2Mrr' },
  { name: '规则 4 fusion hit@5', key: 'fusionHitAt5' },
  { name: '规则 5 fusion MRR', key: 'fusionMrr' },
];

let pool = verdicts.filter((v) => v.role === 'candidate' && v.feasible);
const trace: string[] = [];
if (!pool.length) {
  trace.push('无可行 arm → 分支 B-4：保持 200，本轮结论为未通过');
} else {
  for (const rule of RULES) {
    if (pool.length === 1) break;
    const best = Math.max(...pool.map((v) => v.metrics[rule.key]!));
    const kept = pool.filter((v) => v.metrics[rule.key] === best);
    trace.push(`${rule.name}：最优 ${best} → 保留 ${kept.map((v) => v.arm).join(', ')}`);
    pool = kept;
  }
  if (pool.length > 1) {
    const best = Math.max(...pool.map((v) => v.pool));
    const kept = pool.filter((v) => v.pool === best);
    trace.push(`规则 6 池值更大者：${kept.map((v) => v.arm).join(', ')}`);
    pool = kept;
  }
}
const selected = pool.length === 1 ? pool[0]! : null;
const infeasible = verdicts.filter((v) => v.role === 'candidate' && !v.feasible);
const branch = !selected
  ? 'B-4：无可行 arm，保持 200'
  : selected.arm === BASE
    ? 'B-3/B-4：基线胜出，保持 200'
    : selected.pool === Number.POSITIVE_INFINITY
      ? 'B-1：pool-full 通过全部门槛 → 默认改为 Infinity，分块取向量为强制前置条件'
      : `B-2：最大可行有限池 = ${selected.pool}`;

// --- §12（B2）：裁定固定的性能补证门 P1–P6，机械判定最终分支 -------------------
//
// §7 的规则在**登记的 instrument** 上选出 pool-full。裁定另加了一层：50,000 条真实
// cosine 分布回放 + 双进程内存口径。P1–P6 任一失败 → 分支强制为 B-2（20000）。
// 这里读补证 JSON 复算，而不是把结论写进散文。
const P = { p95: 300, p99: 500, rssLoop: 512, rssPeak: 1024, samples: 200 };
function recheckVerdict(pool: string, file: string) {
  let j: any;
  try { j = read(file); } catch { return null; }
  const r = (j.results ?? []).find((x: any) => x.pool === pool);
  if (!r) return null;
  const checks: Check[] = [
    { id: `P1 p95<${P.p95}ms`, pass: r.latency.p95 < P.p95, reading: `${r.latency.p95}ms` },
    { id: `P2 p99<${P.p99}ms`, pass: r.latency.p99 < P.p99, reading: `${r.latency.p99}ms` },
    { id: `P3 循环内 RSS 增量≤${P.rssLoop}MB`, pass: r.rssLoop.deltaMb <= P.rssLoop, reading: `+${r.rssLoop.deltaMb}MB` },
    { id: `P4 检索进程峰值≤${P.rssPeak}MB`, pass: r.rssProcessPeakMb <= P.rssPeak, reading: `${r.rssProcessPeakMb}MB` },
    { id: `P5 样本≥${P.samples}`, pass: r.samples >= P.samples, reading: `${r.samples}` },
    { id: 'P6 degrade=0', pass: r.degradedCount === 0, reading: `${r.degradedCount}` },
  ];
  return {
    pool, file, checks, pass: checks.every((c) => c.pass),
    floorPass: r.floorPass, twoProcess: j.provenance?.twoProcess === true,
  };
}
const recheck = [
  recheckVerdict('full', 'pool-policy/perf-recheck-50000.json'),
  // 最终代码（**未分块**）的确认。裁定要求用最终代码重跑 pool=20000，因为 B2 那次测的是
  // 分块实现；`-p20000.json`（分块）保留在产物里作为对照，不参与判定。
  recheckVerdict('20000', 'pool-policy/perf-recheck-50000-p20000-final.json'),
].filter((x): x is NonNullable<typeof x> => x !== null);

/** P3 是 GC 驱动的读数，所以三次独立运行都留档，方差写进报告而不是只取一次。 */
const recheckVariance = [
  'pool-policy/perf-recheck-50000-p20000-final.json',
  'pool-policy/perf-recheck-50000-p20000-final-r2.json',
  'pool-policy/perf-recheck-50000-p20000-final-r3.json',
].map((file) => {
  try {
    const r = (read(file).results ?? []).find((x: any) => x.pool === '20000');
    return r ? { file, p50: r.latency.p50, p95: r.latency.p95, p99: r.latency.p99, rssDeltaMb: r.rssLoop.deltaMb, rssPeakMb: r.rssProcessPeakMb } : null;
  } catch { return null; }
}).filter((x): x is NonNullable<typeof x> => x !== null);

const recheckFull = recheck.find((r) => r.pool === 'full');
const recheck20k = recheck.find((r) => r.pool === '20000');
let finalBranch = branch;
let finalPool: number | null = selected ? selected.pool : null;
if (recheckFull && !recheckFull.pass) {
  // 裁定 §12.5：任一门失败 → B-2，池值 20000，且必须写明它在 50,000 条上截断 60%、
  // 不得宣称召回等价。B-2 的候选值本身也必须过同一组门，否则不是"可行的退路"。
  if (!recheck20k) {
    finalBranch = '✗ Infinity 补证失败，但缺少 20000 的补证读数——无法收口，须补测';
    finalPool = null;
  } else if (!recheck20k.pass) {
    finalBranch = '✗ Infinity 与 20000 都未通过补证门——须上报，B-2 不成立';
    finalPool = null;
  } else {
    finalBranch = 'B-2（裁定 §12.5）：Infinity 补证门失败 → 生产使用 20000；必须写明它在 50,000 条上截断 60%，不得宣称召回等价';
    finalPool = 20000;
  }
} else if (recheckFull?.pass) {
  finalBranch = 'A（裁定 §12.5）：Infinity 通过 P1–P6 → 生产使用 Infinity';
  finalPool = Number.POSITIVE_INFINITY;
}

const out = {
  generatedAt: new Date().toISOString(),
  provenance: {
    criteria: 'benchmark/reports/pool-policy-criteria.md',
    criteriaSha256: sha16(readFileSync(join(REPORTS, 'pool-policy-criteria.md'), 'utf-8')),
    scriptSha256: sha16(readFileSync(import.meta.path, 'utf-8')),
    inputs: {
      recall: recall.provenance,
      scale10k: scale10.provenance?.perfPools,
      scale50k: scale50.provenance?.perfPools,
    },
  },
  stepFunction: stepChecks,
  arms: verdicts,
  selectionTrace: trace,
  selected: selected ? { arm: selected.arm, pool: selected.pool } : null,
  branch,
  perfRecheck: recheck,
  perfRecheckVariance: recheckVariance,
  finalBranch,
  finalPool: finalPool === Number.POSITIVE_INFINITY ? "Infinity" : finalPool,
};

writeFileSync(join(REPORTS, 'pool-policy-selection.json'), `${JSON.stringify(out, null, 2)}\n`);

// --- 控制台摘要 --------------------------------------------------------------
console.log('=== G-STEP′ 步进函数 ===');
for (const c of stepChecks) console.log(`  ${c.pass ? '✅' : '❌'} ${c.id}：${c.reading}`);
console.log('\n=== 逐 arm 门槛 ===');
for (const v of verdicts) {
  const failed = v.checks.filter((c) => !c.pass);
  console.log(
    `  ${v.feasible ? '✅' : '❌'} ${v.arm.padEnd(11)} [${v.role}/${v.recallSource}] ` +
      `phase2 触达 ${v.metrics.phase2Reached} hit@5 ${v.metrics.phase2HitAt5}% | ` +
      (failed.length ? `失败：${failed.map((c) => `${c.id}=${c.reading}`).join('; ')}` : '全部通过'),
  );
}
console.log('\n=== 选择 ===');
for (const t of trace) console.log(`  ${t}`);
console.log(`  → ${selected ? selected.arm : '无'}｜§7 分支 ${branch}`);
console.log('\n=== 性能补证门 P1–P6（裁定 §12）===');
if (!recheck.length) console.log('  ⚠ 没有补证读数——先跑 run-pool-perf-recheck.ts');
for (const r of recheck) {
  console.log(`  ${r.pass ? '✅' : '❌'} pool=${r.pool}（双进程口径 ${r.twoProcess ? '是' : '否'}，过 floor 比例均 ${(r.floorPass.rateMean * 100).toFixed(1)}% max ${(r.floorPass.rateMax * 100).toFixed(1)}%）`);
  for (const c of r.checks) console.log(`      ${c.pass ? '✅' : '❌'} ${c.id}：${c.reading}`);
}
if (recheckVariance.length > 1) {
  console.log('  pool=20000 最终代码三次复现（P3 是 GC 驱动读数，故留方差）：');
  for (const v of recheckVariance) {
    console.log(`      p50 ${v.p50} / p95 ${v.p95} / p99 ${v.p99}ms｜RSS +${v.rssDeltaMb}MB（峰 ${v.rssPeakMb}MB）`);
  }
}
console.log(`\n最终：pool=${finalPool === Number.POSITIVE_INFINITY ? 'Infinity' : finalPool}｜${finalBranch}`);
if (infeasible.length) console.log(`  （不可行候选：${infeasible.map((v) => v.arm).join(', ')}）`);
console.log('\n写入 benchmark/reports/pool-policy-selection.json');

if (stepChecks.some((c) => !c.pass)) { console.error('✗ G-STEP′ 未成立，判据要求本轮读数作废'); process.exit(1); }
