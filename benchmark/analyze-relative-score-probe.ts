/**
 * 安全策略轮次 P4.0：相对分数准入的**描述性证伪探针**。
 *
 * 方案：`plan/V3/retrieval-safety-round-plan-2026-08-10.md` §9。
 *
 * 它只回答一个问题：**"这条记录对这次查询是不是异常地像"这个信号到底存不存在。**
 *
 *   μ_q, σ_q = 本次查询对 scope 内全部向量的余弦均值与标准差
 *   z(c)     = (score(c) - μ_q) / σ_q
 *
 * 退化条件（这就是要证伪的东西）：如果 μ_q 与 σ_q 在不同 query 之间几乎不动，z 的排序就等于
 * 原始分数的排序，这条规则只是换了写法的固定 floor，收益为零。苗头往坏的方向——正例 top1
 * 中位 0.436、负例 0.348，**绝对分数本身就有差**。
 *
 * ## 纪律
 *
 * - **不选任何阈值、不产出任何 arm。** 用已消耗的盲审集做描述性测量是合法的（不选参数），
 *   但由此得到的任何 τ 都**不得**直接采用，τ 只能在 P2 的新校准集上选。
 * - 本脚本**不建数据库、不播种、不跑检索**。μ/σ 只需要"查询向量 × 记录向量"的余弦，
 *   跟 FTS、时间窗、RRF、cap 都无关。重跑审计要 5 万条播种 + FTS 索引；这里只做
 *   10,026 次记录编码 + 56 次查询编码，约 2 分钟。
 * - 装置保真：记录文本、gold 英文派生值、查询英文形式全部取自冻结产物，并逐项校验 SHA-256。
 *   5 份副本共用向量，所以物理行口径 = filler 权重 ×5、gold ×1，无需真的存 5 万行。
 *
 * ## 自证
 *
 * 复算的 above-floor 物理行数必须与审计逐 query 记录的 `aboveFloorCount` 完全一致。
 * 一致说明本脚本重建的向量空间与审计是同一个；不一致则 μ/σ 不可信，退出非零。
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

import { loadDataset, annotationToResult } from './dataset';
import { semanticEnSearchTextFields, type SemanticEnRecord } from '../src/semantic-en';
import { generateEmbedding, buildObservationSearchText, DIMENSIONS } from '../src/embedding';

const sha256 = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');
const sha16 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);
const read = (p: string): any => JSON.parse(readFileSync(p, 'utf-8'));
const die = (m: string): never => { console.error(`[p40] ✗ ${m}`); process.exit(1); };

const DIR = 'benchmark/reports/final-recall';
const OUT_DIR = join(import.meta.dir, 'reports', 'safety-round');
const freeze = read(join(DIR, 'codex-blind-audit-freeze.json'));

// --- 冻结校验：只校验本探针真正读取的四项 -----------------------------------
for (const [path, want] of [
  [freeze.input, freeze.inputSha256],
  [freeze.oldCorpus.path, freeze.oldCorpus.sha256],
  ...freeze.factSources.map((f: any) => [f.path, f.sha256]),
] as [string, string][]) {
  const got = sha256(path);
  if (got !== want) die(`冻结校验失败：${path}\n  期望 ${want}\n  实际 ${got}`);
}
console.log('[p40] 冻结校验通过（输入 / 老语料 / 事实源）');

const input = read(freeze.input) as {
  queries: { id: string; kind: string; cohort?: string; negative_type?: string; query: string; semantic_query_en: string | null; gold: string[] }[];
};
const filler = read(freeze.oldCorpus.path) as {
  id: string; title: string; summary: string; outcome: string; learned: string; concepts: string[]; files: string[];
}[];
const dataset = loadDataset();
const enRecords = read(join(import.meta.dir, 'dataset', 'mirror-en-acp-records.json'))
  .records as Record<string, SemanticEnRecord>;
const COPIES: number = freeze.oldCorpus.copies;
const FLOOR = 0.197; // 审计当时的生产值，只用于自证复算，不是本探针要选的东西

// --- 1. 重建记录向量 --------------------------------------------------------
//
// 与审计逐字同源：gold 用冻结英文派生值 + annotation 的 files_touched；filler 用 5 个字段 + files。
type Vec = Float32Array;
const goldVecs: { id: string; v: Vec }[] = [];
const t0 = Date.now();
for (const turn of dataset.turns) {
  if (turn.scope !== 'primary') continue;
  const normalized = enRecords[turn.id] ?? die(`缺少冻结英文派生值：${turn.id}`);
  const result = annotationToResult(turn.annotation);
  goldVecs.push({
    id: turn.id,
    v: await generateEmbedding(buildObservationSearchText(
      semanticEnSearchTextFields(normalized, result.files_touched),
    )),
  });
}
const fillerVecs: Vec[] = [];
for (const f of filler) {
  fillerVecs.push(await generateEmbedding(buildObservationSearchText(semanticEnSearchTextFields(
    { title: f.title, summary: f.summary, outcome: f.outcome, learned: f.learned, concepts: f.concepts },
    f.files,
  ))));
}
console.log(`[p40] 记录向量重建完成：gold ${goldVecs.length} + filler ${fillerVecs.length}，${((Date.now() - t0) / 1000).toFixed(1)}s`);

/** 物理行权重：filler 每条原文对应 COPIES 行，gold 各 1 行。 */
const PHYSICAL_ROWS = fillerVecs.length * COPIES + goldVecs.length;

