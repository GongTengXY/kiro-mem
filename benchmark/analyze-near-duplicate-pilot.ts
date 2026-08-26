/**
 * 安全策略轮次 P2 第 2 步：**近重复 pilot**。
 *
 * 判据：`benchmark/reports/safety-round/p2-calibration-criteria.md` §6，
 * 已冻结（SHA-256 记在 `p2-calibration-freeze.json`）。
 *
 * 它只回答两个问题：
 *
 *   1. 生产编码器把「同一事实的改写」和「同区域不同工作」分得开吗？
 *   2. 因此，未来**有没有可能**给重叠检查建立自动筛查？
 *
 * ## 纪律（判据 §6 与 §5.4）
 *
 * - **不得**据此设定本轮的自动删除阈值。4–5 组样本量太小；两个分布若重叠即登记
 *   "不能自动化"，本步结束。
 * - **不得**据此调整 0.450 复核带——那条带子已在判据里冻结。
 * - 本步不跑检索、不建数据库、不播种：只做记录向量的两两余弦。
 *
 * ## 自证
 *
 * 判据 §5.3 的复核带来自 26 条旧 gold 的两两分布。本脚本先复算那 325 对，必须逐位
 * 复现判据里写下的六个分位数；一致才说明 pilot 与那条带子在同一个向量空间里，
 * 不一致则本步的任何读数都不可比，直接退出非零。
 *
 * 用法：bun run benchmark/analyze-near-duplicate-pilot.ts
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

import { loadDataset, annotationToResult, DATASET_DIR } from './dataset';
import type { Annotation } from './dataset';
import { semanticEnSearchTextFields, type SemanticEnRecord } from '../src/semantic-en';
import { generateEmbedding, buildObservationSearchText, DIMENSIONS } from '../src/embedding';

const sha256 = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');
const read = (p: string): any => JSON.parse(readFileSync(p, 'utf-8'));
const die = (m: string): never => {
  console.error(`[pilot] ✗ ${m}`);
  process.exit(1);
};

const OUT_DIR = join(import.meta.dir, 'reports', 'safety-round');
const FREEZE = join(OUT_DIR, 'p2-calibration-freeze.json');
const PILOT = join(DATASET_DIR, 'near-duplicate-pilot.json');
const PILOT_EN = join(DATASET_DIR, 'mirror-en-acp-records-near-duplicate-pilot.json');
const OLD_EN = join(DATASET_DIR, 'mirror-en-acp-records.json');

/**
 * 判据 §5.3 写下的六个分位数。它们是**冻结文本里的数字**，不是本脚本算出来的，
 * 所以拿它做自证是合法的：算错了会不一致，算对了说明空间同源。
 */
const CRITERIA_BASELINE = { min: -0.072, p50: 0.246, p90: 0.384, p95: 0.45, p99: 0.545, max: 0.614 };
const REVIEW_BAND = 0.45;

// --- 冻结校验 ---------------------------------------------------------------
const freeze = read(FREEZE);
{
  const got = sha256(freeze.criteria);
  if (got !== freeze.criteriaSha256) {
    die(`判据已被改动，冻结失效：${freeze.criteria}\n  冻结 ${freeze.criteriaSha256}\n  实际 ${got}`);
  }
  const oldPrimary = sha256(freeze.ftsZeroCorpus.oldPrimary);
  if (oldPrimary !== freeze.ftsZeroCorpus.oldPrimarySha256) {
    die(`旧语料已被改动：${freeze.ftsZeroCorpus.oldPrimary}`);
  }
}
console.log('[pilot] 冻结校验通过（判据 + 旧语料）');

// --- 向量 -------------------------------------------------------------------
type Vec = Float32Array;
const dot = (a: Vec, b: Vec): number => {
  let s = 0;
  for (let i = 0; i < DIMENSIONS; i++) s += a[i]! * b[i]!;
  return s;
};
/** 生产向量已归一化，所以点积即余弦。 */
const cos = dot;

