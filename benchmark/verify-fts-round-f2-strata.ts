#!/usr/bin/env bun
/**
 * FTS 安全策略轮次 **F2 四档分层的冻结后复现**（Codex F2 验收第 4 项）。
 *
 * ## 为什么需要它
 *
 * `f2-strata-r2.json` 是**冻结前**测的（裁定要求四档在冻结前重测，因此那次运行
 * 必须带 `--pre-freeze` 跳过冻结校验）。它的 runner 注释承诺"冻结之后 F2 必须再跑一次
 * （带校验），两次结果不一致则整轮作废"，但 `freeze-fts-round-f2.ts` 只检查了
 * `strata.pass`，那句承诺没有任何机械落点。本脚本就是那个落点。
 *
 * ## 判定（任一失败即非零退出）
 *
 *  1. `f1-freeze-r3.json` 冻结校验通过——分层的输入定义必须是冻结过的那一份；
 *  2. 逐条复现 80 条正例的 `band`：与预冻结报告**逐条相同**，允许的差异是 0 条；
 *  3. 逐条复现余弦：重算值与预冻结报告的三位小数值之差 **≤ 5e-4**（即舍入前同值）。
 *     只比对舍入后的三位小数会让 1e-3 量级的漂移隐身，所以两个口径都判。
 *     `5e-4` 是三位小数舍入的半个最后一位：等号处属舍入残差，真实漂移会先在三位小数上不等
 *     （实测最大 |Δ| = 0.000497，正是舍入上界，写成严格小于会让边界值假失败）。
 *  4. 三套四档条数（并集 / relevance / 保护线）与冻结记录 `payload.strata` 逐项相同。
 *
 * **不覆盖预冻结报告**：输出走独立路径 `f2-strata-verify-r3.json`，
 * 让"冻结前测的"与"冻结后复现的"两份读数并存可比。
 *
 * 复现用的是与预冻结 runner **同一条计算路径**（同一编码器、同一英文形解析、
 * 同一档位边界）。这既是它能逐条对上的原因，也是它的边界：它自证的是
 * "冻结后的装置定义能复算出同一批分层"，不是"分层键选得对"。
 *
 * 用法：bun run benchmark/verify-fts-round-f2-strata.ts
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { verifyFreezeRecordFile } from './freeze-util';
import {
  SEMANTIC_EN_PROTOCOL, embeddingSpaceKey, semanticEnSearchTextFields, type SemanticEnRecord,
} from '../src/semantic-en';
import { generateEmbedding, buildObservationSearchText, DIMENSIONS } from '../src/embedding';
import { annotationToResult, type Annotation } from './dataset';

const DATASET = join(import.meta.dir, 'dataset');
const REPORTS = join(import.meta.dir, 'reports', 'fts-round');
const read = (p: string): any => JSON.parse(readFileSync(p, 'utf-8'));
const arg = (n: string): string | undefined => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const r3 = (x: number): number => Number(x.toFixed(3));
const die = (m: string): never => { console.error(`[strata-verify] ✗ ${m}`); process.exit(1); };

/** 数据后缀（query / 镜像 / 预冻结报告都用它）；冻结记录后缀单独给，两者不同名。 */
const DATA_SUFFIX = arg('data-suffix') ?? '-r2';
const FREEZE_SUFFIX = arg('freeze-suffix') ?? '-r3';
const OUT = join(REPORTS, `f2-strata-verify${FREEZE_SUFFIX}.json`);
/** 舍入前同值的判定阈值：报告存三位小数，半个最后一位 = 5e-4，含边界。 */
const COSINE_EPS = 5e-4;

// --- 1. 冻结校验（本脚本的存在理由就是这一步不得跳过）-------------------------
const freezePath = join(REPORTS, `f1-freeze${FREEZE_SUFFIX}.json`);
const v = verifyFreezeRecordFile(freezePath);
console.log(`[strata-verify] 冻结校验 ${freezePath.replace(`${join(import.meta.dir, '..')}/`, '')}：${v.label} → ${v.ok ? '✓' : '✗'}`);
if (!v.ok) {
  for (const f of v.failures) console.error(`  - ${f.name} (${f.path}) expected=${f.expected.slice(0, 12)} actual=${(f.actual ?? 'null').slice(0, 12)}`);
  die('冻结物已漂移，复现无意义');
}
const freeze = read(freezePath);