const dot = (a: Vec, b: Vec): number => {
  let s = 0;
  for (let i = 0; i < DIMENSIONS; i++) s += a[i]! * b[i]!;
  return s;
};
/** 生产向量已归一化（`generateEmbedding` 输出单位向量），因此点积即余弦。 */
const cos = dot;

// --- 2. 逐 query 统计 -------------------------------------------------------
interface Row {
  id: string; kind: string; negativeType: string | null;
  protocol: 'semantic-en-v1' | 'skipped';
  muPhysical: number; sigmaPhysical: number;
  muDistinct: number; sigmaDistinct: number;
  top1: number; top1Z: number;
  top2: number | null; top2Z: number | null;
  goldBest: number | null; goldBestZ: number | null;
  aboveFloorPhysical: number;
  auditAboveFloor: number | null; selfCheckOk: boolean | null;
}

const auditRows = new Map<string, any>(
  (read(join(DIR, 'codex-blind-audit-result.json')).armsRaw.unbounded.main as any[]).map((r) => [r.id, r]),
);

const rows: Row[] = [];
for (const q of input.queries) {
  if (!q.semantic_query_en) {
    rows.push({
      id: q.id, kind: q.kind, negativeType: q.negative_type ?? null, protocol: 'skipped',
      muPhysical: NaN, sigmaPhysical: NaN, muDistinct: NaN, sigmaDistinct: NaN,
      top1: NaN, top1Z: NaN, top2: null, top2Z: null, goldBest: null, goldBestZ: null,
      aboveFloorPhysical: 0, auditAboveFloor: null, selfCheckOk: null,
    });
    continue;
  }
  const qv = await generateEmbedding(q.semantic_query_en);

  // 一次遍历同时累计两套口径的和与平方和：物理行（filler ×COPIES）与不同原文（×1）。
  let sumP = 0; let sqP = 0; let sumD = 0; let sqD = 0; let aboveP = 0;
  let top1 = -Infinity; let top2 = -Infinity;
  const bump = (s: number): void => {
    if (s > top1) { top2 = top1; top1 = s; } else if (s > top2) top2 = s;
  };
  for (const v of fillerVecs) {
    const s = cos(qv, v);
    sumP += s * COPIES; sqP += s * s * COPIES; sumD += s; sqD += s * s;
    if (s > FLOOR) aboveP += COPIES;
    // 副本同分，所以 top1/top2 里必然出现同一个值两次——与审计页面的形状一致。
    bump(s); bump(s);
  }
  const goldSet = new Set(q.gold);
  let goldBest: number | null = null;
  for (const g of goldVecs) {
    const s = cos(qv, g.v);
    sumP += s; sqP += s * s; sumD += s; sqD += s * s;
    if (s > FLOOR) aboveP += 1;
    bump(s);
    if (goldSet.has(g.id)) goldBest = goldBest === null ? s : Math.max(goldBest, s);
  }
  const nD = fillerVecs.length + goldVecs.length;
  const muP = sumP / PHYSICAL_ROWS;
  const sdP = Math.sqrt(Math.max(0, sqP / PHYSICAL_ROWS - muP * muP));
  const muD = sumD / nD;
  const sdD = Math.sqrt(Math.max(0, sqD / nD - muD * muD));
  const z = (s: number): number => (s - muP) / sdP;
  const audit = auditRows.get(q.id);
  rows.push({
    id: q.id, kind: q.kind, negativeType: q.negative_type ?? null, protocol: 'semantic-en-v1',
    muPhysical: muP, sigmaPhysical: sdP, muDistinct: muD, sigmaDistinct: sdD,
    top1, top1Z: z(top1), top2: Number.isFinite(top2) ? top2 : null, top2Z: Number.isFinite(top2) ? z(top2) : null,
    goldBest, goldBestZ: goldBest === null ? null : z(goldBest),
    aboveFloorPhysical: aboveP,
    auditAboveFloor: audit?.aboveFloorCount ?? null,
    selfCheckOk: audit ? audit.aboveFloorCount === aboveP : null,
  });
}