const embedRecord = async (en: SemanticEnRecord, files: string[]): Promise<Vec> =>
  generateEmbedding(buildObservationSearchText(semanticEnSearchTextFields(en, files)));

const dataset = loadDataset();
const oldEn = read(OLD_EN).records as Record<string, SemanticEnRecord>;
const oldVecs: { id: string; v: Vec }[] = [];
for (const t of dataset.turns) {
  if (t.scope !== 'primary') continue;
  const en = oldEn[t.id] ?? die(`旧记录缺英文派生值：${t.id}`);
  oldVecs.push({ id: t.id, v: await embedRecord(en, annotationToResult(t.annotation).files_touched) });
}

// --- 自证：复算判据 §5.3 的 325 对 ------------------------------------------
const q = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))]!;
const r3 = (x: number): number => Number(x.toFixed(3));

const oldPairs: { a: string; b: string; c: number }[] = [];
for (let i = 0; i < oldVecs.length; i++) {
  for (let j = i + 1; j < oldVecs.length; j++) {
    oldPairs.push({ a: oldVecs[i]!.id, b: oldVecs[j]!.id, c: cos(oldVecs[i]!.v, oldVecs[j]!.v) });
  }
}
const oldSorted = oldPairs.map((p) => p.c).sort((x, y) => x - y);
const recomputed = {
  pairs: oldSorted.length,
  min: r3(oldSorted[0]!),
  p50: r3(q(oldSorted, 0.5)),
  p90: r3(q(oldSorted, 0.9)),
  p95: r3(q(oldSorted, 0.95)),
  p99: r3(q(oldSorted, 0.99)),
  max: r3(oldSorted.at(-1)!),
};
const selfCheckDiffs = (Object.keys(CRITERIA_BASELINE) as (keyof typeof CRITERIA_BASELINE)[])
  .filter((k) => recomputed[k] !== CRITERIA_BASELINE[k])
  .map((k) => `${k}: 判据 ${CRITERIA_BASELINE[k]} vs 复算 ${recomputed[k]}`);
if (oldSorted.length !== 325 || selfCheckDiffs.length) {
  die(`自证失败——pilot 与判据 §5.3 的复核带不在同一个向量空间：\n  ${selfCheckDiffs.join('\n  ')}`);
}
console.log(`[pilot] 自证通过：325 对逐位复现判据 §5.3（min ${recomputed.min} / p50 ${recomputed.p50} / p95 ${recomputed.p95} / max ${recomputed.max}）`);

// --- pilot 向量 -------------------------------------------------------------
interface PilotRecord {
  id: string;
  group: string;
  area: string;
  role: 'base' | 'rewrite' | 'sibling';
  rewrite_of?: string;
  sibling_of?: string;
  annotation: Annotation;
}
const pilot = read(PILOT) as { meta: Record<string, unknown>; records: PilotRecord[] };
const pilotEn = read(PILOT_EN).records as Record<string, SemanticEnRecord>;
const pilotVecs = new Map<string, Vec>();
for (const r of pilot.records) {
  const en = pilotEn[r.id] ?? die(`pilot 记录缺英文派生值：${r.id}（先跑 probe-acp-translate --record-set=near-duplicate-pilot）`);
  pilotVecs.set(r.id, await embedRecord(en, annotationToResult(r.annotation).files_touched));
}
const byId = new Map(pilot.records.map((r) => [r.id, r]));
console.log(`[pilot] pilot 向量完成：${pilotVecs.size} 条 / ${new Set(pilot.records.map((r) => r.group)).size} 组`);