// --- 2. 输入 ------------------------------------------------------------------
interface Q { id: string; kind: string; cohort: string; protection_class?: string; query: string; primary_gold?: string[] }
const queries = read(join(DATASET, `queries-fts-round${DATA_SUFFIX}.json`)).queries as Q[];
const records = read(join(DATASET, 'turns-fts-round.json')).records as { id: string; annotation: Annotation }[];
const queryMirror = read(join(DATASET, `mirror-en-acp-queries-fts-round${DATA_SUFFIX}.json`)).queries as Record<string, string>;
const recordMirror = read(join(DATASET, 'mirror-en-acp-records-fts-round.json')).records as Record<string, SemanticEnRecord>;
const preFreeze = read(join(REPORTS, `f2-strata${DATA_SUFFIX}.json`));

const positives = queries.filter((q) => q.cohort === 'new-relevance' || q.cohort === 'protection');
if (positives.length !== 80) die(`正例应为 80 条，实际 ${positives.length}`);

// --- 3. 重算（与预冻结 runner 同一条路径）--------------------------------------
const spaceKey = embeddingSpaceKey(SEMANTIC_EN_PROTOCOL);
const recVec = new Map<string, Float32Array>();
for (const rec of records) {
  const en = recordMirror[rec.id] ?? die(`记录缺英文镜像：${rec.id}`);
  const files = annotationToResult(rec.annotation).files_touched;
  recVec.set(rec.id, await generateEmbedding(buildObservationSearchText(semanticEnSearchTextFields(en, files))));
}
const dot = (a: Float32Array, b: Float32Array): number => {
  let s = 0;
  for (let i = 0; i < DIMENSIONS; i++) s += a[i]! * b[i]!;
  return s;
};

const BANDS = [
  { key: '<0.200', lo: -Infinity, hi: 0.2 },
  { key: '0.200-0.310', lo: 0.2, hi: 0.31 },
  { key: '0.310-0.400', lo: 0.31, hi: 0.4 },
  { key: '>=0.400', lo: 0.4, hi: Infinity },
] as const;
type BandKey = (typeof BANDS)[number]['key'];

const preById = new Map<string, { id: string; cosine: number; band: BandKey; en: string; identityEn: boolean }>(
  (preFreeze.rows as any[]).map((r) => [r.id, r]),
);

interface VerifyRow {
  id: string; cohort: string; protectionClass?: string;
  identityEn: boolean; en: string;
  cosine: number; band: BandKey;
  preCosine: number; preBand: BandKey;
  cosineDelta: number; bandMatch: boolean; enMatch: boolean; cosineMatch: boolean;
}
const rows: VerifyRow[] = [];
for (const q of positives) {
  const identityEn = !/[\u4e00-\u9fff]/.test(q.query);
  const en = queryMirror[q.id] ?? (identityEn ? q.query : die(`query 缺英文镜像：${q.id}`));
  const qv = await generateEmbedding(en);
  const best = Math.max(...(q.primary_gold ?? []).map((g) => dot(qv, recVec.get(g) ?? die(`${q.id} 的 primary_gold ${g} 不在记录集里`))));
  const band = BANDS.find((b) => best >= b.lo && best < b.hi)!.key;
  const pre = preById.get(q.id) ?? die(`预冻结报告里没有 ${q.id}`);
  const delta = Math.abs(best - pre.cosine);
  rows.push({
    id: q.id, cohort: q.cohort, ...(q.protection_class ? { protectionClass: q.protection_class } : {}),
    identityEn, en, cosine: r3(best), band,
    preCosine: pre.cosine, preBand: pre.band,
    cosineDelta: Number(delta.toFixed(6)),
    bandMatch: band === pre.band,
    enMatch: en === pre.en,
    // 两个口径同时判：三位小数相等，且舍入前的差在半个最后一位以内（含边界，见文件头第 3 条）。
    cosineMatch: r3(best) === pre.cosine && delta <= COSINE_EPS,
  });
}

// --- 4. 判定 ------------------------------------------------------------------
const countBy = (subset: VerifyRow[]): Record<BandKey, number> =>
  Object.fromEntries(BANDS.map((b) => [b.key, subset.filter((r) => r.band === b.key).length])) as Record<BandKey, number>;
const counts = {
  union: countBy(rows),
  relevance: countBy(rows.filter((r) => r.cohort === 'new-relevance')),
  protection: countBy(rows.filter((r) => r.cohort === 'protection')),
};