// --- 3. 自证 ----------------------------------------------------------------
const checked = rows.filter((r) => r.selfCheckOk !== null);
const selfCheckPass = checked.filter((r) => r.selfCheckOk).length;
const selfCheckOk = selfCheckPass === checked.length;
console.log(`[p40] 自证：above-floor 物理行数与审计一致 ${selfCheckPass}/${checked.length}`);

// --- 4. 分离度：z 是否真的比原始分数分得更开 --------------------------------
const rel = rows.filter((r) => r.kind === 'relevance' && r.protocol === 'semantic-en-v1');
const neg = rows.filter((r) => r.kind === 'hard-negative' && r.protocol === 'semantic-en-v1');
const nums = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]!;
  const mu = s.reduce((a, b) => a + b, 0) / s.length;
  return { n: s.length, min: s[0]!, p25: q(0.25), median: q(0.5), p75: q(0.75), max: s[s.length - 1]!, mean: mu };
};
/**
 * Mann–Whitney AUC：随机取一条正例和一条负例，正例读数更高的概率。
 * 0.5 = 完全分不开，1.0 = 完全分开。平局各算一半。
 */
const auc = (pos: number[], negv: number[]): number => {
  let win = 0;
  for (const p of pos) for (const n of negv) win += p > n ? 1 : p === n ? 0.5 : 0;
  return win / (pos.length * negv.length);
};
/** 保住全部正例的最高阈值，以及它放进多少负例。 */
const admitAtFullRecall = (pos: number[], negv: number[]) => {
  const t = Math.min(...pos);
  return { threshold: t, negativesAdmitted: negv.filter((x) => x >= t).length, negativesTotal: negv.length };
};

const metrics = {
  rawTop1: {
    relevance: nums(rel.map((r) => r.top1)), hardNegative: nums(neg.map((r) => r.top1)),
    auc: auc(rel.map((r) => r.top1), neg.map((r) => r.top1)),
    fullRecall: admitAtFullRecall(rel.map((r) => r.top1), neg.map((r) => r.top1)),
  },
  zTop1: {
    relevance: nums(rel.map((r) => r.top1Z)), hardNegative: nums(neg.map((r) => r.top1Z)),
    auc: auc(rel.map((r) => r.top1Z), neg.map((r) => r.top1Z)),
    fullRecall: admitAtFullRecall(rel.map((r) => r.top1Z), neg.map((r) => r.top1Z)),
  },
  mu: { relevance: nums(rel.map((r) => r.muPhysical)), hardNegative: nums(neg.map((r) => r.muPhysical)) },
  sigma: { relevance: nums(rel.map((r) => r.sigmaPhysical)), hardNegative: nums(neg.map((r) => r.sigmaPhysical)) },
};
const allMu = rows.filter((r) => r.protocol === 'semantic-en-v1').map((r) => r.muPhysical);
const allSd = rows.filter((r) => r.protocol === 'semantic-en-v1').map((r) => r.sigmaPhysical);
const spread = {
  muRange: Math.max(...allMu) - Math.min(...allMu),
  muRelativeSpread: (Math.max(...allMu) - Math.min(...allMu)) / (allMu.reduce((a, b) => a + b, 0) / allMu.length),
  sigmaRange: Math.max(...allSd) - Math.min(...allSd),
  sigmaRelativeSpread: (Math.max(...allSd) - Math.min(...allSd)) / (allSd.reduce((a, b) => a + b, 0) / allSd.length),
};