// --- 两类 pair --------------------------------------------------------------
interface Pair { group: string; area: string; a: string; b: string; cosine: number }
const samefact: Pair[] = [];
const sibling: Pair[] = [];
for (const r of pilot.records) {
  const anchor = r.rewrite_of ?? r.sibling_of;
  if (!anchor) continue;
  const pair: Pair = {
    group: r.group,
    area: r.area,
    a: anchor,
    b: r.id,
    cosine: cos(pilotVecs.get(anchor)!, pilotVecs.get(r.id)!),
  };
  (r.role === 'rewrite' ? samefact : sibling).push(pair);
}
if (samefact.length < 4 || sibling.length < 4) {
  die(`判据 §6 要求 4–5 组：实测同一事实 ${samefact.length} 对 / 同区域 ${sibling.length} 对`);
}

/** 同一事实的改写对，与该组 sibling 对做**组内**对比，避免跨组难度差混进结论。 */
const perGroup = [...new Set(pilot.records.map((r) => r.group))].map((g) => {
  const sf = samefact.find((p) => p.group === g)!;
  const sb = sibling.find((p) => p.group === g)!;
  return {
    group: g,
    area: sf.area,
    sameFact: r3(sf.cosine),
    sibling: r3(sb.cosine),
    margin: r3(sf.cosine - sb.cosine),
    orderedCorrectly: sf.cosine > sb.cosine,
  };
});

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return { n: s.length, min: r3(s[0]!), p50: r3(q(s, 0.5)), max: r3(s.at(-1)!), mean: r3(s.reduce((a, b) => a + b, 0) / s.length) };
};
const sfStats = stats(samefact.map((p) => p.cosine));
const sbStats = stats(sibling.map((p) => p.cosine));
/** 两个分布是否重叠：同一事实的最小值是否仍高于同区域的最大值。 */
const separated = sfStats.min > sbStats.max;
const overlap = separated ? null : { from: r3(sbStats.max), to: r3(sfStats.min) };

// --- pilot × 旧 26 条：复核带筛查量 -----------------------------------------
const crossPairs: { pilot: string; old: string; cosine: number }[] = [];
for (const [pid, pv] of pilotVecs) {
  for (const o of oldVecs) crossPairs.push({ pilot: pid, old: o.id, cosine: cos(pv, o.v) });
}
const crossSorted = crossPairs.map((p) => p.cosine).sort((a, b) => a - b);
const inBand = crossPairs.filter((p) => p.cosine > REVIEW_BAND).sort((a, b) => b.cosine - a.cosine);

// --- 逐对裁决：完整性校验 ---------------------------------------------------
//
// 裁决按 `fact_source` 与两侧 annotation 的事实内容做（判据 §5.2），不按余弦——
// 余弦只决定哪几对进入这张表。这里只校验"进带的每一对都有裁决"，缺一对即失败：
// 复核带的意义在于**穷举**，漏判一对就等于把该对静默放过。
const adj = read(join(OUT_DIR, 'p2-pilot-overlap-adjudication.json')) as {
  rulings: { pair: string; verdict: 'duplicate' | 'related'; reason: string; action: string }[];
};
const ruled = new Map(adj.rulings.map((r) => [r.pair, r]));
{
  const missing = inBand.map((p) => `${p.pilot}×${p.old}`).filter((k) => !ruled.has(k));
  const extra = [...ruled.keys()].filter((k) => !inBand.some((p) => `${p.pilot}×${p.old}` === k));
  if (missing.length) die(`复核带内有 ${missing.length} 对没有裁决：${missing.join(', ')}`);
  if (extra.length) die(`裁决表含不在复核带内的对：${extra.join(', ')}`);
}
const duplicates = adj.rulings.filter((r) => r.verdict === 'duplicate');
const dupCosines = duplicates.map(
  (r) => crossPairs.find((p) => `${p.pilot}×${p.old}` === r.pair)!.cosine,
);
console.log(`[pilot] 逐对裁决完整：${inBand.length} 对，其中 duplicate ${duplicates.length} 对`);

