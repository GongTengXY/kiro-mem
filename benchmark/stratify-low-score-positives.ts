/**
 * P2 第 4 步第 5 阶段：**低分正例分层**（判据 §7.2）。
 *
 * 判据要求 ≥8 条 relevance query 的「query → 自己 `primary_gold` 的最高余弦」落在
 * `[0.200, 0.310)`，并按四档分层报告：
 *
 *   [<0.200) / [0.200,0.310) / [0.310,0.400) / [>=0.400)
 *
 * ## 这个脚本为什么不可能删东西
 *
 * 判据 §7.2 的程序是「只允许补写、不允许删除」。这里把它做成结构性保证而不是纪律：
 * 本脚本**只读** query 文件，只写报告。它没有任何写回 query 集的代码路径，
 * 所以"看到分数不好就删掉那条 query"这件事在这里做不到。
 *
 * 补写由人做，做完再跑一次本脚本，报告里会多出一轮记录（`rounds`）。
 * 每一轮的总数必须单调不减——脚本会检查上一轮报告，减少即硬失败。
 *
 * ## 为什么这项测量是合法的
 *
 * 被量的是「query 与它**自己**的 gold」的成对属性，用来控制**难度**；gold 早在撰写时
 * 按判据 §3 的事实规则定好了，本脚本不改任何标注。只增不删意味着这项测量只能让集合
 * 更难，无法抬高 hit@5，也无法把系统答不好的 query 藏起来——那才是 §8.4 要防的事。
 *
 * 用法：bun run benchmark/stratify-low-score-positives.ts
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

import { annotationToResult, DATASET_DIR } from './dataset';
import type { Annotation } from './dataset';
import { semanticEnSearchTextFields, type SemanticEnRecord } from '../src/semantic-en';
import { generateEmbedding, buildObservationSearchText, DIMENSIONS } from '../src/embedding';

const read = (p: string): any => JSON.parse(readFileSync(p, 'utf-8'));
const die = (m: string): never => { console.error(`[strat] ✗ ${m}`); process.exit(1); };
const r3 = (x: number): number => Number(x.toFixed(3));

const OUT_DIR = join(import.meta.dir, 'reports', 'safety-round');
const OUT = join(OUT_DIR, 'p2-low-score-positive-strata.json');
const freeze = read(join(OUT_DIR, 'p2-calibration-freeze.json'));

const QUERIES = join(DATASET_DIR, 'queries-safety-round.json');
const RECORDS = join(DATASET_DIR, 'turns-safety-round.json');
const REC_EN = join(DATASET_DIR, 'mirror-en-acp-records-safety-round.json');

if (createHash('sha256').update(readFileSync(freeze.criteria)).digest('hex') !== freeze.criteriaSha256) {
  die('判据已被改动，冻结失效');
}

/** 判据 §7.2 写死的四档。上界 0.310 取自实测：盲审 26 条正例的最低分是 0.308。 */
const BANDS = [
  { key: '<0.200', lo: -Infinity, hi: 0.2 },
  { key: '0.200-0.310', lo: 0.2, hi: 0.31 },
  { key: '0.310-0.400', lo: 0.31, hi: 0.4 },
  { key: '>=0.400', lo: 0.4, hi: Infinity },
] as const;
const TARGET_BAND = '0.200-0.310';
const TARGET_MIN = 8;

// --- 向量 -------------------------------------------------------------------
const records = (read(RECORDS) as { records: { id: string; annotation: Annotation }[] }).records;
const recEn = read(REC_EN).records as Record<string, SemanticEnRecord>;
const queries = (read(QUERIES) as {
  queries: { id: string; kind: string; query: string; semantic_query_en: string | null; primary_gold?: string[] }[];
}).queries;

const dot = (a: Float32Array, b: Float32Array): number => {
  let s = 0;
  for (let i = 0; i < DIMENSIONS; i++) s += a[i]! * b[i]!;
  return s;
};

const recVec = new Map<string, Float32Array>();
for (const r of records) {
  const en = recEn[r.id] ?? die(`记录缺英文派生值：${r.id}`);
  recVec.set(
    r.id,
    await generateEmbedding(
      buildObservationSearchText(semanticEnSearchTextFields(en, annotationToResult(r.annotation).files_touched)),
    ),
  );
}