const out: Record<string, unknown> = {
  generatedAt: new Date().toISOString(),
  role: '描述性探针。不选阈值、不产出 arm、不重判任何门。',
  plan: 'plan/V3/retrieval-safety-round-plan-2026-08-10.md §9',
  provenance: {
    scriptSha256: sha16(readFileSync(import.meta.path, 'utf-8')),
    frozenInputsVerified: [freeze.input, freeze.oldCorpus.path, ...freeze.factSources.map((f: any) => f.path)],
    goldRecords: goldVecs.length, fillerSourceTexts: fillerVecs.length, copies: COPIES,
    physicalRows: PHYSICAL_ROWS, floorUsedForSelfCheckOnly: FLOOR,
    note: '未建数据库、未播种、未跑检索；μ/σ 只依赖查询向量与记录向量的余弦',
  },
  selfCheck: { basis: 'above-floor 物理行数 vs 审计 aboveFloorCount', pass: selfCheckOk, matched: selfCheckPass, total: checked.length },
  spread,
  metrics,
  perQuery: rows,
};

const f3 = (x: number): string => x.toFixed(3);
const verdict = metrics.zTop1.auc > metrics.rawTop1.auc + 0.02
  ? 'z 分得更开：P4 有立项依据'
  : metrics.zTop1.auc < metrics.rawTop1.auc - 0.02
    ? 'z 分得更差：P4 应作废'
    : 'z 与原始分数分离度基本相同：**退化条件成立，P4 应作废**';

// --- 机制：为什么 z 反而更差 -------------------------------------------------
//
// 机械读数，不做解释性加工：负例的 μ_q 更低 ⇒ 同一个绝对分数被除出更大的 z。
// 用两个具体 query 把它落到实处：z 最高的负例，以及被它超过的正例。
const worstNeg = neg.reduce((a, b) => (a.top1Z >= b.top1Z ? a : b));
const beatenRel = rel.filter((r) => r.top1Z < worstNeg.top1Z).sort((a, b) => b.top1 - a.top1);
const mechanism = {
  muRelevanceMedian: metrics.mu.relevance.median,
  muNegativeMedian: metrics.mu.hardNegative.median,
  muLowerOnNegatives: metrics.mu.hardNegative.median < metrics.mu.relevance.median,
  worstNegative: { id: worstNeg.id, negativeType: worstNeg.negativeType, top1: worstNeg.top1, mu: worstNeg.muPhysical, sigma: worstNeg.sigmaPhysical, z: worstNeg.top1Z },
  relevanceBeatenByIt: beatenRel.map((r) => ({ id: r.id, top1: r.top1, mu: r.muPhysical, z: r.top1Z })),
};
out.mechanism = mechanism;
out.verdict = verdict;
writeFileSync(join(OUT_DIR, 'p40-relative-score-probe.json'), `${JSON.stringify(out, null, 2)}\n`);