// --- 跨集分离度：这才是"能不能自动化"的判据 ---------------------------------
//
// 组内分离（§3）只比较了同一组内部的两条 pair，那是构造出来的对照，不是自动筛查会
// 面对的场景。真正的问题是：把**所有已知的同一事实对**与**所有已知的不同工作对**放在
// 一条数轴上，有没有一个数能把它们分开。
//
//   同一事实对 = pilot 的 rewrite 对（构造） + 裁决为 duplicate 的跨集对（实际发生的误写）
//   不同工作对 = pilot 的 sibling 对 + 判据 §5.3 已裁定的旧 gold 两两分布
const sameFactAll = [...samefact.map((p) => p.cosine), ...dupCosines];
const diffWorkAll = [...sibling.map((p) => p.cosine), ...oldPairs.map((p) => p.c)];
const sameFactAllStats = stats(sameFactAll);
const diffWorkAllStats = stats(diffWorkAll);
const crossSetSeparated = sameFactAllStats.min > diffWorkAllStats.max;
const crossSetOverlap = crossSetSeparated
  ? null
  : { from: r3(sameFactAllStats.min), to: r3(diffWorkAllStats.max) };
/** 落在重叠区间里的两类样本各有多少——重叠区间不空但两边都无样本时结论会不同。 */
const inOverlap = crossSetOverlap
  ? {
      sameFact: sameFactAll.filter((c) => c >= crossSetOverlap.from && c <= crossSetOverlap.to).length,
      diffWork: diffWorkAll.filter((c) => c >= crossSetOverlap.from && c <= crossSetOverlap.to).length,
    }
  : { sameFact: 0, diffWork: 0 };

// --- 报告 -------------------------------------------------------------------
mkdirSync(OUT_DIR, { recursive: true });
const jsonOut = {
  step: 'P2 step 2 · near-duplicate pilot',
  criteria: { path: freeze.criteria, sha256: freeze.criteriaSha256, section: '§6' },
  discipline: {
    thresholdSelection: 'none — 本步不选任何阈值',
    autoDeleteEnabled: false,
    reviewBandFrozenAt: REVIEW_BAND,
  },
  inputs: [
    { path: 'benchmark/dataset/near-duplicate-pilot.json', sha256: sha256(PILOT) },
    { path: 'benchmark/dataset/mirror-en-acp-records-near-duplicate-pilot.json', sha256: sha256(PILOT_EN) },
    { path: 'benchmark/dataset/mirror-en-acp-records.json', sha256: sha256(OLD_EN) },
    { path: 'benchmark/dataset/turns.json', sha256: sha256(join(DATASET_DIR, 'turns.json')) },
  ],
  selfCheck: { criteriaBaseline: CRITERIA_BASELINE, recomputed, passed: true },
  perGroup,
  distributions: { sameFactRewrite: sfStats, sameAreaDifferentWork: sbStats, separated, overlap },
  crossSetSeparation: {
    note: '同一事实对 = pilot rewrite 对 + 裁决为 duplicate 的跨集对；不同工作对 = pilot sibling 对 + 判据 §5.3 的旧 gold 两两分布',
    sameFactAll: sameFactAllStats,
    differentWorkAll: diffWorkAllStats,
    separated: crossSetSeparated,
    overlap: crossSetOverlap,
    samplesInOverlap: inOverlap,
  },
  adjudication: {
    path: 'benchmark/reports/safety-round/p2-pilot-overlap-adjudication.json',
    sha256: sha256(join(OUT_DIR, 'p2-pilot-overlap-adjudication.json')),
    pairsRuled: adj.rulings.length,
    duplicate: duplicates.map((r) => ({
      pair: r.pair,
      cosine: r3(crossPairs.find((p) => `${p.pilot}×${p.old}` === r.pair)!.cosine),
      reason: r.reason,
      action: r.action,
    })),
    related: adj.rulings.length - duplicates.length,
  },
  crossWithOldGold: {
    pairs: crossPairs.length,
    min: r3(crossSorted[0]!),
    p50: r3(q(crossSorted, 0.5)),
    p95: r3(q(crossSorted, 0.95)),
    max: r3(crossSorted.at(-1)!),
    aboveReviewBand: inBand.length,
    aboveReviewBandRate: r3(inBand.length / crossPairs.length),
    projectedAt40Records: Math.round((inBand.length / crossPairs.length) * 40 * oldVecs.length),
    entries: inBand.map((p) => ({
      pilot: p.pilot,
      old: p.old,
      cosine: r3(p.cosine),
      area: byId.get(p.pilot)!.area,
      verdict: ruled.get(`${p.pilot}×${p.old}`)!.verdict,
    })),
  },
  verdict: crossSetSeparated ? 'separated-in-this-sample' : 'overlapping-cannot-automate',
};
writeFileSync(join(OUT_DIR, 'p2-near-duplicate-pilot.json'), JSON.stringify(jsonOut, null, 2), 'utf-8');

