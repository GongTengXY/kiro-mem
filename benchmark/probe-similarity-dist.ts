/**
 * 相似度分布探针 + 候选 floor 扫描（检索优化方案 §4.2）。
 *
 * 它**不是决策程序**，这一点必须写在最前面。
 *
 * 三个池、p95/p99、扫描表，全部是 **query-record pair 层面**的读数；而 §6.6 验收
 * 的是**产品行为**（heldout hit@5、expected-empty 返回条数与最坏值）。两者之间还
 * 隔着语义排名 → FTS 排名 → RRF 融合 → limit 截断 → semantic-only 限额，而且同一条
 * empty query 可能有多条记录同时越过 floor —— pair 通过率 5% 完全可以变成"每条
 * empty query 平均返回 1.3 条"。所以本脚本的产出只有一个：**3–5 个候选 floor**。
 * 最终 floor 由每个候选各跑一次完整 `bun run bench` 的产品指标决定（§6.2）。
 *
 * 三个池的举证能力不同，绝不能混算：
 *
 *   - **正例池（38 对）**：36 条 relevance query 的标注 expected。q03→[t03,t19]、
 *     q04→[t04,t19] 各有两个，其余 34 条各一个。写"36 对"是错的。
 *   - **标注真负例池（130 对）**：5 条 `kind: "empty"` query × 26 条 primary 记录。
 *     这是唯一有标注支撑的负例——本 scope 内既无相关记忆也无合法词汇重叠。
 *     **候选 floor 以它的 p99 为准。**
 *   - **未标注非目标对池（898 对）**：36 × 26 扣掉 38 个正例对。它**不是**已知负例：
 *     `run.ts` 自己的注释就写明标注集不完备、R-precision 因此只是下界，同一份不
 *     完备标注拿来当负例标签，那 898 对里必然混有真正相关的记录，负例分布被系统
 *     性**抬高**，进而抬高 floor、压掉真实召回。它只用于观察形状与稳定性。
 *
 * 统计量用 p95/p99 而不是 max：max 在 n=130 上极不稳定，样本一多基本只会往上走，
 * 据此校准的 floor 会系统性偏低。max 仍然报，但只作参考。
 *
 * 历史对照（当前编码器、旧口径）：正例 0.080–0.607、噪声 max 0.431。保留作对照，
 * **不再用于任何决策**。
 *
 * 用法：
 *   bun run benchmark/probe-similarity-dist.ts
 *   bun run benchmark/probe-similarity-dist.ts --report=path.md --json=path.json
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { loadDataset, validateQueries, annotationSearchText } from './dataset';
import { cosineSimilarity } from '../src/embedding';
import { loadEncoder, specFromArgs } from './encoder';

const args = process.argv.slice(2);
function flag(name: string, fallback?: string): string | undefined {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const encoderSpec = specFromArgs(flag);
const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-|-$/g, '');
const reportPath = resolve(
  flag(
    'report',
    join(
      import.meta.dir,
      'reports',
      `probe-similarity-dist${flag('model') ? `-${slug(encoderSpec.label)}` : ''}.md`,
    ),
  )!,
);
const jsonPath = flag('json') ? resolve(flag('json')!) : undefined;

const { turns, queries } = loadDataset();
const datasetErrors = validateQueries(queries);
if (datasetErrors.length) {
  for (const e of datasetErrors) console.error(`[probe] ${e}`);
  process.exit(2);
}

const primaryTurns = turns.filter((t) => t.scope === 'primary');
const relevance = queries.filter((q) => q.kind === 'relevance');
const empty = queries.filter((q) => q.kind === 'empty');

// 这个探针的三个池只在 primary scope 上定义。一条 relevance/empty query 跑到
// other scope 去，会让池大小与文档写死的 38/130/898 不符而无人察觉。
for (const q of [...relevance, ...empty]) {
  if (q.scope !== 'primary') {
    console.error(`[probe] ${q.id}: scope=${q.scope}，本探针的池口径只覆盖 primary`);
    process.exit(2);
  }
}

const encoder = await loadEncoder(encoderSpec);

console.log(
  `[probe] 嵌入 ${primaryTurns.length} 条 primary 记录 + ${relevance.length + empty.length} 条 query` +
    `（${encoderSpec.label} / ${encoder.dimensions}d）…`,
);

const recordVec = new Map<string, Float32Array>();
for (const t of primaryTurns) {
  recordVec.set(t.id, await encoder.embedDocument(annotationSearchText(t.annotation)));
}

const queryVec = new Map<string, Float32Array>();
for (const q of [...relevance, ...empty]) queryVec.set(q.id, await encoder.embedQuery(q.query));

// ---------------------------------------------------------------------------
// 三个池
// ---------------------------------------------------------------------------

interface Pair {
  queryId: string;
  recordId: string;
  score: number;
}

const positives: Pair[] = [];
const unlabeled: Pair[] = [];
for (const q of relevance) {
  const expected = new Set(q.expect);
  for (const t of primaryTurns) {
    const pair: Pair = {
      queryId: q.id,
      recordId: t.id,
      score: cosineSimilarity(queryVec.get(q.id)!, recordVec.get(t.id)!),
    };
    (expected.has(t.id) ? positives : unlabeled).push(pair);
  }
  // 标注里写了 expected 但不在 primary 池里 —— 池口径与标注不一致，必须炸出来。
  const found = q.expect.filter((e) => primaryTurns.some((t) => t.id === e)).length;
  if (found !== q.expect.length) {
    console.error(`[probe] ${q.id}: expect 里有不在 primary 池中的记录`);
    process.exit(2);
  }
}

const trueNegatives: Pair[] = [];
for (const q of empty) {
  for (const t of primaryTurns) {
    trueNegatives.push({
      queryId: q.id,
      recordId: t.id,
      score: cosineSimilarity(queryVec.get(q.id)!, recordVec.get(t.id)!),
    });
  }
}

// 池大小是文档写死的口径，对不上说明数据集变了而文档没跟——直接失败，不要静默。
const EXPECTED_SIZES = { positives: 38, trueNegatives: 130, unlabeled: 898 };
const actualSizes = {
  positives: positives.length,
  trueNegatives: trueNegatives.length,
  unlabeled: unlabeled.length,
};
for (const [k, want] of Object.entries(EXPECTED_SIZES)) {
  const got = actualSizes[k as keyof typeof actualSizes];
  if (got !== want) {
    console.error(
      `[probe] ${k} 池大小 ${got} ≠ 方案 §4.2 写死的 ${want}。` +
        `数据集变了就要同步改方案文档的口径，不能让两边悄悄分叉。`,
    );
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// 分布统计
// ---------------------------------------------------------------------------

const quantile = (xs: number[], p: number): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1));
  return s[idx]!;
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function describe(label: string, pairs: Pair[], caveat: string) {
  const xs = pairs.map((p) => p.score);
  return {
    label,
    caveat,
    pairs: pairs.length,
    min: Math.min(...xs),
    p5: quantile(xs, 0.05),
    median: quantile(xs, 0.5),
    mean: mean(xs),
    p95: quantile(xs, 0.95),
    p99: quantile(xs, 0.99),
    max: Math.max(...xs),
  };
}

const dist = {
  positives: describe('正例（38 对）', positives, '标注支撑'),
  trueNegatives: describe('标注真负例（130 对）', trueNegatives, '标注支撑，候选 floor 以其 p99 为准'),
  unlabeled: describe('未标注非目标对（898 对）', unlabeled, '**有上偏**，仅供观察形状'),
};

/**
 * AUC = P(随机取一个正例对的分数 > 随机取一个真负例对的分数)，平局记 0.5。
 *
 * 这是**唯一**可以跨编码器横向比较的分离度读数：它只依赖两个分布的**相对顺序**，
 * 与该模型把分数压在哪个绝对区间无关。句向量模型的各向异性差别很大——E5 家族的
 * cosine 会全部挤在一个窄高带里——所以"改写对 − 无关对"这类绝对间距在模型之间
 * 不可比，用它排序候选会得出与实际排名相反的结论。
 *
 * 0.5 = 完全无判别力；1.0 = 任何正例都高于任何真负例。
 */