const md = `# P4.0 相对分数准入：描述性证伪探针

> **本探针不选阈值、不产出 arm、不重判任何门。** 它只回答"这个信号存不存在"。
> 由此得到的任何数字**不得**用作生产阈值——阈值只能在 P2 的新校准集上选。

> 方案：\`plan/V3/retrieval-safety-round-plan-2026-08-10.md\` §9
> 脚本：\`benchmark/analyze-relative-score-probe.ts\`
> 机器可读：\`safety-round/p40-relative-score-probe.json\`

---

## 1. 装置与自证

未建数据库、未播种、未跑检索。μ/σ 只需要"查询向量 × 记录向量"的余弦，与 FTS、时间窗、RRF、
cap 无关，所以重建 ${goldVecs.length} 条 gold + ${fillerVecs.length} 条 filler 原文向量即可；
5 份副本共用向量，物理行口径按 filler ×${COPIES} 加权，等价于 ${PHYSICAL_ROWS} 行。

冻结校验：\`${freeze.input}\`、老语料及事实源逐项 SHA-256 通过。

**自证：** 复算的 above-floor 物理行数与审计逐 query 的 \`aboveFloorCount\`
一致 **${selfCheckPass} / ${checked.length}** ${selfCheckOk ? '✅' : '❌'}。
${selfCheckOk ? '一致说明本探针重建的向量空间与审计是同一个，下面的 μ/σ 才可信。' : '**不一致，μ/σ 不可信。**'}

---

## 2. μ_q 与 σ_q 到底动不动

| 读数 | 正例（${metrics.mu.relevance.n} 条） | hard-negative（${metrics.mu.hardNegative.n} 条） |
| --- | --- | --- |
| μ_q 中位 | ${f3(metrics.mu.relevance.median)} | ${f3(metrics.mu.hardNegative.median)} |
| μ_q 范围 | ${f3(metrics.mu.relevance.min)} … ${f3(metrics.mu.relevance.max)} | ${f3(metrics.mu.hardNegative.min)} … ${f3(metrics.mu.hardNegative.max)} |
| σ_q 中位 | ${f3(metrics.sigma.relevance.median)} | ${f3(metrics.sigma.hardNegative.median)} |
| σ_q 范围 | ${f3(metrics.sigma.relevance.min)} … ${f3(metrics.sigma.relevance.max)} | ${f3(metrics.sigma.hardNegative.min)} … ${f3(metrics.sigma.hardNegative.max)} |

全部 ${allMu.length} 条 query 合起来：

- μ_q 极差 **${f3(spread.muRange)}**，相对均值的离散度 **${(spread.muRelativeSpread * 100).toFixed(1)}%**
- σ_q 极差 **${f3(spread.sigmaRange)}**，相对均值的离散度 **${(spread.sigmaRelativeSpread * 100).toFixed(1)}%**

---

## 3. 决定性对比：z 是否比原始分数分得更开

| 指标 | 正例中位 | 负例中位 | 重叠区间 | AUC |
| --- | ---: | ---: | --- | ---: |
| 原始 top1 分数 | ${f3(metrics.rawTop1.relevance.median)} | ${f3(metrics.rawTop1.hardNegative.median)} | ${f3(metrics.rawTop1.relevance.min)} … ${f3(metrics.rawTop1.hardNegative.max)} | **${f3(metrics.rawTop1.auc)}** |
| z(top1) | ${f3(metrics.zTop1.relevance.median)} | ${f3(metrics.zTop1.hardNegative.median)} | ${f3(metrics.zTop1.relevance.min)} … ${f3(metrics.zTop1.hardNegative.max)} | **${f3(metrics.zTop1.auc)}** |

AUC = 随机取一条正例和一条负例、正例读数更高的概率。0.5 = 完全分不开，1.0 = 完全分开。

"保住全部正例的最高阈值，会放进多少负例"：

| 指标 | 阈值 | 放进的负例 |
| --- | ---: | ---: |
| 原始 top1 分数 | ${f3(metrics.rawTop1.fullRecall.threshold)} | ${metrics.rawTop1.fullRecall.negativesAdmitted} / ${metrics.rawTop1.fullRecall.negativesTotal} |
| z(top1) | ${f3(metrics.zTop1.fullRecall.threshold)} | ${metrics.zTop1.fullRecall.negativesAdmitted} / ${metrics.zTop1.fullRecall.negativesTotal} |

---

## 4. 结论

**${verdict}**

判据（方案 §9 预写）：z 分布明显比绝对分数分得开 → P4 立项；分不开 → P4 当场作废。
本探针按 AUC ± 0.02 的分辨力机械判定，不做解释性加工。

### 4.1 机制：z 为什么反而更差

μ_q 确实在动（相对离散度 ${(spread.muRelativeSpread * 100).toFixed(1)}%），但**它动的方向是反的**：

| | 正例 | hard-negative |
| --- | ---: | ---: |
| μ_q 中位 | ${f3(mechanism.muRelevanceMedian)} | **${f3(mechanism.muNegativeMedian)}** |

问一件这个项目**没做过**的事，整个语料对它都更不像，所以 μ_q 更低；同一个绝对分数被一个更小的
均值一减、再除以标准差，z 就更大。**z 系统性地奖励"语料里什么都不相关"的查询**，而这正是它本来
要挡住的那一类。

最极端的一条：\`${mechanism.worstNegative.id}\`（${mechanism.worstNegative.negativeType}）
绝对分数只有 ${f3(mechanism.worstNegative.top1)}，但 μ_q=${f3(mechanism.worstNegative.mu)}、
σ_q=${f3(mechanism.worstNegative.sigma)}，于是 z=**${f3(mechanism.worstNegative.z)}**——
比 ${mechanism.relevanceBeatenByIt.length} 条**真有答案**的正例都高：

| 被它超过的正例 | 绝对分数 | μ_q | z |
| --- | ---: | ---: | ---: |
${mechanism.relevanceBeatenByIt.slice(0, 8).map((r) => `| ${r.id} | ${f3(r.top1)} | ${f3(r.mu)} | ${f3(r.z)} |`).join('\n')}

**推论：任何以"相对语料背景做归一化"为核心的准入规则都会踩同一个坑**，包括分位数版本、
margin-over-median 版本。它们共享同一个前提——"背景水平可以代表这次查询的难度"——而这个前提
在 hard-negative 上恰好是反的。后续轮次不要换一种归一化再试一遍。

---

## 5. 边界

- 样本是**已消耗**的 26 条正例 + 30 条负例，只够回答"信号存不存在"，不够选阈值；
- 负例 2/3 是 near-domain，若 P2 的新集分布不同，AUC 会变；
- 本探针测的是 **top1 的 z**。若 P4 立项，正式实验还要覆盖 top2 及页面内每一条候选；
- μ/σ 按整个 scope 算。生产实现里它们来自流式打分循环的累加，口径相同，但真实请求还会受
  type / days 过滤影响，本探针未覆盖。
`;
writeFileSync(join(OUT_DIR, 'p40-relative-score-probe.md'), md);