const frozenStrata = freeze.payload.strata as { union: Record<string, number>; relevance: Record<string, number>; protection: Record<string, number> };
const countMismatches: string[] = [];
for (const set of ['union', 'relevance', 'protection'] as const) {
  for (const b of BANDS) {
    const got = counts[set][b.key];
    const want = frozenStrata[set][b.key];
    if (got !== want) countMismatches.push(`${set}.${b.key}: 复现 ${got} vs 冻结 ${want}`);
  }
}

const bandMismatches = rows.filter((r) => !r.bandMatch).map((r) => `${r.id}: ${r.preBand} → ${r.band}`);
const cosineMismatches = rows.filter((r) => !r.cosineMatch).map((r) => `${r.id}: 预冻结 ${r.preCosine} vs 复现 ${r.cosine}（Δ=${r.cosineDelta}）`);
const enMismatches = rows.filter((r) => !r.enMatch).map((r) => r.id);
const shortBands = BANDS.filter((b) => counts.union[b.key] < 8).map((b) => `${b.key}=${counts.union[b.key]}`);

const checks = [
  { name: '冻结校验通过', pass: v.ok, detail: v.label },
  { name: '逐条 band 一致', pass: bandMismatches.length === 0, detail: bandMismatches.length ? bandMismatches.slice(0, 6).join('; ') : `80/80 相同` },
  { name: '逐条余弦一致', pass: cosineMismatches.length === 0, detail: cosineMismatches.length ? cosineMismatches.slice(0, 6).join('; ') : `80/80 相同（最大 |Δ| = ${Math.max(...rows.map((r) => r.cosineDelta))}，阈值 ${COSINE_EPS}）` },
  { name: '英文形一致', pass: enMismatches.length === 0, detail: enMismatches.length ? enMismatches.slice(0, 8).join(' ') : '80/80 相同' },
  { name: '三套四档条数与冻结一致', pass: countMismatches.length === 0, detail: countMismatches.length ? countMismatches.join('; ') : '并集 / relevance / 保护线 共 12 项全部相同' },
  { name: '并集每档 ≥ 8', pass: shortBands.length === 0, detail: shortBands.length ? shortBands.join('  ') : BANDS.map((b) => `${b.key}=${counts.union[b.key]}`).join('  ') },
];
const pass = checks.every((c) => c.pass);

// --- 5. 输出（独立路径，不覆盖预冻结报告）-------------------------------------
mkdirSync(REPORTS, { recursive: true });
writeFileSync(OUT, `${JSON.stringify({
  purpose: 'F2 四档分层的**冻结后复现**（Codex F2 验收第 4 项）。预冻结报告 f2-strata-r2.json 不被覆盖。',
  round: freeze.round,
  generatedAt: new Date().toISOString(),
  freeze: { path: freezePath.replace(`${join(import.meta.dir, '..')}/`, ''), verify: v.label, ok: v.ok },
  preFreezeReport: {
    path: `benchmark/reports/fts-round/f2-strata${DATA_SUFFIX}.json`,
    verifyLabelRecorded: preFreeze.freeze?.verify,
    note: '预冻结那次运行按裁定顺序（先重测四档、再新路径冻结）必须跳过冻结校验；本报告是它的冻结后对照。',
  },
  space: { protocol: SEMANTIC_EN_PROTOCOL, spaceKey, dimensions: DIMENSIONS },
  bands: BANDS.map((b) => b.key),
  counts,
  frozenCounts: frozenStrata,
  cosineEps: COSINE_EPS,
  maxAbsDelta: Math.max(...rows.map((r) => r.cosineDelta)),
  identityEnQueries: rows.filter((r) => r.identityEn).length,
  mismatches: { band: bandMismatches, cosine: cosineMismatches, en: enMismatches, counts: countMismatches },
  checks,
  pass,
  boundary: '复现走与预冻结 runner 同一条计算路径，因此它自证的是「冻结后的装置定义能复算出同一批分层」，'
    + '不是「分层键选得对」。后者由判据 §4.4 规定，不由本脚本判定。',
  rows: rows.sort((a, b) => a.cosine - b.cosine),
}, null, 2)}\n`);

console.log(`[strata-verify] 并集 80 条四档：${BANDS.map((b) => `${b.key}=${counts.union[b.key]}`).join('  ')}`);
for (const c of checks) console.log(`  ${c.pass ? '✓' : '✗'} ${c.name.padEnd(24)} ${c.detail}`);
console.log(`[strata-verify] → ${OUT}`);
if (!pass) process.exit(1);