const rel = queries.filter((q) => q.kind === 'relevance');
const rows: { id: string; band: string; cosine: number; primaryGold: string[] }[] = [];
for (const q of rel) {
  if (!q.semantic_query_en) die(`${q.id} 缺 semantic_query_en——先跑 probe-acp-translate`);
  const qv = await generateEmbedding(q.semantic_query_en!);
  const best = Math.max(...q.primary_gold!.map((g) => dot(qv, recVec.get(g) ?? die(`${q.id} 的 primary_gold ${g} 不在记录集里`))));
  rows.push({
    id: q.id,
    band: BANDS.find((b) => best >= b.lo && best < b.hi)!.key,
    cosine: r3(best),
    primaryGold: q.primary_gold!,
  });
}

const counts = Object.fromEntries(BANDS.map((b) => [b.key, rows.filter((r) => r.band === b.key).length]));
const sorted = [...rows].sort((a, b) => a.cosine - b.cosine);

// --- 只增不删的机械校验 -----------------------------------------------------
const prev = existsSync(OUT) ? read(OUT) : null;
const rounds = prev ? [...prev.rounds] : [];
const roundNo = rounds.length + 1;
const prevIds: string[] = prev ? prev.rounds.flatMap((r: any) => r.queryIds) : [];
const dropped = prevIds.filter((id) => !rows.some((r) => r.id === id));
if (dropped.length) {
  die(`判据 §7.2 禁止删除：上一轮存在但本轮消失的 query ${dropped.join(', ')}`);
}
if (prev && rows.length < prev.totalRelevance) {
  die(`relevance 总数下降 ${prev.totalRelevance} → ${rows.length}，违反只增不删`);
}
rounds.push({
  round: roundNo,
  at: new Date().toISOString(),
  addedIds: rows.filter((r) => !prevIds.includes(r.id)).map((r) => r.id),
  queryIds: rows.map((r) => r.id),
  counts,
});

const met = counts[TARGET_BAND]! >= TARGET_MIN;
const out = {
  step: 'P2 第 4 步第 5 阶段：低分正例分层',
  criteria: { path: freeze.criteria, sha256: freeze.criteriaSha256, section: '§7.2' },
  procedure: {
    rule: '只允许补写、不允许删除',
    structuralGuarantee: '本脚本只读 query 文件、只写报告，没有任何写回 query 集的代码路径；并逐轮校验上一轮的 query 一个都没消失。',
    measured: 'query → 自己 primary_gold 的最高余弦（成对属性，用于难度分层，不是相关性判断）',
    forbidden: ['因得分太高或太低删除 query', '因余弦更改 primary_gold / acceptable_gold', '依据检索返回页面增删 query'],
  },
  totalRelevance: rows.length,
  counts,
  target: { band: TARGET_BAND, min: TARGET_MIN, actual: counts[TARGET_BAND], met },
  distribution: { min: sorted[0]!.cosine, p50: sorted[Math.floor(sorted.length / 2)]!.cosine, max: sorted.at(-1)!.cosine },
  rounds,
  perQuery: sorted,
};
writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n', 'utf-8');

console.log(`[strat] 第 ${roundNo} 轮，relevance ${rows.length} 条`);
for (const b of BANDS) console.log(`   ${b.key.padEnd(12)} ${counts[b.key]}`);
console.log(`[strat] 余弦 min ${out.distribution.min} / p50 ${out.distribution.p50} / max ${out.distribution.max}`);
console.log(met
  ? `[strat] ✓ 目标档 ${TARGET_BAND} 有 ${counts[TARGET_BAND]} 条（下限 ${TARGET_MIN}）`
  : `[strat] ✗ 目标档 ${TARGET_BAND} 只有 ${counts[TARGET_BAND]} 条，还差 ${TARGET_MIN - counts[TARGET_BAND]!} 条——按判据 §7.2 继续**补写**更间接的问法，不得删除任何已有 query`);
console.log(`[strat] 写入 ${OUT}`);