console.log(`\n=== μ/σ 离散度 ===`);
console.log(`  μ_q 极差 ${f3(spread.muRange)}（相对 ${(spread.muRelativeSpread * 100).toFixed(1)}%）`);
console.log(`  σ_q 极差 ${f3(spread.sigmaRange)}（相对 ${(spread.sigmaRelativeSpread * 100).toFixed(1)}%）`);
console.log(`\n=== 分离度 ===`);
console.log(`  原始 top1 分数 AUC ${f3(metrics.rawTop1.auc)}；保全正例的阈值 ${f3(metrics.rawTop1.fullRecall.threshold)} 放进 ${metrics.rawTop1.fullRecall.negativesAdmitted}/${metrics.rawTop1.fullRecall.negativesTotal} 条负例`);
console.log(`  z(top1)        AUC ${f3(metrics.zTop1.auc)}；保全正例的阈值 ${f3(metrics.zTop1.fullRecall.threshold)} 放进 ${metrics.zTop1.fullRecall.negativesAdmitted}/${metrics.zTop1.fullRecall.negativesTotal} 条负例`);
console.log(`\n结论：${verdict}`);
console.log(`\n写入 ${join(OUT_DIR, 'p40-relative-score-probe.md')}`);
if (!selfCheckOk) { console.error('\n自证失败：重建的向量空间与审计不一致，读数不可信。'); process.exit(1); }