const md: string[] = [];
md.push('# 安全策略轮次 P2 第 2 步：近重复 pilot');
md.push('');
md.push('> 判据：`benchmark/reports/safety-round/p2-calibration-criteria.md` §6');
md.push('>');
md.push(`> 判据 SHA-256：\`${freeze.criteriaSha256}\`（冻结校验通过）`);
md.push('>');
md.push('> **本步不选任何阈值。** 判据 §6 已写死：pilot 不得作为本轮自动删除阈值的充分证据；');
md.push('> 0.450 复核带在判据 §5.4 冻结，本步不得调整它。');
md.push('');
md.push('## 1. 自证：与复核带同源');
md.push('');
md.push('判据 §5.3 的复核带来自 26 条旧 gold 的两两分布。复算 325 对：');
md.push('');
md.push('| | min | p50 | p90 | p95 | p99 | max |');
md.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
md.push(`| 判据 §5.3 写下的 | ${CRITERIA_BASELINE.min} | ${CRITERIA_BASELINE.p50} | ${CRITERIA_BASELINE.p90} | ${CRITERIA_BASELINE.p95} | ${CRITERIA_BASELINE.p99} | ${CRITERIA_BASELINE.max} |`);
md.push(`| 本脚本复算 | ${recomputed.min} | ${recomputed.p50} | ${recomputed.p90} | ${recomputed.p95} | ${recomputed.p99} | ${recomputed.max} |`);
md.push('');
md.push('逐位一致，因此 pilot 与那条带子在同一个 `semantic-en-v1` 空间里。');
md.push('英文派生值由**生产 ACP 译者**（`kiro-mem-compressor`）用与旧 26 条同一份 prompt 产出，');
md.push('所以两侧不存在译者差异。');
md.push('');
md.push('## 2. 逐组读数');
md.push('');
md.push('| 组 | 区域 | 同一事实改写 | 同区域不同工作 | 差值 | 顺序正确 |');
md.push('| --- | --- | ---: | ---: | ---: | :--: |');
for (const g of perGroup) {
  md.push(`| ${g.group} | ${g.area} | ${g.sameFact} | ${g.sibling} | ${g.margin >= 0 ? '+' : ''}${g.margin} | ${g.orderedCorrectly ? '✅' : '❌'} |`);
}
md.push('');
md.push('## 3. 两个分布');
md.push('');
md.push('| 类别 | n | min | p50 | 均值 | max |');
md.push('| --- | ---: | ---: | ---: | ---: | ---: |');
md.push(`| 同一事实改写 | ${sfStats.n} | ${sfStats.min} | ${sfStats.p50} | ${sfStats.mean} | ${sfStats.max} |`);
md.push(`| 同区域不同工作 | ${sbStats.n} | ${sbStats.min} | ${sbStats.p50} | ${sbStats.mean} | ${sbStats.max} |`);
md.push('');
md.push(
  separated
    ? `两个分布在本样本上**不重叠**：同一事实的最小值 ${sfStats.min} 高于同区域的最大值 ${sbStats.max}，中间空隙 ${r3(sfStats.min - sbStats.max)}。`
    : `两个分布**重叠**，重叠区间 [${overlap!.from}, ${overlap!.to}]。`,
);
md.push('');
md.push('**但这只是组内对照，不是自动筛查会面对的场景。** 见 §5。');
md.push('');
md.push('## 4. pilot × 26 条旧 gold：复核带的筛查量与逐对裁决');
md.push('');
md.push(`${crossPairs.length} 对（15 × 26），min ${r3(crossSorted[0]!)} / p50 ${r3(q(crossSorted, 0.5))} / p95 ${r3(q(crossSorted, 0.95))} / max ${r3(crossSorted.at(-1)!)}。`);
md.push(`超过复核带 0.450 的：**${inBand.length} 对**（${(jsonOut.crossWithOldGold.aboveReviewBandRate * 100).toFixed(1)}%）。`);
md.push('');
md.push(`按同一比例外推到第 4 步的 40 条新记录 × ${oldVecs.length} 条旧 gold = ${40 * oldVecs.length} 对，`);
md.push(`预计进复核带 **约 ${jsonOut.crossWithOldGold.projectedAt40Records} 对**——与判据 §5.3 估的"量级是几十对，人工判得完"一致。`);
md.push('');
md.push('裁决按 `fact_source` 与两侧事实内容做，不按余弦（判据 §5.2）。逐对裁决见');
md.push('`p2-pilot-overlap-adjudication.json`，分析脚本校验其覆盖复核带内每一对，缺一对即失败。');
md.push('');
md.push('| pilot 记录 | 旧 gold | 余弦 | 裁决 | pilot 区域 |');
md.push('| --- | --- | ---: | --- | --- |');
for (const e of jsonOut.crossWithOldGold.entries) {
  md.push(`| ${e.pilot} | ${e.old} | ${e.cosine} | ${e.verdict === 'duplicate' ? '**duplicate**' : 'related'} | ${e.area} |`);
}
md.push('');
md.push(`裁决结果：**duplicate ${duplicates.length} 对 / related ${adj.rulings.length - duplicates.length} 对**。`);
md.push('');
md.push('两条 duplicate 都是**撰写时无意造出的重复**，不是刻意构造的：');
md.push('');
for (const d of jsonOut.adjudication.duplicate) {
  md.push(`- **${d.pair}（${d.cosine}）** ${d.reason}`);
  md.push(`  - 处置：${d.action}`);
}
md.push('');
md.push('这条读数本身就是 pilot 最有用的产出：作者在明知要避免重复的前提下写 5 条同区域记录，');
md.push('仍有 2 条撞上了既有 gold。第 4 步的 40 条必须逐条过复核带，不能靠作者自觉。');
md.push('');
md.push('## 5. 结论：不能自动化');
md.push('');
md.push('§3 的组内分离是构造出来的对照。自动筛查真正要做的判断是：把**所有已知的同一事实对**与');
md.push('**所有已知的不同工作对**放在一条数轴上，存不存在一个数把它们分开。');
md.push('');
md.push('| 类别 | 样本来源 | n | min | p50 | max |');
md.push('| --- | --- | ---: | ---: | ---: | ---: |');
md.push(`| 同一事实对 | pilot 的 rewrite 对（构造）+ 裁决为 duplicate 的跨集对（无意误写） | ${sameFactAllStats.n} | ${sameFactAllStats.min} | ${sameFactAllStats.p50} | ${sameFactAllStats.max} |`);
md.push(`| 不同工作对 | pilot 的 sibling 对 + 判据 §5.3 的旧 gold 两两分布 | ${diffWorkAllStats.n} | ${diffWorkAllStats.min} | ${diffWorkAllStats.p50} | ${diffWorkAllStats.max} |`);
md.push('');
if (crossSetSeparated) {
  md.push(`两类在本样本上仍不重叠（同一事实 min ${sameFactAllStats.min} > 不同工作 max ${diffWorkAllStats.max}）。`);
  md.push('但样本量仍然只有判据 §6 说的 4–5 组量级，**不得**据此冻结生产阈值。');
} else {
  md.push(`**两类重叠，重叠区间 [${crossSetOverlap!.from}, ${crossSetOverlap!.to}]**，`);
  md.push(`区间内有同一事实对 ${inOverlap.sameFact} 个、不同工作对 ${inOverlap.diffWork} 个。`);
  md.push('任何单一余弦阈值放在这个区间里，都会同时误删真东西和漏掉重复。');
  md.push('');
  md.push('最尖锐的两个样本：');
  md.push('');
  md.push(`- 同一事实、余弦只有 ${r3(Math.min(...sameFactAll))}（无意误写的那两对之一）；`);
  md.push(`- 不同工作、余弦高到 ${r3(Math.max(...diffWorkAll))}（判据 §5.3 已裁定为不同工作的旧 gold 对）。`);
  md.push('');
  md.push('**按判据 §6 的分支：两个分布重叠 → 登记"不能自动化"，本步结束。**');
  md.push('这与判据 §5.1 第 3 层"本轮不启用余弦自动删除"的既有裁定一致，');
  md.push('区别是现在有了样本支撑，不再只是"0.614…1.000 之间没有已知样本"这个空白论证——');
  md.push('那段空白现在被填上了，填进去的样本恰好证明它不可分。');
}
md.push('');
md.push('## 6. 对第 4 步的约束（本步产出的可执行结论）');
md.push('');
md.push('1. **p04c 与 p03c 的事实不得进入 40 条新记录**：分别与 t11、t08 同一事实（见 §4）。');
md.push('2. **复核带必须逐对穷举**，不得抽样：本步 2/5 条同区域记录撞上既有 gold，比例太高。');
md.push('3. **裁决表格式沿用本步的 `pair / verdict / reason / action` 四字段**，并由脚本校验完整性。');
md.push('4. **不得启用自动删除**，也不得把本步的任何数值当阈值——包括 0.611、0.558、0.614。');
md.push('');
md.push('## 7. 诚实边界');
md.push('');
md.push('- rewrite 对由同一人在同一次会话内撰写，刻意变换措辞与叙述角度。真实的无意重复来自 ACP');
md.push('  压缩器在两个不同 turn 上记录同一件事，其相似度**从未被测量过**。');
md.push('- 因此"同一事实对"这一类的分布是**混合来源**的：2 个来自真实误写（0.558 / 0.670），');
md.push('  5 个来自人为改写。前者才是生产形状，而它恰好是分数更低、更难抓的那一端。');
md.push('- 本步不建数据库、不播种、不跑检索，所有读数都是记录向量的两两余弦。');
writeFileSync(join(OUT_DIR, 'p2-near-duplicate-pilot.md'), md.join('\n'), 'utf-8');

console.log('');
console.log(`[pilot] 同一事实改写 n=${sfStats.n}  min ${sfStats.min} / p50 ${sfStats.p50} / max ${sfStats.max}`);
console.log(`[pilot] 同区域不同工作 n=${sbStats.n}  min ${sbStats.min} / p50 ${sbStats.p50} / max ${sbStats.max}`);
console.log(`[pilot] 组内分布${separated ? '不重叠' : `重叠 [${overlap!.from}, ${overlap!.to}]`}`);
console.log(`[pilot] pilot × 旧 gold 超 ${REVIEW_BAND} 的：${inBand.length} / ${crossPairs.length}（外推 40 条约 ${jsonOut.crossWithOldGold.projectedAt40Records} 对）`);
console.log(
  `[pilot] 跨集分离：${crossSetSeparated ? '不重叠' : `重叠 [${crossSetOverlap!.from}, ${crossSetOverlap!.to}] → 登记「不能自动化」`}`,
);
console.log(`[pilot] 写入 ${join(OUT_DIR, 'p2-near-duplicate-pilot.md')} 与 .json`);