function aucSeparation(pos: Pair[], neg: Pair[]): number {
  const ns = neg.map((p) => p.score).sort((a, b) => a - b);
  let acc = 0;
  for (const p of pos) {
    // 二分找严格小于 / 小于等于的边界，得到 below 与 tie 计数。
    let lo = 0, hi = ns.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (ns[m]! < p.score) lo = m + 1; else hi = m; }
    const below = lo;
    let lo2 = lo; hi = ns.length;
    while (lo2 < hi) { const m = (lo2 + hi) >> 1; if (ns[m]! <= p.score) lo2 = m + 1; else hi = m; }
    const ties = lo2 - below;
    acc += below + 0.5 * ties;
  }
  return acc / (pos.length * neg.length);
}

const auc = {
  vsTrueNeg: aucSeparation(positives, trueNegatives),
  vsUnlabeled: aucSeparation(positives, unlabeled),
};

// ---------------------------------------------------------------------------
// 候选 floor 扫描
// ---------------------------------------------------------------------------
//
// 扫描区间**必须按实测分布自适应**，不能写死。
//
// 第一版写死 0.20–0.70（照着当前编码器的量级取的），对 e5-small 直接产出"零个
// 候选"——它的 cosine 全挤在 0.8+ 的高带里，真负例通过率在 0.70 之前根本不会跌破
// 50%。那不是"这个模型没有可用工作点"，而是尺子量程不对，而且失败是静默的：表格
// 照样生成，只是候选那栏空着。这与 §9 纪律 2「门槛必须是本阶段结构上能改变的
// 指标」是同一类错误，只不过发生在扫描区间上。
//
// 区间取两个分布的联合跨度、步数固定，所以任何标度下都能扫到工作点。

