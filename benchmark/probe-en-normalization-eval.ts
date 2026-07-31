/**
 * 英文归一化候选的正式离线评测。
 *
 * 固定输入来自三次互相独立的 ACP 翻译事件：records、relevance queries、empty
 * queries。候选选择只读 tuned + empty；heldout 只给确认性读数，不参与 floor 候选。
 * 本脚本仍然是纯 cosine / pair 层探针，不替代完整 FTS + RRF 产品验收。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { DATASET_DIR, loadDataset } from './dataset';
import { buildObservationSearchText, cosineSimilarity } from '../src/embedding';
import { loadEncoder, productionSpec } from './encoder';

const args = process.argv.slice(2);
function flag(name: string, fallback?: string): string | undefined {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

interface RecordText {
  title: string;
  summary: string;
  outcome: string;
  learned: string;
  concepts: string[];
}
interface Mirror {
  provenance?: Record<string, unknown>;
  records?: Record<string, RecordText>;
  queries?: Record<string, string>;
}

const recordsPath = resolve(flag('records', join(DATASET_DIR, 'mirror-en-acp-records.json'))!);
const tunedPath = resolve(flag('tuned', join(DATASET_DIR, 'mirror-en-acp-queries.json'))!);
const heldoutPath = resolve(flag('heldout', join(DATASET_DIR, 'mirror-en-acp-queries-heldout.json'))!);
const emptyPath = resolve(flag('empty', join(DATASET_DIR, 'mirror-en-acp-queries-empty.json'))!);
const reportPath = resolve(flag('report', join(import.meta.dir, 'reports', 'phase1a-en-normalization-eval.md'))!);
const jsonPath = resolve(flag('json', join(import.meta.dir, 'reports', 'phase1a-en-normalization-eval.json'))!);

const readMirror = (path: string) => JSON.parse(readFileSync(path, 'utf-8')) as Mirror;
const recordMirror = readMirror(recordsPath);
const tunedMirror = readMirror(tunedPath);
const heldoutMirror = readMirror(heldoutPath);
const emptyMirror = readMirror(emptyPath);
const translatedQueries = {
  ...(tunedMirror.queries ?? {}),
  ...(heldoutMirror.queries ?? {}),
  ...(emptyMirror.queries ?? {}),
};

const { turns, queries } = loadDataset();
const primary = turns.filter((t) => t.scope === 'primary');
const tuned = queries.filter((q) => q.kind === 'relevance' && q.origin === 'tuned');
const heldout = queries.filter((q) => q.kind === 'relevance' && q.origin === 'heldout');
const empty = queries.filter((q) => q.kind === 'empty');

const requireIds = (label: string, ids: string[], source: Record<string, unknown>) => {
  const missing = ids.filter((id) => !(id in source));
  const extra = Object.keys(source).filter((id) => !ids.includes(id));
  if (missing.length || extra.length) {
    throw new Error(`${label} 覆盖不完整：missing=[${missing}] extra=[${extra}]`);
  }
};
requireIds('records', primary.map((t) => t.id), recordMirror.records ?? {});
requireIds('tuned queries', tuned.map((q) => q.id), tunedMirror.queries ?? {});
requireIds('heldout queries', heldout.map((q) => q.id), heldoutMirror.queries ?? {});
requireIds('empty queries', empty.map((q) => q.id), emptyMirror.queries ?? {});

const encoder = await loadEncoder(productionSpec());
const recordVec = new Map<string, Float32Array>();
for (const t of primary) {
  const r = recordMirror.records![t.id]!;
  const text = buildObservationSearchText({ ...r, files: t.annotation.key_files });
  recordVec.set(t.id, await encoder.embedDocument(text));
}

interface RankRow {
  id: string;
  origin: 'tuned' | 'heldout';
  rank: number;
  baselineRank: number;
  reciprocalRank: number;
  expectedScore: number;
}
interface Pair { queryId: string; recordId: string; score: number }
const rankRows: RankRow[] = [];
const positiveByOrigin = { tuned: [] as Pair[], heldout: [] as Pair[] };
const unlabeledByOrigin = { tuned: [] as Pair[], heldout: [] as Pair[] };

const BASELINE_RANKS: Record<'tuned' | 'heldout', Record<string, number>> = {
  // 显式逐 id 抄自 probe-semantic-rank-phase0.md。不能用排序后的名次数组按 query
  // 顺序回填：聚合 MRR 可能仍对，但改善/退化计数会静默错位。
  tuned: {
    q01: 1, q02: 2, q03: 2, q04: 2, q05: 1, q06: 1, q07: 6, q08: 11, q09: 1,
    q10: 15, q11: 1, q12: 16, q13: 3, q14: 17, q15: 1, q16: 1, q17: 25, q18: 5,
  },
  heldout: {
    q25: 1, q26: 1, q27: 1, q28: 1, q29: 10, q30: 8, q31: 13, q32: 14, q33: 24,
    q34: 2, q35: 1, q36: 24, q37: 19, q38: 11, q39: 3, q40: 21, q41: 26, q42: 21,
  },
};

for (const q of [...tuned, ...heldout]) {
  // 这份 1a 探针只对 tuned / heldout 有基线名次可比；validation 是 1b 才有的子集，
  // 它的读数走完整链路（run.ts --validation），不在这里算。
  const origin = q.origin as 'tuned' | 'heldout';
  const qv = await encoder.embedQuery(translatedQueries[q.id]!);
  const scored = primary
    .map((t) => ({ id: t.id, score: cosineSimilarity(qv, recordVec.get(t.id)!) }))
    .sort((a, b) => b.score - a.score);
  const expected = new Set(q.expect);
  const rank = Math.min(...q.expect.map((id) => scored.findIndex((x) => x.id === id) + 1));
  rankRows.push({
    id: q.id, origin, rank, baselineRank: BASELINE_RANKS[origin][q.id]!,
    reciprocalRank: 1 / rank, expectedScore: scored[rank - 1]!.score,
  });
  for (const item of scored) {
    (expected.has(item.id) ? positiveByOrigin[origin] : unlabeledByOrigin[origin]).push({
      queryId: q.id, recordId: item.id, score: item.score,
    });
  }
}

const trueNegatives: Pair[] = [];
for (const q of empty) {
  const qv = await encoder.embedQuery(translatedQueries[q.id]!);
  for (const t of primary) {
    trueNegatives.push({ queryId: q.id, recordId: t.id, score: cosineSimilarity(qv, recordVec.get(t.id)!) });
  }
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const quantile = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]!;
};
const describe = (pairs: Pair[]) => {
  const xs = pairs.map((x) => x.score);
  return { n: xs.length, min: Math.min(...xs), p5: quantile(xs, .05), median: quantile(xs, .5), p95: quantile(xs, .95), p99: quantile(xs, .99), max: Math.max(...xs) };
};
const auc = (pos: Pair[], neg: Pair[]) => {
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p.score > n.score ? 1 : p.score === n.score ? .5 : 0;
  return wins / (pos.length * neg.length);
};
const summarizeRanks = (origin: 'tuned' | 'heldout') => {
  const rows = rankRows.filter((r) => r.origin === origin);
  const ranks = rows.map((r) => r.rank);
  const changes = {
    improved: rows.filter((r) => r.rank < r.baselineRank).length,
    degraded: rows.filter((r) => r.rank > r.baselineRank).length,
    unchanged: rows.filter((r) => r.rank === r.baselineRank).length,
    maxRegression: Math.max(0, ...rows.map((r) => r.rank - r.baselineRank)),
  };
  return {
    queries: rows.length, mrr: mean(rows.map((r) => r.reciprocalRank)),
    medianRank: quantile(ranks, .5), p90Rank: quantile(ranks, .9),
    top5: rows.filter((r) => r.rank <= 5).length, top10: rows.filter((r) => r.rank <= 10).length,
    changes, rows,
  };
};

const tunedDist = describe(positiveByOrigin.tuned);
const heldoutDist = describe(positiveByOrigin.heldout);
const negDist = describe(trueNegatives);
const scanFrom = Math.floor(Math.min(tunedDist.p5, negDist.median) * 100) / 100;
const scanTo = Math.ceil(Math.max(tunedDist.p99, negDist.max) * 100) / 100;
const step = Math.max(.005, (scanTo - scanFrom) / 26);
const scan: { t: number; positiveRecall: number; trueNegRate: number; unlabeledRate: number }[] = [];
for (let value = scanFrom; value <= scanTo + 1e-9; value += step) {
  const t = Number(value.toFixed(3));
  const rate = (pairs: Pair[]) => pairs.filter((p) => p.score > t).length / pairs.length;
  scan.push({ t, positiveRecall: rate(positiveByOrigin.tuned), trueNegRate: rate(trueNegatives), unlabeledRate: rate(unlabeledByOrigin.tuned) });
}
const levels = [.5, .25, .1, .05, .01];
const candidates = [...new Map(levels.map((level) => {
  const row = scan.find((x) => x.trueNegRate <= level);
  return row ? [row.t, { level, ...row }] : null;
}).filter((x): x is [number, { level: number; t: number; positiveRecall: number; trueNegRate: number; unlabeledRate: number }] => x !== null)).values()];

const result = {
  encoder: productionSpec(), dimensions: encoder.dimensions,
  provenance: { records: recordMirror.provenance, tuned: tunedMirror.provenance, heldout: heldoutMirror.provenance, empty: emptyMirror.provenance },
  ranks: { tuned: summarizeRanks('tuned'), heldout: summarizeRanks('heldout') },
  distributions: { tunedPositives: tunedDist, heldoutPositives: heldoutDist, trueNegatives: negDist },
  auc: { tunedVsTrueNegative: auc(positiveByOrigin.tuned, trueNegatives), heldoutVsTrueNegative: auc(positiveByOrigin.heldout, trueNegatives) },
  scan, candidates,
};

const f = (x: number) => x.toFixed(3);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const lines: string[] = [];
lines.push('# 阶段 1a：英文归一化候选正式评测', '');
lines.push('> 当前模型 `all-MiniLM-L6-v2`；记录、query、empty 由互不含对侧文本的 ACP 翻译事件生成。');
lines.push('> tuned + empty 用于候选判断和 floor 生成；heldout 只作确认性验证。离线 pair 读数不替代完整 RRF 产品验收。', '');
lines.push('## 排名', '', '| 子集 | MRR | median | p90 | Top-5 | 改善/退化/不变 | 最大退化 |', '| --- | --- | --- | --- | --- | --- | --- |');
for (const origin of ['tuned', 'heldout'] as const) {
  const r = result.ranks[origin];
  lines.push(`| ${origin} | **${f(r.mrr)}** | ${r.medianRank} | ${r.p90Rank} | ${r.top5}/${r.queries} | ${r.changes.improved}/${r.changes.degraded}/${r.changes.unchanged} | ${r.changes.maxRegression} |`);
}
lines.push('', '### 逐 query', '', '| query | 子集 | 基线 rank | 英文归一化 rank | Δ |', '| --- | --- | --- | --- | --- |');
for (const r of rankRows) lines.push(`| ${r.id} | ${r.origin} | ${r.baselineRank} | ${r.rank} | ${r.baselineRank - r.rank} |`);
lines.push('', '## 分布与候选 floor', '', '| 池 | n | p5 | median | p95 | p99 | max |', '| --- | --- | --- | --- | --- | --- | --- |');
for (const [label, d] of [['tuned 正例', tunedDist], ['heldout 正例（不参与选 floor）', heldoutDist], ['真负例 empty', negDist]] as const) {
  lines.push(`| ${label} | ${d.n} | ${f(d.p5)} | ${f(d.median)} | ${f(d.p95)} | ${f(d.p99)} | ${f(d.max)} |`);
}
lines.push('', `AUC tuned/empty = **${f(result.auc.tunedVsTrueNegative)}**；heldout/empty = ${f(result.auc.heldoutVsTrueNegative)}。`, '');
lines.push('| trueNegRate 档位 | t | tuned 正例保留 | 真负例通过 | 未标注通过 |', '| --- | --- | --- | --- | --- |');
for (const c of candidates) lines.push(`| ≤ ${pct(c.level)} | **${f(c.t)}** | ${pct(c.positiveRecall)} | ${pct(c.trueNegRate)} | ${pct(c.unlabeledRate)} |`);
lines.push('', '这些 t 只是阶段 2 的候选。是否可拆门必须逐个跑完整 benchmark，并同时满足 expected-empty 均值/最坏值与 heldout 指标。', '');

mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, lines.join('\n'), 'utf-8');
writeFileSync(jsonPath, JSON.stringify(result, null, 2), 'utf-8');
console.log(lines.join('\n'));
console.log(`\n[probe] report=${reportPath} json=${jsonPath}`);