const SCAN_STEPS = 26;
const scanFrom = Math.floor(Math.min(dist.trueNegatives.median, dist.positives.p5) * 100) / 100;
const scanTo = Math.ceil(Math.max(dist.positives.p99, dist.trueNegatives.max) * 100) / 100;
const SCAN_STEP = Math.max(0.005, (scanTo - scanFrom) / SCAN_STEPS);

interface ScanRow {
  t: number;
  positiveRecall: number;
  trueNegRate: number;
  unlabeledRate: number;
}
const scan: ScanRow[] = [];
for (let t = scanFrom; t <= scanTo + 1e-9; t += SCAN_STEP) {
  const th = Number(t.toFixed(3));
  const rate = (pairs: Pair[]) => pairs.filter((p) => p.score > th).length / pairs.length;
  scan.push({
    t: th,
    positiveRecall: rate(positives),
    trueNegRate: rate(trueNegatives),
    unlabeledRate: rate(unlabeled),
  });
}

/**
 * 候选建议。这是一条**写明的启发式**，不是判据：取真负例通过率首次跌破若干档位
 * 的那个 t，附上它此时保住多少正例。选中哪个由跑完整 benchmark 的产品指标决定。
 */
const CANDIDATE_TRUE_NEG_LEVELS = [0.5, 0.25, 0.1, 0.05, 0.01];
const candidates = CANDIDATE_TRUE_NEG_LEVELS.map((level) => {
  const hit = scan.find((r) => r.trueNegRate <= level);
  return hit ? { level, ...hit } : null;
}).filter((x): x is NonNullable<typeof x> => x !== null);
// 同一个 t 可能满足多个档位，去重后才是"3–5 个候选"。
const uniqueCandidates = [...new Map(candidates.map((c) => [c.t, c])).values()];

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

const fmt = (x: number, d = 3) => x.toFixed(d);
const pctStr = (x: number) => `${(x * 100).toFixed(1)}%`;
const lines: string[] = [];
lines.push('# 相似度分布与候选 floor 扫描（方案 §4.2）');
lines.push('');
lines.push('> ⚠️ **本报告不产出结论，只产出候选。** 下面全部是 query-record pair 层面的');
lines.push('> 读数，而 §6.6 验收的是产品行为；中间隔着语义排名 → FTS 排名 → RRF → limit');
lines.push('> → semantic-only 限额，且同一条 empty query 可能有多条记录同时越过 floor。');
lines.push('> pair 通过率 5% 完全可以变成"每条 empty query 平均返回 1.3 条"。最终 floor');
lines.push('> 必须由每个候选各跑一次完整 `bun run bench` 的产品指标决定（§6.2）。');
lines.push('');
lines.push('| 项 | 值 |');
lines.push('| --- | --- |');
lines.push(`| 生成时间 | ${new Date().toISOString()} |`);
lines.push(`| 命令行 | \`bun run benchmark/probe-similarity-dist.ts ${args.join(' ')}\` |`);
lines.push(`| 编码器 | ${encoderSpec.label} |`);
lines.push(`| 模型 | \`${encoderSpec.model}\` |`);
lines.push(`| 实测输出维度 | ${encoder.dimensions} |`);
lines.push(
  `| 前缀协议 | query=${encoderSpec.queryPrefix ? `\`${encoderSpec.queryPrefix}\`` : '无'} / doc=${encoderSpec.docPrefix ? `\`${encoderSpec.docPrefix}\`` : '无'} |`,
);
lines.push(`| 记录池 | primary ${primaryTurns.length} 条 |`);
lines.push(`| query | relevance ${relevance.length} / empty ${empty.length} |`);
lines.push(`| 当前生产 SEMANTIC_FLOOR | 0.2 |`);
lines.push(`| 运行环境 | Bun ${Bun.version} / ${process.platform} ${process.arch} |`);
lines.push('');
lines.push('## 三个池的分布');
lines.push('');
lines.push('统计量用 p95/p99，不用 max：max 在 n=130 上极不稳定，样本一多只会往上走，');
lines.push('据此校准的 floor 会系统性偏低。max 仍然列出，但只作参考。');
lines.push('');
lines.push('| 池 | 对数 | min | p5 | 中位数 | 均值 | p95 | p99 | max | 举证能力 |');
lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const d of [dist.positives, dist.trueNegatives, dist.unlabeled]) {
  lines.push(
    `| ${d.label} | ${d.pairs} | ${fmt(d.min)} | ${fmt(d.p5)} | ${fmt(d.median)} | ${fmt(d.mean)} | ${fmt(d.p95)} | ${fmt(d.p99)} | ${fmt(d.max)} | ${d.caveat} |`,
  );
}
lines.push('');
lines.push(
  `真负例 p99 与未标注池 p99 的差值 = ${fmt(dist.unlabeled.p99 - dist.trueNegatives.p99)}。` +
    '它本身就是标注不完备程度的一个读数：未标注池里混着真正相关的记录，所以它系统性偏高。',
);
lines.push('');
lines.push('### 分离度');
lines.push('');
lines.push('**AUC 是本报告里唯一可以跨编码器横向比较的读数。** 它 = P(随机正例对 > 随机真负例对)，');
lines.push('平局记 0.5，只依赖两个分布的相对顺序，与该模型把分数压在哪个绝对区间无关。');
lines.push('0.5 = 完全无判别力，1.0 = 任何正例都高于任何真负例。');
lines.push('');
lines.push('下面那张"对照"表里的绝对差值**不可横向比较**：句向量模型的各向异性差别很大，');
lines.push('E5 家族的 cosine 会全部挤在一个窄高带里，绝对间距小并不代表顺序分不开。用绝对');
lines.push('间距排序候选会得出与实际排名相反的结论。');
lines.push('');
lines.push('| 分离度 | 值 |');
lines.push('| --- | --- |');
lines.push(`| **AUC（正例 vs 标注真负例）** | **${fmt(auc.vsTrueNeg)}** |`);
lines.push(`| AUC（正例 vs 未标注非目标对，有上偏） | ${fmt(auc.vsUnlabeled)} |`);
lines.push('');
lines.push('不做"正例 p5 > 真负例 p99"这类二元分离检验——那要求近乎完美分离，真实语料上');
lines.push('的句向量模型基本不可能过，写成判据等于预先把"删门"分支判死（v2 犯过这个错）。');
lines.push('以下只列几个**同一模型内部**可读的对照量。');
lines.push('');
lines.push('| 对照 | 值 |');
lines.push('| --- | --- |');
lines.push(`| 正例中位数 − 真负例中位数 | ${fmt(dist.positives.median - dist.trueNegatives.median)} |`);
lines.push(`| 正例 p5 − 真负例 p99 | ${fmt(dist.positives.p5 - dist.trueNegatives.p99)} |`);
lines.push(`| 正例中位数 − 真负例 p99 | ${fmt(dist.positives.median - dist.trueNegatives.p99)} |`);
lines.push(`| 真负例分布落在正例 [min, max] 区间内的比例 | ${pctStr(trueNegatives.filter((p) => p.score >= dist.positives.min && p.score <= dist.positives.max).length / trueNegatives.length)} |`);
lines.push('');
lines.push('## 候选 floor 扫描');
lines.push('');
lines.push('`positiveRecall@t` = 38 个正例对里 cosine > t 的比例（保住多少真召回）。');
lines.push('`trueNegRate@t` = 130 对标注真负例里 cosine > t 的比例（放进多少确定的噪声）。');
lines.push('`unlabeledRate@t` = 898 对未标注非目标对的同一比例（**有上偏**，仅参考）。');
lines.push('');
lines.push('| t | positiveRecall@t | trueNegRate@t | unlabeledRate@t |');
lines.push('| --- | --- | --- | --- |');
for (const r of scan) {
  lines.push(`| ${r.t.toFixed(3)} | ${pctStr(r.positiveRecall)} | ${pctStr(r.trueNegRate)} | ${pctStr(r.unlabeledRate)} |`);
}
lines.push('');
lines.push('### 候选（启发式，不是判据）');
lines.push('');
lines.push('规则写明：取真负例通过率**首次**跌破各档位的那个 t。选中哪个由完整 benchmark');
lines.push('的产品指标决定，不由这张表决定。');
lines.push('');
lines.push('| 档位（trueNegRate ≤） | 候选 t | positiveRecall@t | trueNegRate@t | unlabeledRate@t |');
lines.push('| --- | --- | --- | --- | --- |');
for (const c of uniqueCandidates) {
  lines.push(
    `| ${pctStr(c.level)} | **${c.t.toFixed(3)}** | ${pctStr(c.positiveRecall)} | ${pctStr(c.trueNegRate)} | ${pctStr(c.unlabeledRate)} |`,
  );
}
lines.push('');
lines.push('## 历史对照');
lines.push('');
lines.push('旧口径（小样本取 max）：正例 0.080–0.607、噪声 max 0.431。保留作对照，');
lines.push('**不再用于任何决策**——`SEMANTIC_FLOOR = 0.2` 就是这么来的。');
lines.push('');

mkdirSync(join(import.meta.dir, 'reports'), { recursive: true });
writeFileSync(reportPath, lines.join('\n'), 'utf-8');

if (jsonPath) {
  writeFileSync(
    jsonPath,
    JSON.stringify(
      { encoder: encoderSpec, dimensions: encoder.dimensions, sizes: actualSizes, auc, dist, scan, candidates: uniqueCandidates },
      null,
      2,
    ),
    'utf-8',
  );
}

console.log('');
console.log(`  ${encoderSpec.label}  dims=${encoder.dimensions}  **AUC(正例 vs 真负例)=${fmt(auc.vsTrueNeg)}**`);
for (const d of [dist.positives, dist.trueNegatives, dist.unlabeled]) {
  console.log(
    `  ${d.label.padEnd(24)} n=${String(d.pairs).padStart(3)}  ` +
      `median=${fmt(d.median)}  p95=${fmt(d.p95)}  p99=${fmt(d.p99)}  max=${fmt(d.max)}`,
  );
}
console.log('');
console.log('  候选 floor（启发式）：');
for (const c of uniqueCandidates) {
  console.log(
    `    t=${c.t.toFixed(3)}  正例召回=${pctStr(c.positiveRecall)}  ` +
      `真负例通过=${pctStr(c.trueNegRate)}  未标注通过=${pctStr(c.unlabeledRate)}`,
  );
}
console.log('');
console.log(`[probe] 报告已写入 ${reportPath}`);
